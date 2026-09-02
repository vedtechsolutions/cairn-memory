/**
 * The two scoring families (roadmap W3): distinct FORMS, shared signal
 * primitives (utils/scoring-primitives.ts), documented weight profiles
 * (SCORING_PROFILES / FINGERPRINT.WEIGHTS in constants).
 *
 *   - computeScore     — multiplicative RECALL ranking: a memory must be
 *                        good on every axis to rank (any weak factor
 *                        suppresses the product).
 *   - multiSignalScore — additive SURFACING score: independent evidence
 *                        accumulates (a strong fingerprint match can carry
 *                        a stale memory over the injection threshold).
 *
 * Behavior locked by tests/scoring-characterization.test.ts.
 */
import { SCORING_PROFILES } from '../../constants/index.js';
import { tokenOverlap } from '../../utils/index.js';
import {
  precisionRatio, recencyBucketBoost, recencyBucketNormalized,
} from '../../utils/scoring-primitives.js';
import { type ContextFingerprint, fingerprintOverlap } from '../../utils/fingerprint.js';
import type { Memory } from './types.js';

/** Shared recency primitive re-exported under its historical name — the
 *  implementation lives in utils/scoring-primitives.ts. */
export { recencyBucketBoost as recencyBoost } from '../../utils/scoring-primitives.js';

/**
 * RECALL-path composite score (step 6 rebalance, M1/M8).
 *
 * `bm25Share` is the row's BM25 strength relative to the best lexical match
 * in the SAME candidate set (1 = strongest, ∈(0,1]); callers without an FTS
 * rank (tag/anchor recall) pass nothing and get 1. Jaccard token overlap
 * alone could not separate a distilled answer from a vocabulary-sharing
 * paste (0.143 vs 0.103 on the incident fixture); BM25's term-frequency and
 * length signals do, and the PRODUCT gives relevance enough range
 * (floor 0.05 + gain 1.9) that the confidence/source/recency prior — ~22.5×
 * of range before step 6 — decides ties instead of overruling relevance.
 */
export function computeScore(memory: Memory, query: string, bm25Share: number = 1): number {
  const profile = SCORING_PROFILES.RECALL;
  const sourceWeight = profile.SOURCE_WEIGHTS[memory.source] ?? 1.0;
  const boost = recencyBucketBoost(memory.last_recalled);
  const relevance = tokenOverlap(memory.content, query) * bm25Share;
  const relevanceFactor = profile.RELEVANCE_FLOOR + profile.RELEVANCE_GAIN * relevance;
  return memory.confidence * sourceWeight * boost * relevanceFactor;
}

/** Multi-signal scoring: fingerprint + vector + content + confidence + recency + precision */
export function multiSignalScore(
  memory: Memory,
  queryFp: ContextFingerprint,
  queryText: string,
  vectorScore: number = 0,
): number {
  const profile = SCORING_PROFILES.SURFACING.MULTI_SIGNAL;
  const weights = profile.WEIGHTS;

  // Signal 1: Fingerprint overlap (0-1)
  const fpScore = memory.fingerprint
    ? fingerprintOverlap(memory.fingerprint, queryFp)
    : 0;

  // Signal 2: Content relevance (0-1) — token overlap with query text
  const contentScore = tokenOverlap(memory.content, queryText);

  // Signal 3: Confidence (0-1)
  const confScore = memory.confidence;

  // Signal 4: Recency (0-1) — bucketed boost normalized over its range
  const recencyScore = recencyBucketNormalized(memory.last_recalled);

  // Signal 5: Precision — proven impact ratio (surface/impact effectiveness)
  const precisionScore = precisionRatio(memory.surface_count, memory.impact_count, memory.confidence);

  let score =
    weights.FINGERPRINT * fpScore +
    weights.VECTOR * vectorScore +
    weights.CONTENT * contentScore +
    weights.CONFIDENCE * confScore +
    weights.RECENCY * recencyScore +
    (weights.PRECISION ?? 0) * precisionScore;

  // Lang-mismatch penalty: when both query and memory have known lang dimensions
  // but zero overlap, suppress the score to prevent cross-language false positives
  // (e.g., typescript pitfall surfacing when editing markdown)
  const queryLangs = queryFp.lang ?? [];
  const memLangs = memory.fingerprint?.lang ?? [];
  if (queryLangs.length > 0 && memLangs.length > 0) {
    const hasOverlap = queryLangs.some(l => memLangs.includes(l));
    if (!hasOverlap) {
      score *= profile.LANG_MISMATCH_PENALTY;
    }
  }

  return score;
}
