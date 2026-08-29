/**
 * Decay, cleanup, and maintenance operations.
 * Called periodically or on session start.
 */
import type Database from 'better-sqlite3';
import { pruneRollup } from './telemetry-rollup.js';
import { CONFIDENCE, LIMITS, STALENESS, CONSOLIDATION, DECAY, ROLLOUT_TAILER } from '../constants/index.js';
import { now, buildFtsQuery, tokenOverlap } from '../utils/index.js';
import type { ContextFingerprint } from '../utils/fingerprint.js';
import { MemoryRepository, type Memory } from './memory-repository.js';
import { EdgeRepository } from './edge-repository.js';
import { findConsolidationCandidates, mergedConfidence, mergedTags, type EmbeddingSimilarityMap } from '../utils/consolidation.js';
import { bufferToEmbedding, getEmbeddingModelConfig } from '../utils/embeddings.js';
import { cosineSimilarity } from '../utils/similarity.js';
import { GovernanceRepository } from '../governance/repository.js';

// Incremental Ebbinghaus decay lives in decay.ts; re-exported here so existing
// importers (tests, handlers) keep their `from './maintenance.js'` paths.
export { applyConfidenceDecay, expireTtlMemories } from './decay.js';
import { applyConfidenceDecay, expireTtlMemories } from './decay.js';
import { journalTombstonesForIds } from './memory-repository/journal.js';

/** Clean up old compaction snapshots (time-based retention) */
export function cleanupSnapshots(db: Database.Database, _currentSessionId?: string): number {
  const result = db.prepare(`
    DELETE FROM compaction_snapshots
    WHERE captured_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-' || ? || ' hours')
  `).run(LIMITS.SNAPSHOT_RETENTION_HOURS);
  return result.changes;
}

/** Auto-archive active plans where ALL steps are still pending (never started)
 *  and the plan hasn't been updated within PLAN_UNTOUCHED_ARCHIVE_HOURS.
 *  Prevents stale plans from leaking into briefings across sessions. */
export function archiveUntouchedPlans(db: Database.Database): number {
  // Find active plans older than the threshold
  const cutoff = new Date();
  cutoff.setHours(cutoff.getHours() - LIMITS.PLAN_UNTOUCHED_ARCHIVE_HOURS);
  const cutoffIso = cutoff.toISOString();

  const stalePlans = db.prepare(`
    SELECT p.id FROM plans p
    WHERE p.status = 'active'
      AND p.updated_at < ?
      AND NOT EXISTS (
        SELECT 1 FROM plan_steps ps
        WHERE ps.plan_id = p.id AND ps.status != 'pending'
      )
  `).all(cutoffIso) as Array<{ id: string }>;

  if (stalePlans.length === 0) return 0;

  const timestamp = now();
  const updateStmt = db.prepare(
    "UPDATE plans SET status = 'abandoned', updated_at = ? WHERE id = ?"
  );
  for (const plan of stalePlans) {
    updateStmt.run(timestamp, plan.id);
  }
  return stalePlans.length;
}

/** Clean up archived plans older than the retention period */
export function cleanupArchivedPlans(db: Database.Database): number {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - LIMITS.ARCHIVED_PLAN_CLEANUP_DAYS);

  const result = db.prepare(`
    DELETE FROM plans
    WHERE status IN ('completed', 'abandoned')
      AND updated_at < ?
  `).run(cutoff.toISOString());

  return result.changes;
}

/** Delete ordinary memories for a project. Governance policy has its own
 * explicit audited project-cleanup lifecycle. */
export function forgetProject(db: Database.Database, project: string): number {
  // Explicit bulk retraction (journal.ts): log + journal, then delete.
  return db.transaction(() => {
    db.prepare(`
      INSERT INTO memory_tombstones (memory_id, action, project, kind, content, deleted_at)
      SELECT id, 'delete', project, kind, content, datetime('now')
      FROM memories WHERE project = ? AND kind != 'rule'
    `).run(project);
    const ids = (db.prepare("SELECT id FROM memories WHERE project = ? AND kind != 'rule'").all(project) as Array<{ id: string }>).map(r => r.id);
    journalTombstonesForIds(db, ids);
    const result = db.prepare("DELETE FROM memories WHERE project = ? AND kind != 'rule'").run(project);
    return result.changes;
  })();
}

/** Find stale projects (no recall in N days) */
export function findStaleProjects(db: Database.Database): string[] {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - LIMITS.STALE_PROJECT_DAYS);

  const rows = db.prepare(`
    SELECT DISTINCT project FROM memories
    WHERE project IS NOT NULL
      AND invalidated = 0
      AND kind != 'rule'
      AND (last_recalled IS NULL OR last_recalled < ?)
    GROUP BY project
    HAVING MAX(COALESCE(last_recalled, created_at)) < ?
  `).all(cutoff.toISOString(), cutoff.toISOString()) as Array<{ project: string }>;

  return rows.map(r => r.project);
}

/** Clean up old hook telemetry (keep 7 days) */
export function cleanupTelemetry(db: Database.Database): number {
  try {
    const result = db.prepare(`
      DELETE FROM hook_telemetry WHERE created_at < datetime('now', '-7 days')
    `).run();
    // telemetry_rollup outlives the 7-day prune BY DESIGN (the tokens-
    // saved report needs months); it gets its own long retention.
    pruneRollup(db);
    return result.changes;
  } catch {
    return 0; // Table may not exist yet
  }
}

/** Governance evidence has a hard 30-day ceiling and an audited cleanup. */
export function cleanupGovernanceEvidence(
  db: Database.Database,
  options: { evidenceDays?: number; projectDays?: Readonly<Record<string, number>>; nowMs?: number } = {},
): { gateRunsDeleted: number; toolEventsDeleted: number; projectsAudited: number } {
  return new GovernanceRepository(db).cleanupEvidence(options);
}

// --- Stale Memory Detection -------------------------------------------------

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

/** Promote high-frequency co-recall pairs to co_occurred knowledge graph edges.
 *  Only creates edges for pairs recalled together >= CO_RECALL_EDGE_THRESHOLD times. */
function promoteCoRecallToEdges(db: Database.Database, edgeRepo: EdgeRepository): void {
  const rows = db.prepare(`
    SELECT cr.memory_a, cr.memory_b FROM memory_corecall cr
    WHERE cr.co_count >= ?
      AND NOT EXISTS (
        SELECT 1 FROM memory_edges e
        WHERE e.source_id = cr.memory_a AND e.target_id = cr.memory_b AND e.relation = 'co_occurred'
      )
    ORDER BY cr.co_count DESC
    LIMIT ?
  `).all(CONSOLIDATION.CO_RECALL_EDGE_THRESHOLD, CONSOLIDATION.CO_RECALL_PROMOTE_LIMIT) as Array<{ memory_a: string; memory_b: string }>;

  for (const row of rows) {
    edgeRepo.createEdge(row.memory_a, row.memory_b, 'co_occurred');
  }
}

/** Build a map of pre-computed embedding cosine similarities between memory pairs.
 *  Reads embedding BLOBs from the DB (no model needed — works in hook processes).
 *  Only computes similarities for pairs where BOTH memories have ACTIVE-model
 *  embeddings (v26 isolation). Exported for the isolation test suite. */
export function buildEmbeddingSimilarityMap(
  db: Database.Database,
  memories: Memory[],
): EmbeddingSimilarityMap {
  const map: EmbeddingSimilarityMap = new Map();
  if (memories.length < 2) return map;

  // Batch-fetch embeddings for all memory IDs. Model isolation (v26): only
  // active-model vectors are pairwise-comparable — a stale-model row simply
  // has no embedding similarity, same as a missing embedding.
  const ids = memories.map(m => m.id);
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT id, embedding FROM memories
    WHERE id IN (${placeholders}) AND embedding IS NOT NULL AND embedding_model = ?
  `).all(...ids, getEmbeddingModelConfig().key) as Array<{ id: string; embedding: Buffer }>;

  // Convert to Float32Array lookup
  const embeddings = new Map<string, Float32Array>();
  for (const row of rows) {
    try {
      embeddings.set(row.id, bufferToEmbedding(row.embedding));
    } catch { /* malformed embedding — skip */ }
  }

  // Compute cosine similarity for all pairs that have embeddings
  for (let i = 0; i < memories.length; i++) {
    const embA = embeddings.get(memories[i].id);
    if (!embA) continue;
    for (let j = i + 1; j < memories.length; j++) {
      const embB = embeddings.get(memories[j].id);
      if (!embB) continue;
      const key = memories[i].id < memories[j].id
        ? `${memories[i].id}:${memories[j].id}`
        : `${memories[j].id}:${memories[i].id}`;
      map.set(key, cosineSimilarity(embA, embB));
    }
  }

  return map;
}

/** Memory consolidation: cluster similar memories within each kind and merge.
 *  Creates 'refines' edges from cluster members to the merged representative. */
export function runConsolidation(db: Database.Database): { merged: number; clustersFound: number } {
  const repo = new MemoryRepository(db);
  const edgeRepo = new EdgeRepository(db);

  // One transaction per cluster merge (better-sqlite3 uses savepoints when
  // nested, so this is safe if a caller ever wraps runConsolidation itself).
  const applyClusterMerge = db.transaction(
    (repId: string, newConf: number, newTagsJson: string, memberIds: string[]) => {
      db.prepare('UPDATE memories SET confidence = ?, tags = ? WHERE id = ?')
        .run(newConf, newTagsJson, repId);
      for (const memberId of memberIds) {
        db.prepare('UPDATE memories SET invalidated = 1 WHERE id = ?').run(memberId);
        edgeRepo.createEdge(memberId, repId, 'refines');
      }
    },
  );

  let totalMerged = 0;
  let totalClusters = 0;

  // Process each eligible kind separately
  for (const kind of CONSOLIDATION.ELIGIBLE_KINDS) {
    // Get old-enough memories for this kind
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - CONSOLIDATION.MIN_AGE_DAYS);

    const rows = db.prepare(`
      SELECT id FROM memories
      WHERE invalidated = 0
        AND kind = ?
        AND created_at < ?
      ORDER BY confidence DESC
      LIMIT ?
    `).all(kind, cutoff.toISOString(), CONSOLIDATION.MAX_PER_KIND) as Array<{ id: string }>;

    // Batch-convert to Memory objects — one query, not one findById per row
    const memories: Memory[] = repo.findByIds(rows.map(r => r.id));
    if (memories.length < 2) continue;

    // Group by project for within-project consolidation
    const byProject = new Map<string | null, Memory[]>();
    for (const m of memories) {
      const key = m.project;
      const group = byProject.get(key) ?? [];
      group.push(m);
      byProject.set(key, group);
    }

    for (const [, projectMemories] of byProject) {
      if (projectMemories.length < 2) continue;

      // Pre-compute embedding cosine similarities for all pairs that have embeddings
      const embeddingSimilarities = buildEmbeddingSimilarityMap(db, projectMemories);

      const clusters = findConsolidationCandidates(projectMemories, CONSOLIDATION.AFFINITY_THRESHOLD, embeddingSimilarities);
      totalClusters += clusters.length;

      for (const cluster of clusters) {
        const rep = cluster.representative;
        const newConf = mergedConfidence(cluster);
        const newTags = mergedTags(cluster);
        const memberIds = cluster.members.filter(m => m.id !== rep.id).map(m => m.id);

        // Atomic per cluster: a crash between member invalidation and the
        // representative update would otherwise strand invalidated members
        // whose merged confidence/tags were never written.
        applyClusterMerge(rep.id, newConf, JSON.stringify(newTags), memberIds);
        totalMerged += memberIds.length;
      }
    }
  }

  // Promote high-frequency co-recall pairs to co_occurred edges (enriches graph for neighbor recall)
  promoteCoRecallToEdges(db, edgeRepo);

  // Prune old co_occurred edges while we're at it
  edgeRepo.pruneOldCoOccurrences(90);

  return { merged: totalMerged, clustersFound: totalClusters };
}

/** Auto-promote memories that recur across multiple projects.
 *  Criteria: confidence >= 0.7, impact > 0, exists in 2+ projects, age > 60 days. */
export function runAutoPromotion(db: Database.Database): { promoted: number } {

  // Find high-confidence, high-impact, project-scoped memories old enough to promote
  const candidates = db.prepare(`
    SELECT id, content, kind, project, confidence, surface_count, impact_count
    FROM memories
    WHERE invalidated = 0
      AND project IS NOT NULL
      AND kind != 'rule'
      AND confidence >= 0.7
      AND impact_count > 0
      AND julianday('now') - julianday(created_at) > 60
    ORDER BY impact_count DESC, confidence DESC
    LIMIT 20
  `).all() as Array<{
    id: string; content: string; kind: string; project: string;
    confidence: number; surface_count: number; impact_count: number;
  }>;

  let promoted = 0;

  for (const candidate of candidates) {
    if (promoted >= CONSOLIDATION.MAX_AUTO_PROMOTIONS) break;

    // Check for cross-project near-duplicates via FTS
    const ftsQuery = buildFtsQuery(candidate.content);
    if (!ftsQuery) continue;

    let crossProjectRows: Array<{ project: string; content: string }>;
    try {
      crossProjectRows = db.prepare(`
        SELECT DISTINCT m.project, m.content FROM memories m
        JOIN memories_fts fts ON m.rowid = fts.rowid
        WHERE memories_fts MATCH ?
          AND m.invalidated = 0
          AND m.project IS NOT NULL
          AND m.project != ?
          AND m.kind = ?
        LIMIT 5
      `).all(ftsQuery, candidate.project, candidate.kind) as Array<{ project: string; content: string }>;
    } catch { continue; }

    // Verify with token overlap (FTS may have false positives)
    const confirmedProjects = crossProjectRows.filter(
      r => tokenOverlap(candidate.content, r.content) >= 0.4
    );

    if (confirmedProjects.length === 0) continue;

    // Content doesn't reference project-specific paths (simple heuristic)
    if (candidate.content.includes('/src/') || candidate.content.includes('/opt/')) continue;

    // Promote: set project to null (global scope). No marker edge — a
    // self-referential edge pollutes graph-neighbor enrichment, where the
    // promoted memory would surface itself as its own neighbor on every recall.
    db.prepare('UPDATE memories SET project = NULL WHERE id = ?').run(candidate.id);
    promoted++;
  }

  return { promoted };
}

export interface MaintenanceResult {
  decayed: number;
  deleted: number;
  expired: number;
  snapshotsCleaned: number;
  archivedPlansCleaned: number;
  untouchedPlansArchived: number;
  telemetryCleaned: number;
  governanceEvidenceCleaned: number;
  consolidated: number;
  promoted: number;
  /** True when the run was skipped by the rate gate (nothing executed) */
  skipped?: boolean;
}

function getLastMaintenanceMs(db: Database.Database): number | null {
  try {
    const row = db.prepare(
      "SELECT value FROM maintenance_meta WHERE key = 'last_run_at'"
    ).get() as { value: string } | undefined;
    if (!row) return null;
    const ms = Date.parse(row.value);
    return Number.isFinite(ms) ? ms : null;
  } catch {
    return null; // table missing on a pre-v25 DB mid-migration — treat as never run
  }
}

function recordMaintenanceRun(db: Database.Database, nowMs: number): void {
  try {
    db.prepare(`
      INSERT INTO maintenance_meta (key, value) VALUES ('last_run_at', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(new Date(nowMs).toISOString());
  } catch { /* best-effort — a missed record only means one extra sweep */ }
}

/** Run all maintenance tasks. Rate-gated: decay is time-idempotent, so the
 *  gate exists to bound sweep cost (consolidation/promotion scans), not for
 *  correctness. TTL expiration runs BEFORE the gate on every entry — retrieval
 *  paths like tag recall and briefings don't filter expires_at, so a gated
 *  sweep must not leave expired memories surfaceable. `options.force` bypasses
 *  the gate; `options.nowMs` injects a clock for tests. */
export function runMaintenance(
  db: Database.Database,
  currentSessionId?: string,
  options?: { nowMs?: number; force?: boolean },
): MaintenanceResult {
  const nowMs = options?.nowMs ?? Date.now();

  const expired = expireTtlMemories(db, nowMs);
  // Retention is a hard evidence ceiling, so this cheap indexed cleanup runs
  // even when the broader decay/consolidation sweep is rate-gated.
  const governanceCleanup = cleanupGovernanceEvidence(db, { nowMs });

  // Codex hook/tailer dedup markers (parity Slice B): pruned HERE — not in
  // the tailer — because the hook path writes them on every hosting mode
  // (MCP-embedded socket included) while the tailer only runs in the
  // standalone daemon. Runs pre-gate: one row per codex tool call adds up.
  try {
    const markerCutoff = new Date(nowMs - ROLLOUT_TAILER.MARKER_TTL_MS).toISOString();
    db.prepare(
      "DELETE FROM maintenance_meta WHERE key LIKE 'codex_seen:%' AND value < ?",
    ).run(markerCutoff);
  } catch { /* best-effort */ }

  const lastRun = getLastMaintenanceMs(db);
  const minIntervalMs = DECAY.MAINTENANCE_MIN_INTERVAL_HOURS * 3_600_000;
  if (!options?.force && lastRun !== null && nowMs - lastRun < minIntervalMs) {
    return {
      decayed: 0, deleted: 0, expired, snapshotsCleaned: 0,
      archivedPlansCleaned: 0, untouchedPlansArchived: 0, telemetryCleaned: 0,
      governanceEvidenceCleaned:
        governanceCleanup.gateRunsDeleted + governanceCleanup.toolEventsDeleted,
      consolidated: 0, promoted: 0, skipped: true,
    };
  }

  const decay = applyConfidenceDecay(db, nowMs);
  const snapshotsCleaned = cleanupSnapshots(db, currentSessionId);
  const archivedPlansCleaned = cleanupArchivedPlans(db);
  const untouchedPlansArchived = archiveUntouchedPlans(db);
  const telemetryCleaned = cleanupTelemetry(db);
  const consolidation = runConsolidation(db);
  const promotion = runAutoPromotion(db);
  recordMaintenanceRun(db, nowMs);

  return {
    ...decay,
    expired,
    snapshotsCleaned,
    archivedPlansCleaned,
    untouchedPlansArchived,
    telemetryCleaned,
    governanceEvidenceCleaned:
      governanceCleanup.gateRunsDeleted + governanceCleanup.toolEventsDeleted,
    consolidated: consolidation.merged,
    promoted: promotion.promoted,
  };
}
