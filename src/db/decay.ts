/**
 * Continuous confidence decay — incremental Ebbinghaus model.
 *
 * Invariant: decay is a function of wall-clock time only, never of how often
 * it runs. Each application charges exactly the effective age accrued since
 * the previous application:
 *
 *   delta      = effectiveAge(now) − effectiveAge(last_decayed_at)
 *   confidence ×= e^(−delta / S)
 *
 * where effectiveAge(t) = max(0, days(t − reference) − GRACE_PERIOD_DAYS)
 * and reference = last_recalled ?? created_at. Consecutive charges telescope
 * (e^(−a/S) × e^(−b/S) = e^(−(a+b)/S)), so n incremental runs equal one run
 * over the same total interval and session frequency cannot affect outcomes.
 * The pre-v25 model recomputed retention from *total* age and multiplied it
 * into an already-decayed confidence on every fresh session start, compounding
 * decay per invocation until the store collapsed onto the confidence floors.
 *
 * Provenance affects durability through stability, never the per-update
 * factor: S = STABILITY_BY_KIND[kind] × (1 + recall_count ×
 * RECALL_STABILITY_FACTOR) × SOURCE_WEIGHT[source]. A per-update source
 * multiplier ≥ 1 inside a min(1, …) clamp would freeze decay entirely under
 * frequent small increments (each increment rounds up to no-op).
 *
 * A recall moves `reference` forward past last_decayed_at; the previous
 * charge then evaluates to effectiveAge 0 and the memory starts a fresh
 * epoch — spaced repetition falls out of the arithmetic.
 */
import type Database from 'better-sqlite3';
import {
  CONFIDENCE, DECAY, NON_DECAYING_KINDS, STABILITY_BY_KIND, SOURCE_WEIGHT,
} from '../constants/index.js';

const MS_PER_DAY = 86_400_000;
const NON_DECAYING_PLACEHOLDERS = NON_DECAYING_KINDS.map(() => '?').join(',');

export interface DecayResult {
  decayed: number;
  deleted: number;
}

/** TTL expiration — hard-delete memories past their expires_at. Separate from
 *  confidence decay: TTL is data hygiene and must run on EVERY maintenance
 *  entry, before the rate gate — several retrieval paths (tag recall, vector
 *  search, briefings) do not filter expires_at, so a gated sweep would let
 *  expired memories surface for up to the gate interval. expires_at is
 *  ISO-validated at the tool boundary, so lexicographic comparison against an
 *  injected ISO clock is exact. */
export function expireTtlMemories(db: Database.Database, nowMs: number = Date.now()): number {
  const result = db.prepare(`
    DELETE FROM memories
    WHERE expires_at IS NOT NULL AND expires_at < ?
      AND kind NOT IN (${NON_DECAYING_PLACEHOLDERS})
  `).run(new Date(nowMs).toISOString(), ...NON_DECAYING_KINDS);
  return result.changes;
}

/** Days of decay-eligible age at time tMs for a memory whose reference point
 *  (last recall or creation) is refMs. The grace period is subtracted, not
 *  used as a skip-cliff: a memory 8 days old is charged 1 day, not 8. */
export function effectiveAgeDays(tMs: number, refMs: number): number {
  return Math.max(0, (tMs - refMs) / MS_PER_DAY - DECAY.GRACE_PERIOD_DAYS);
}

/** Apply incremental Ebbinghaus decay and floor cleanup. TTL expiration is
 *  deliberately NOT here — see expireTtlMemories, which runMaintenance calls
 *  before its rate gate. `nowMs` is injectable for tests. */
export function applyConfidenceDecay(db: Database.Database, nowMs: number = Date.now()): DecayResult {
  const eligible = db.prepare(`
    SELECT id, kind, confidence, recall_count, source, created_at, last_recalled, last_decayed_at
    FROM memories
    WHERE invalidated = 0
      AND kind != 'task_state'
      AND kind NOT IN (${NON_DECAYING_PLACEHOLDERS})
      AND confidence > ?
  `).all(...NON_DECAYING_KINDS, CONFIDENCE.DELETE_THRESHOLD) as Array<{
    id: string; kind: string; confidence: number; recall_count: number;
    source: string; created_at: string; last_recalled: string | null;
    last_decayed_at: string | null;
  }>;

  const nowIso = new Date(nowMs).toISOString();
  const updateStmt = db.prepare(
    'UPDATE memories SET confidence = ?, last_decayed_at = ? WHERE id = ?'
  );

  let totalDecayed = 0;
  db.transaction(() => {
    for (const mem of eligible) {
      const refMs = new Date(mem.last_recalled ?? mem.created_at).getTime();
      const prevMs = mem.last_decayed_at ? new Date(mem.last_decayed_at).getTime() : refMs;
      const delta = effectiveAgeDays(nowMs, refMs) - effectiveAgeDays(prevMs, refMs);
      // NaN (malformed timestamps) and sub-threshold deltas charge nothing;
      // last_decayed_at is left untouched on skip, so no accrued age is ever
      // dropped — it simply carries forward until it clears MIN_CHARGE_DAYS.
      if (!Number.isFinite(delta) || delta < DECAY.MIN_CHARGE_DAYS) continue;

      const stabilityBase = STABILITY_BY_KIND[mem.kind] ?? DECAY.DEFAULT_STABILITY_DAYS;
      const sourceStability = SOURCE_WEIGHT[mem.source as keyof typeof SOURCE_WEIGHT] ?? 1.0;
      const S = stabilityBase * (1 + mem.recall_count * DECAY.RECALL_STABILITY_FACTOR) * sourceStability;

      const newConf = Math.max(CONFIDENCE.DELETE_THRESHOLD, mem.confidence * Math.exp(-delta / S));
      updateStmt.run(newConf, nowIso, mem.id);
      if (newConf < mem.confidence) totalDecayed++;
    }
  })();

  // Delete: remove memories below threshold (exempt corrections from deletion)
  const deleteResult = db.prepare(`
    DELETE FROM memories
    WHERE invalidated = 0
      AND confidence < ?
      AND kind != 'task_state'
      AND kind != 'correction'
      AND kind NOT IN (${NON_DECAYING_PLACEHOLDERS})
  `).run(CONFIDENCE.DELETE_THRESHOLD, ...NON_DECAYING_KINDS);

  // Also clean up invalidated memories older than 30 days
  const thirtyDaysAgo = new Date(nowMs - 30 * MS_PER_DAY).toISOString();
  db.prepare(`
    DELETE FROM memories
    WHERE invalidated = 1
      AND created_at < ?
      AND kind NOT IN (${NON_DECAYING_PLACEHOLDERS})
  `).run(thirtyDaysAgo, ...NON_DECAYING_KINDS);

  return {
    decayed: totalDecayed,
    deleted: deleteResult.changes,
  };
}
