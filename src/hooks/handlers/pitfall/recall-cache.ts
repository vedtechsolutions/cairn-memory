/**
 * Session-cache-aware recall + tracker state hashing for the pitfall check.
 */
import type { CachedHookContext } from '../../shared/db-client.js';
import type { EditTracker } from '../../shared/edit-tracker.js';
import { multiSignalScore } from '../../../db/memory-repository/scoring.js';
import type { ContextFingerprint } from '../../../utils/fingerprint.js';
import type { Memory } from '../../../db/memory-repository.js';
import { SessionCache } from '../../shared/session-cache.js';
import { isMemoryEligibleForInjection } from '../../../utils/memory-injection.js';

/**
 * Build a cheap, stable hash of the tracker state that affects pitfall-check
 * output. Anything NOT captured here can change without invalidating the cache;
 * anything captured here forces a cache miss. Intentionally excludes
 * tracker.recentlySurfaced to avoid self-invalidating every call.
 *
 * Captured:
 *   - lastEditPath + lastEditTime  (drives rapid re-edit warning A3)
 *   - total session error count    (drives adaptive confidence floor)
 *   - last 3 toolChain entries     (drives recent-failure A1 + loop A2)
 *   - warning turn + spend         (drives the per-turn injection budget)
 */
export function sessionStateHash(tracker: EditTracker): string {
  const errorTotal = Object.values(tracker.sessionErrorCounts).reduce(
    (s, e) => s + (e?.count ?? 0),
    0,
  );
  const chainTail = tracker.toolChain
    .slice(-3)
    .map(e => `${e.tool}:${e.file ?? ''}:${e.success ? 1 : 0}:${e.timestamp}`)
    .join(',');
  // Include A1/A2/A3 cooldown keys so that firing a warning invalidates the
  // cached null from the prior call. The 60 s skip-gate TTL bounds staleness
  // when the cooldown expires without a new warning event.
  const warnKeys = Object.keys(tracker.recentWarningFired ?? {}).sort().join(',');
  const warningBudget = `${tracker.warningBudgetTurnKey ?? ''}:${tracker.warningCountInjectedThisTurn ?? 0}:${tracker.warningTokensInjectedThisTurn ?? 0}`;
  return `${tracker.lastEditPath ?? ''}@${tracker.lastEditTime}|err=${errorTotal}|chain=${chainTail}|warn=${warnKeys}|budget=${warningBudget}`;
}

/**
 * Cached variant of memoryRepo.recallByFingerprint.
 *
 * The underlying recall is an FTS + fingerprint LIKE scan over the full
 * memories table followed by per-candidate scoring — roughly 80–150 ms in
 * real telemetry. Results are deterministic (same query → same candidate IDs
 * from the SQL layer, within the 30 s TTL window), so the candidate IDs are
 * safe to cache. Mutable fields (confidence, surface_count, impact_count,
 * last_recalled, invalidated) are REFETCHED live on every cache hit, and
 * since step 6 the hit path shares ONE contract with a fresh miss:
 * eligibility (incl. options.minConfidence) and the full multiSignalScore
 * are recomputed from live fields — only the FTS candidate scan is cached.
 *
 */
export function cachedRecallByFingerprint(
  client: CachedHookContext,
  queryFp: ContextFingerprint,
  queryText: string,
  options: {
    project: string | null;
    kind: 'pitfall' | 'decision';
    maxResults: number;
    minConfidence: number;
  },
): Array<{ memory: Memory; score: number }> {
  const fpKey = SessionCache.fingerprintKey(queryFp);
  const ftsKey = `${options.kind}|${options.project ?? ''}|${fpKey}|${queryText.slice(0, 160)}|${options.minConfidence.toFixed(2)}|${options.maxResults}`;

  client.cache?.checkDurableGeneration(client.db);

  // Step 6 parity contract (codex fold): both paths share ONE pipeline over
  // the same candidate WINDOW — filter (kind, injection eligibility,
  // options.minConfidence) → live multiSignalScore → sort → slice. The
  // cache stores the WINDOW ids, not the sliced top-k: a top-k-only cache
  // could neither backfill a weakened row with the runner-up a fresh miss
  // would promote, nor reorder on live-field changes. Only the expensive
  // FTS+LIKE scan is frozen for the TTL; everything downstream is live.
  const pipeline = (mems: Array<Memory | null | undefined>): Array<{ memory: Memory; score: number }> => {
    const out: Array<{ memory: Memory; score: number }> = [];
    for (const mem of mems) {
      if (!mem || mem.kind !== options.kind || !isMemoryEligibleForInjection(mem)) continue;
      if (mem.confidence < options.minConfidence) continue;
      out.push({ memory: mem, score: multiSignalScore(mem, queryFp, queryText) });
    }
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, options.maxResults);
  };

  const cachedIds = client.cache?.getFTSCandidates(ftsKey);
  if (cachedIds) {
    return pipeline(cachedIds.map(id => client.memoryRepo.findById(id)));
  }

  // The frozen unit is the RAW bounded SQL scan (pre-scoring, pre-slicing —
  // codex step-6 fold round 2): freezing anything later let live-field
  // promotion from just outside a scored slice diverge hit from miss.
  const candidates = client.memoryRepo.recallByFingerprintCandidates(queryFp, queryText, options);
  if (client.cache) {
    client.cache.setFTSCandidates(ftsKey, candidates.map(m => m.id));
  }
  return pipeline(candidates);
}
