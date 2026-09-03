/**
 * Stale memory detection: zero-impact pitfalls, fingerprints that no longer
 * overlap the project, references to deleted files, and anchor repair after
 * renames. Split from maintenance.ts (phase 4).
 */
import type Database from 'better-sqlite3';
import { CONFIDENCE, STALENESS } from '../constants/index.js';
import type { ContextFingerprint } from '../utils/fingerprint.js';

/** Phase 1: Weaken pitfalls that have been surfaced many times with zero impact.
 *  These are already suppressed from display (v2.2.0); now auto-weaken so they
 *  fade toward deletion via natural decay. */
export function weakenZeroImpactPitfalls(db: Database.Database): number {
  const rows = db.prepare(`
    SELECT id, confidence FROM memories
    WHERE invalidated = 0
      AND kind = 'pitfall'
      AND surface_count >= ?
      AND impact_count = 0
      AND confidence > ?
    LIMIT ?
  `).all(
    STALENESS.ZERO_IMPACT_THRESHOLD,
    STALENESS.WEAKEN_FLOOR,
    STALENESS.MAX_SWEEP_BATCH,
  ) as Array<{ id: string; confidence: number }>;

  const updateStmt = db.prepare('UPDATE memories SET confidence = ? WHERE id = ?');
  let weakened = 0;
  for (const row of rows) {
    const newConf = Math.max(row.confidence * CONFIDENCE.WEAKEN_FACTOR, STALENESS.WEAKEN_FLOOR);
    if (newConf < row.confidence) {
      updateStmt.run(newConf, row.id);
      weakened++;
    }
  }
  return weakened;
}

/** Phase 2: Detect memories whose fingerprint module terms have zero overlap
 *  with the current project structure. These likely reference deleted modules/files. */
export function weakenStaleFingerprintMemories(
  db: Database.Database,
  project: string,
  currentModuleTerms: Set<string>,
): number {
  if (currentModuleTerms.size === 0) return 0;

  const rows = db.prepare(`
    SELECT id, confidence, fingerprint FROM memories
    WHERE invalidated = 0
      AND project = ?
      AND kind != 'rule'
      AND fingerprint IS NOT NULL
      AND confidence > ?
    LIMIT ?
  `).all(project, STALENESS.WEAKEN_FLOOR, STALENESS.MAX_SWEEP_BATCH) as Array<{
    id: string;
    confidence: number;
    fingerprint: string;
  }>;

  const updateStmt = db.prepare('UPDATE memories SET confidence = ? WHERE id = ?');
  let weakened = 0;

  for (const row of rows) {
    let fp: ContextFingerprint;
    try { fp = JSON.parse(row.fingerprint); } catch { continue; }

    const modules = fp.module ?? [];
    if (modules.length === 0) continue;

    // Check if ANY module term exists in the current project
    const hasOverlap = modules.some(m => currentModuleTerms.has(m.toLowerCase()));
    if (!hasOverlap) {
      const newConf = Math.max(row.confidence * CONFIDENCE.WEAKEN_FACTOR, STALENESS.WEAKEN_FLOOR);
      if (newConf < row.confidence) {
        updateStmt.run(newConf, row.id);
        weakened++;
      }
    }
  }

  return weakened;
}

/** Phase 3: Weaken memories whose content references recently deleted files. */
export function weakenDeletedFileMemories(
  db: Database.Database,
  project: string,
  deletedFiles: string[],
): number {
  if (deletedFiles.length === 0) return 0;

  let weakened = 0;
  const updateStmt = db.prepare('UPDATE memories SET confidence = ? WHERE id = ?');

  for (const filePath of deletedFiles.slice(0, 20)) { // cap at 20 files
    // Extract meaningful search terms from the file path
    const parts = filePath.split('/');
    const fileName = parts[parts.length - 1] ?? '';
    const stem = fileName.replace(/\.[^.]+$/, '');
    if (stem.length < 3) continue; // too short to be meaningful

    // Search memory content for references to this file
    const matches = db.prepare(`
      SELECT m.id, m.confidence FROM memories m
      WHERE m.invalidated = 0
        AND m.project = ?
        AND m.kind != 'rule'
        AND m.confidence > ?
        AND m.rowid IN (
          SELECT rowid FROM memories_fts WHERE memories_fts MATCH ?
        )
      LIMIT 5
    `).all(project, STALENESS.WEAKEN_FLOOR, `"${stem}"`) as Array<{ id: string; confidence: number }>;

    for (const match of matches) {
      const newConf = Math.max(match.confidence * CONFIDENCE.WEAKEN_FACTOR, STALENESS.WEAKEN_FLOOR);
      if (newConf < match.confidence) {
        updateStmt.run(newConf, match.id);
        weakened++;
      }
    }
  }

  return weakened;
}

/** Phase 4: Detect git file renames and update memory anchors accordingly. */
export function updateAnchorsForRenames(
  db: Database.Database,
  project: string,
  renames: Array<{ oldPath: string; newPath: string }>,
): number {
  if (renames.length === 0) return 0;

  let updated = 0;
  const stmt = db.prepare('UPDATE memories SET anchor = ? WHERE id = ?');

  for (const { oldPath, newPath } of renames) {
    const oldBase = oldPath.split('/').pop() ?? oldPath;
    // Find memories with anchors referencing the old path
    const rows = db.prepare(`
      SELECT id, anchor FROM memories
      WHERE invalidated = 0
        AND project = ?
        AND kind != 'rule'
        AND anchor IS NOT NULL
        AND (anchor LIKE ? OR anchor LIKE ?)
      LIMIT 20
    `).all(project, `%${oldBase}%`, `%${oldPath}%`) as Array<{ id: string; anchor: string }>;

    for (const row of rows) {
      try {
        const anchor = JSON.parse(row.anchor);
        if (Array.isArray(anchor.files)) {
          const newFiles = anchor.files.map((f: string) =>
            f === oldPath ? newPath : f.endsWith(oldBase) ? f.replace(oldBase, newPath.split('/').pop() ?? oldBase) : f
          );
          if (JSON.stringify(newFiles) !== JSON.stringify(anchor.files)) {
            anchor.files = newFiles;
            // Silent local repair — journals NOTHING (journal.ts anchor
            // semantics): rename detection is local-git-driven (possibly
            // uncommitted), so pushing it teamwide would be premature; the
            // corrected anchor rides the row's next semantic upsert.
            stmt.run(JSON.stringify(anchor), row.id);
            updated++;
          }
        }
      } catch { /* malformed anchor — skip */ }
    }
  }

  return updated;
}

/** Run all staleness detection phases. Called from session-start on startup. */
export function runStalenessDetection(
  db: Database.Database,
  project: string,
  currentModuleTerms: Set<string>,
  deletedFiles: string[],
): { zeroImpact: number; staleFingerprint: number; deletedFileRefs: number } {
  const zeroImpact = weakenZeroImpactPitfalls(db);
  const staleFingerprint = weakenStaleFingerprintMemories(db, project, currentModuleTerms);
  const deletedFileRefs = weakenDeletedFileMemories(db, project, deletedFiles);
  return { zeroImpact, staleFingerprint, deletedFileRefs };
}
