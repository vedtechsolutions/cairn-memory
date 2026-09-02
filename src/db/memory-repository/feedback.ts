import type Database from 'better-sqlite3';
import { CONFIDENCE } from '../../constants/index.js';
import { journalUpsertForId, isRowSyncBound } from './journal.js';
import { invalidate } from './writes.js';

export function boostConfidence(db: Database.Database, id: string, amount: number): void {
  db.prepare(`
    UPDATE memories SET confidence = MIN(1.0, confidence + ?)
    WHERE id = ? AND invalidated = 0 AND kind != 'rule'
  `).run(amount, id);
}

/** Record that a memory was surfaced (shown to Claude before a tool call) */
export function incrementSurface(db: Database.Database, id: string): void {
  db.prepare(
    "UPDATE memories SET surface_count = surface_count + 1 WHERE id = ? AND invalidated = 0 AND kind != 'rule'"
  ).run(id);
}

/** Record that a surfaced memory led to a successful outcome */
export function incrementImpact(db: Database.Database, id: string): void {
  db.prepare(
    "UPDATE memories SET impact_count = impact_count + 1 WHERE id = ? AND invalidated = 0 AND kind != 'rule'"
  ).run(id);
}

/** Explicit positive feedback: increase trust in an accurate/useful memory.
 *  Confidence is a portable field, so the explicit change journals an
 *  upsert (journal.ts trust-change semantics). */
export function strengthenConfidence(db: Database.Database, id: string): boolean {
  return db.transaction(() => {
    // Pitfalls additionally floor at DELIBERATE: strengthen is an explicit
    // "this proved useful", and 0.55 + 0.10 landed a validated auto pitfall
    // at exactly 0.65 — ON the injection gate, eligible at that instant and
    // gone at the first decay charge (the F4 borderline step 3 rejects).
    // Decisions get the analogous floor (step-6 carry-in): 0.6 + 0.1 landed
    // exactly ON the 0.7 decision surfacing gate — the same F4 borderline.
    const result = db.prepare(`
      UPDATE memories SET confidence = MIN(1.0, CASE
        WHEN kind = 'pitfall' THEN MAX(confidence + ?, ?)
        WHEN kind = 'decision' THEN MAX(confidence + ?, ?)
        ELSE confidence + ?
      END)
      WHERE id = ? AND invalidated = 0 AND kind != 'rule'
    `).run(CONFIDENCE.STRENGTHEN_INCREMENT, CONFIDENCE.DELIBERATE,
      CONFIDENCE.STRENGTHEN_INCREMENT, CONFIDENCE.STRENGTHENED_DECISION_FLOOR,
      CONFIDENCE.STRENGTHEN_INCREMENT, id);
    if (result.changes > 0) journalUpsertForId(db, id);
    return result.changes > 0;
  })();
}

/** Phase 5: recall-precision feedback loop. Walks the session_memories
 *  junction for the given session and applies a gentle strengthen/weaken
 *  pass based on led_to_success. Memories that were recalled AND led to
 *  success get boosted by PRECISION_STRENGTHEN_INCREMENT; memories that
 *  were recalled but did not lead to success are multiplied by
 *  PRECISION_WEAKEN_FACTOR (0.97 default — mild). This is the closed
 *  feedback loop from the North Star plan: recalled-and-used rises,
 *  recalled-and-ignored sinks. Returns the counts for telemetry. */
export function applyPrecisionFeedback(
  db: Database.Database,
  sessionId: string,
  strengthenIncrement: number,
  weakenFactor: number,
): { strengthened: number; weakened: number } {
  const rows = db.prepare(`
    SELECT memory_id, led_to_success
    FROM session_memories
    WHERE session_id = ?
  `).all(sessionId) as Array<{ memory_id: string; led_to_success: number }>;

  let strengthened = 0;
  let weakened = 0;
  const strengthenStmt = db.prepare(`
    UPDATE memories SET confidence = MIN(1.0, confidence + ?)
    WHERE id = ? AND invalidated = 0 AND kind != 'rule'
  `);
  const weakenStmt = db.prepare(`
    UPDATE memories SET confidence = MAX(?, confidence * ?)
    WHERE id = ? AND invalidated = 0 AND kind != 'rule'
  `);
  for (const row of rows) {
    if (row.led_to_success === 1) {
      const r = strengthenStmt.run(strengthenIncrement, row.memory_id);
      if (r.changes > 0) strengthened++;
    } else {
      // Floor at DELETE_THRESHOLD + epsilon so gentle weaken doesn't
      // auto-invalidate on repeated miss — that's what the stronger
      // weakenConfidence() path is for.
      const floor = CONFIDENCE.DELETE_THRESHOLD + 0.01;
      const r = weakenStmt.run(floor, weakenFactor, row.memory_id);
      if (r.changes > 0) weakened++;
    }
  }
  return { strengthened, weakened };
}

/** Negative feedback: decrease trust, auto-invalidate below threshold.
 *  Explicit (default, cairn_weaken): the confidence change journals an
 *  upsert; a terminal weaken is a real retraction and routes through
 *  invalidate() — tombstone log + journal tombstone. Autonomous callers
 *  (error-learning) pass `autonomous`: their churn journals nothing,
 *  and terminal invalidation is barred for sync-bound rows — the row
 *  clamps at low confidence instead (journal.ts trust-change
 *  semantics). */
export function weakenConfidence(
  db: Database.Database,
  id: string,
  opts?: { autonomous?: boolean },
): { weakened: boolean; invalidated: boolean } {
  return db.transaction(() => {
    const mem = db.prepare(
      "SELECT confidence FROM memories WHERE id = ? AND invalidated = 0 AND kind != 'rule'"
    ).get(id) as { confidence: number } | undefined;
    if (!mem) return { weakened: false, invalidated: false };

    const newConf = mem.confidence * CONFIDENCE.WEAKEN_FACTOR;
    if (newConf < CONFIDENCE.DELETE_THRESHOLD) {
      if (opts?.autonomous && isRowSyncBound(db, id)) {
        db.prepare('UPDATE memories SET confidence = ? WHERE id = ?').run(newConf, id);
        return { weakened: true, invalidated: false };
      }
      invalidate(db, id, opts?.autonomous ? { suppressed: true } : undefined);
      return { weakened: true, invalidated: true };
    }
    db.prepare('UPDATE memories SET confidence = ? WHERE id = ?').run(newConf, id);
    if (!opts?.autonomous) journalUpsertForId(db, id);
    return { weakened: true, invalidated: false };
  })();
}
