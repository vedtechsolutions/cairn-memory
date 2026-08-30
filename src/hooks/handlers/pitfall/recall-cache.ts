/**
 * Session-cache-aware recall + tracker state hashing for the pitfall check.
 */
import type { CachedHookContext } from '../../shared/db-client.js';
import type { EditTracker } from '../../shared/edit-tracker.js';
import { fingerprintOverlap } from '../../../utils/fingerprint.js';
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
 * last_recalled, invalidated) are REFETCHED live on every cache hit to
 * preserve SNR — we never serve stale authority state.
 *
 * Fingerprint overlap scores are cached per (memoryId, queryFpKey) because
 * the inputs are immutable once stored. This eliminates the per-candidate
 * JS scoring loop on cache hit.
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
  const cachedIds = client.cache?.getFTSCandidates(ftsKey);
  if (cachedIds) {
    const out: Array<{ memory: Memory; score: number }> = [];
    for (const id of cachedIds) {
      const mem = client.memoryRepo.findById(id);
      if (!mem || mem.kind !== options.kind || !isMemoryEligibleForInjection(mem)) continue;
      // Fingerprint scores are deterministic — cache them per (id, fpKey).
      let score = client.cache?.getFingerprintScore(mem.id, fpKey);
      if (score === undefined) {
        score = mem.fingerprint ? fingerprintOverlap(mem.fingerprint, queryFp) : 0;
        client.cache?.setFingerprintScore(mem.id, fpKey, score);
      }
      out.push({ memory: mem, score });
    }
    // Preserve descending-score ordering from the original recall.
    out.sort((a, b) => b.score - a.score);
    return out;
  }

  const results = client.memoryRepo.recallByFingerprint(queryFp, queryText, options)
    .filter(r => isMemoryEligibleForInjection(r.memory));
  if (client.cache) {
    client.cache.setFTSCandidates(ftsKey, results.map(r => r.memory.id));
    // Warm the per-candidate score cache so the next call short-circuits the
    // fingerprintOverlap computation for these IDs.
    for (const r of results) {
      client.cache.setFingerprintScore(r.memory.id, fpKey, r.score);
    }
  }
  return results;
}
