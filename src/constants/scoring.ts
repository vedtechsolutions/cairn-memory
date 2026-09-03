// ============================================================================
// Confidence, decay, repair and source ranking
// ============================================================================

import {
  SOURCE_AUTHORITY_ORDER as _AUTHORITY_ORDER,
  type MemorySource,
} from 'waykeep-contract';

/** Numeric authority ranking DERIVED from the contract's ordering (higher
 *  wins on dedup merge) — the ordering is the contract; the numbers are an
 *  internal encoding of it, kept in one place so they can never drift. */
export const SOURCE_AUTHORITY: Record<MemorySource, number> = Object.fromEntries(
  _AUTHORITY_ORDER.map((source, i) => [source, _AUTHORITY_ORDER.length - 1 - i]),
) as Record<MemorySource, number>;

// --- Confidence Defaults ----------------------------------------------------

export const CONFIDENCE = {
  LEARNED: 0.65,
  CORRECTION: 0.8,
  USER_CORRECTION: 0.9,
  AUTO_DETECTED: 0.55,
  /** Confidence for a lesson the user or agent EXPLICITLY stored via
   *  waykeep_learn (pitfalls only — other kinds have working defaults).
   *  Strictly above MIN_CONFIDENCE_FOR_PITFALL (0.65): equality passes at
   *  birth and dies at the first decay charge, leaving the row invisible on
   *  every confidence-gated recall/injection surface. At pitfall stability
   *  60d, 0.7 stays eligible ~4.4 decay-charged days AFTER the 7-day grace
   *  period (t = S·ln(0.70/0.65) ≈ 60×0.074 — ≈11.4 wall-clock days from
   *  birth); longer retention is reinforcement's job (impact boosts,
   *  strengthen) — deliberate learning buys a real head start, not
   *  immortality. Aligned with PROMOTION.MIN_CONFIDENCE so a deliberate
   *  lesson is born promotable. Also the floor waykeep_strengthen applies to
   *  pitfalls: explicit validation must never strand a row ON the gate. */
  DELIBERATE: 0.7,
  /** Floor waykeep_strengthen applies to DECISIONS (step-6 carry-in F-A):
   *  0.6 + STRENGTHEN_INCREMENT landed exactly ON the 0.7 decision
   *  surfacing gate (PROACTIVE.MIN_DECISION_CONFIDENCE, >= semantics) —
   *  eligible for an instant, gone at the first decay charge. 0.75 clears
   *  the gate with ~S·ln(0.75/0.70) of unreinforced headroom and stays
   *  below CORRECTION: a strengthened decision never outranks one. */
  STRENGTHENED_DECISION_FLOOR: 0.75,
  BOOST_INCREMENT: 0.05,
  STRENGTHEN_INCREMENT: 0.1,
  /** Ceiling for repetition-driven dedup reinforcement (== CORRECTION, and
   *  pinned to it by test): re-observing the same lesson boosts its row by
   *  BOOST_INCREMENT per merge but can never push it PAST correction
   *  authority — without this, six identical waykeep_learn calls ratcheted a
   *  0.7 pitfall to 1.0, above USER_CORRECTION (review block: repetition is
   *  not authority). A row already above the ceiling keeps its level (no
   *  downgrade, no further repetition growth); only an explicitly
   *  higher-confidence incoming write exceeds it. */
  DEDUP_REINFORCEMENT_CEILING: 0.8,
  WEAKEN_FACTOR: 0.85,
  DELETE_THRESHOLD: 0.1,
  USER_PROFILE: 0.75,
  /** Boost for pitfalls that correctly predicted a tool outcome (stronger than generic boost) */
  PREDICTION_VERIFIED_BOOST: 0.08,
  /** Double impact credit when a surfaced pitfall's warning was ignored and the error occurred */
  DOUBLE_IMPACT_ON_IGNORED_WARNING: true,
  REFERENCE: 0.75,
  CONFIRMED: 0.7,
} as const;

/** Incremental Ebbinghaus decay parameters — see src/db/decay.ts for the model. */
export const DECAY = {
  /** Days after last recall (or creation) before decay starts charging.
   *  Charged age is (age − grace), not a skip-then-charge-everything cliff. */
  GRACE_PERIOD_DAYS: 7,
  /** runMaintenance no-ops within this window unless force: true —
   *  decay is time-idempotent, so this bounds sweep cost, not correctness */
  MAINTENANCE_MIN_INTERVAL_HOURS: 12,
  /** Stability fallback for kinds missing from STABILITY_BY_KIND */
  DEFAULT_STABILITY_DAYS: 30,
  /** Deltas below this (days) are skipped WITHOUT advancing last_decayed_at —
   *  lossless (the charge accrues until it clears the bar) and avoids
   *  rewriting every row to record microscopic decay on frequent runs */
  MIN_CHARGE_DAYS: 0.01,
  /** Age (days) after which a memory that decayed to the confidence floor and
   *  was NEVER recalled is pruned as clearly dead. Decay floors at
   *  DELETE_THRESHOLD, so these never fall under the strict `< threshold`
   *  delete and would otherwise accumulate forever. High-value kinds
   *  (rule/correction/user_profile/decision) are exempt from this prune. */
  PRUNE_DEAD_AGE_DAYS: 60,
} as const;

/** Explicit confidence-repair targets (scripts/repair-confidence.mjs).
 *  The pre-v25 compounding-decay bug crushed stored confidences onto the
 *  decay floors; repair lifts only evidence-backed memories to just above
 *  the retrieval gate that lets them surface again (RELEVANCE
 *  MIN_CONFIDENCE_FOR_PITFALL 0.65 / MIN_CONFIDENCE_FOR_FACT 0.55) —
 *  a lift below the gate would leave them invisible and unable to re-earn
 *  trust. Original values are unrecoverable; this restores surfaceability,
 *  not history. */
export const REPAIR = {
  TARGETS: {
    pitfall: 0.7,
    fact: 0.6,
    decision: 0.6,
    correction: 0.8,
    pattern: 0.6,
    goal: 0.6,
    reference: 0.6,
    user_profile: 0.75,
  } as Record<string, number>,
  DEFAULT_TARGET: 0.6,
  /** Recalled-but-never-impactful memories below this go to the review CSV */
  REVIEW_MAX_CONFIDENCE: 0.5,
} as const;

/** Ebbinghaus-inspired stability constants (days) — higher = slower decay.
 *  Used by continuous decay: R = e^(-t/S) where
 *  S = base * SOURCE_WEIGHT[source] — recall_count deliberately absent (step 7 / M5:
 *  exposure is not validation; popularity must not become durability) */
export const STABILITY_BY_KIND: Record<string, number> = {
  pitfall: 60,
  correction: 60,
  decision: 45,
  fact: 30,
  task_state: 15,
  user_profile: 120,
  reference: 120,
  // Phase 3 — patterns: mid-range stability, similar to decisions (45 days)
  pattern: 50,
  // Phase 4 — goals: high stability, they anchor cross-session retrieval
  goal: 90,
} as const;

// --- Source Weights for Ranking ---------------------------------------------

export const SOURCE_WEIGHT: Record<MemorySource, number> = {
  corrected: 1.5,
  user: 1.2,
  confirmed: 1.1,
  learned: 1.0,
} as const;

// --- User model (structured profile entries) --------------------------------

export const USER_MODEL = {
  /** Confidence added per corroborating piece of evidence. */
  CONFIDENCE_BOOST_PER_EVIDENCE: 0.05,
  /** Ceiling — an inferred profile entry is never certain. */
  MAX_CONFIDENCE: 0.95,
  /** Multiplier applied to entries not refreshed within DECAY_MIN_AGE_DAYS. */
  DECAY_FACTOR: 0.9,
  DECAY_MIN_AGE_DAYS: 30,
} as const;
