/**
 * One-time confidence repair for stores crushed by the pre-v25 compounding
 * decay bug (see src/db/decay.ts and docs/plans/2026-07-20-improvement-roadmap.md W0).
 *
 * Deliberately NOT a schema migration: repair is an explicit, operator-driven
 * action with a dry-run default and a backup, because the original confidence
 * values are unrecoverable — repeated multiplicative decay destroyed the
 * information needed to reconstruct them. Repair restores *surfaceability*
 * for memories with outcome evidence; it never claims to restore history.
 *
 * Evidence criteria (any one qualifies):
 *   - impact_count > 0            — surfaced and demonstrably helped
 *   - source IN ('user','corrected') — explicit human provenance
 *   - a session_memories row with led_to_success = 1 — recalled into a
 *     session that ended well
 *
 * Recall count alone is NOT evidence: it records retrieval exposure, not
 * usefulness (live-store check: the recall_count 2–4 cohort had zero positive
 * impacts). Recalled-but-never-impactful memories are exported for human
 * review instead of being lifted.
 */
import type Database from 'better-sqlite3';
import { REPAIR } from '../constants/index.js';

export interface RepairCandidate {
  id: string;
  kind: string;
  project: string | null;
  confidence: number;
  target: number;
  reason: 'impact' | 'provenance' | 'session-success';
  content: string;
}

export interface ReviewCandidate {
  id: string;
  kind: string;
  project: string | null;
  confidence: number;
  recall_count: number;
  content: string;
}

export interface RepairAnalysis {
  candidates: RepairCandidate[];
  review: ReviewCandidate[];
}

/** Read-only analysis: which memories qualify for a lift, and which go to
 *  the human-review export. Mutates nothing. */
export function analyzeRepair(db: Database.Database): RepairAnalysis {
  const rows = db.prepare(`
    SELECT m.id, m.kind, m.project, m.confidence, m.recall_count, m.content,
      m.impact_count, m.source,
      EXISTS (
        SELECT 1 FROM session_memories sm
        WHERE sm.memory_id = m.id AND sm.led_to_success = 1
      ) AS session_success
    FROM memories m
    WHERE m.invalidated = 0
      AND m.superseded_by IS NULL
      AND m.kind != 'task_state'
      AND m.kind != 'rule'
  `).all() as Array<{
    id: string; kind: string; project: string | null; confidence: number;
    recall_count: number; content: string; impact_count: number;
    source: string; session_success: number;
  }>;

  const candidates: RepairCandidate[] = [];
  const review: ReviewCandidate[] = [];

  for (const row of rows) {
    const target = REPAIR.TARGETS[row.kind] ?? REPAIR.DEFAULT_TARGET;
    const reason: RepairCandidate['reason'] | null =
      row.impact_count > 0 ? 'impact'
      : row.source === 'user' || row.source === 'corrected' ? 'provenance'
      : row.session_success === 1 ? 'session-success'
      : null;

    if (reason !== null) {
      if (row.confidence < target) {
        candidates.push({
          id: row.id, kind: row.kind, project: row.project,
          confidence: row.confidence, target, reason, content: row.content,
        });
      }
    } else if (
      row.recall_count > 0 &&
      row.confidence < REPAIR.REVIEW_MAX_CONFIDENCE
    ) {
      review.push({
        id: row.id, kind: row.kind, project: row.project,
        confidence: row.confidence, recall_count: row.recall_count,
        content: row.content,
      });
    }
  }

  return { candidates, review };
}

/** Apply the lifts from an analysis. Sets last_decayed_at = now alongside the
 *  new confidence — otherwise the next decay run would charge the entire
 *  interval since the v25 migration backfill and crush the memory again.
 *
 *  TOCTOU-safe: every condition is re-checked at write time and the lift is
 *  monotone (MAX). A memory concurrently boosted above its target — or
 *  invalidated/superseded — between analysis and execution is left alone. */
export function executeRepair(
  db: Database.Database,
  analysis: RepairAnalysis,
  nowMs: number = Date.now(),
): { repaired: number } {
  const nowIso = new Date(nowMs).toISOString();
  const stmt = db.prepare(`
    UPDATE memories SET confidence = MAX(confidence, ?), last_decayed_at = ?
    WHERE id = ?
      AND invalidated = 0
      AND superseded_by IS NULL
      AND kind != 'rule'
      AND confidence < ?
  `);
  let repaired = 0;
  db.transaction(() => {
    for (const c of analysis.candidates) {
      const result = stmt.run(c.target, nowIso, c.id, c.target);
      if (result.changes > 0) repaired++;
    }
  })();
  return { repaired };
}

/** CSV export of the human-review cohort (recalled but never impactful). */
export function toReviewCsv(review: ReviewCandidate[]): string {
  const esc = (v: string): string => `"${v.replace(/"/g, '""')}"`;
  const header = 'id,kind,project,confidence,recall_count,content';
  const lines = review.map(r =>
    [r.id, r.kind, r.project ?? '', r.confidence.toFixed(3), String(r.recall_count), esc(r.content)].join(',')
  );
  return [header, ...lines].join('\n') + '\n';
}
