/**
 * Shared scoring signal primitives (roadmap W3). One implementation per
 * signal, consumed by BOTH scoring families — the multiplicative recall
 * form (`computeScore`) and the additive surfacing form
 * (`multiSignalScore`) — plus the hook-side tag relevance path, which
 * previously carried its own byte-for-byte copy of the recency buckets.
 *
 * BEHAVIOR-PRESERVING: outputs are locked by
 * tests/scoring-characterization.test.ts; weight TUNING is a separate,
 * benchmark-driven exercise that must consciously edit those goldens.
 */
import { RELEVANCE, SCORING_PROFILES } from '../constants/index.js';
import { daysSince } from './time.js';

/** Bucketed recency boost: ≤7d → 1.2, ≤30d → 1.0, else/never → 0.8.
 *  (Formerly one duplicated implementation — scoring.ts and a
 *  byte-for-byte copy in relevance.ts — consumed by three paths.) */
export function recencyBucketBoost(lastRecalled: string | null): number {
  if (!lastRecalled) return RELEVANCE.RECENCY_BOOST_STALE;
  const days = daysSince(lastRecalled);
  if (days <= 7) return RELEVANCE.RECENCY_BOOST_7_DAYS;
  if (days <= 30) return RELEVANCE.RECENCY_BOOST_30_DAYS;
  return RELEVANCE.RECENCY_BOOST_STALE;
}

/** The surfacing form's 0–1 recency signal: the bucketed boost normalized
 *  over its own range (stale → 0, fresh → 1). */
export function recencyBucketNormalized(lastRecalled: string | null): number {
  const raw = recencyBucketBoost(lastRecalled);
  const normalized = (raw - RELEVANCE.RECENCY_BOOST_STALE)
    / (RELEVANCE.RECENCY_BOOST_7_DAYS - RELEVANCE.RECENCY_BOOST_STALE);
  return Math.max(0, Math.min(1, normalized));
}

/** Proven-impact precision: min(1, impact/surface); memories never
 *  surfaced fall back to a conservative confidence-scaled proxy. */
export function precisionRatio(surfaceCount: number, impactCount: number, confidence: number): number {
  return surfaceCount > 0
    ? Math.min(1.0, impactCount / surfaceCount)
    : confidence * SCORING_PROFILES.SURFACING.MULTI_SIGNAL.UNPROVEN_PRECISION_PROXY;
}
