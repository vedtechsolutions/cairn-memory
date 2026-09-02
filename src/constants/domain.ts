// ============================================================================
// Governance, promotion, health, staleness, truth and reminders
// ============================================================================

import { ENV } from './env.js';

// --- Governance -------------------------------------------------------------

export const GOVERNANCE = {
  /** Env flag opting into persisting the full, unredacted shell command line
   *  in the local `governance_tool_events.raw_command` column. Default OFF:
   *  raw commands can contain inline secrets and the DB is a local,
   *  unencrypted file, so the safe default stores only the redacted form plus
   *  a SHA-256 for correlation. The raw column is never synced or exported
   *  regardless of this flag. Set to `1` (or `true`) for local-only forensics. */
  PERSIST_RAW_COMMAND_ENV: ENV.PERSIST_RAW_COMMAND,
} as const;

// --- Promotion --------------------------------------------------------------

export const PROMOTION = {
  MIN_CONFIDENCE: 0.7,
  ALLOWED_KINDS: ['pitfall', 'decision'] as const,
} as const;

// --- Health Metrics ---------------------------------------------------------

export const HEALTH = {
  CONFIDENCE_HIGH_THRESHOLD: 0.7,
  CONFIDENCE_MEDIUM_THRESHOLD: 0.4,
  ZERO_IMPACT_MIN_SURFACES: 5,
} as const;

// --- Stale Memory Detection -------------------------------------------------

export const STALENESS = {
  /** Weaken pitfalls surfaced this many times with zero impact */
  ZERO_IMPACT_THRESHOLD: 5,
  /** Min overlap ratio (0-1) between memory module terms and project terms to be "fresh" */
  FINGERPRINT_MIN_OVERLAP: 0.0, // 0 = any single term match is enough
  /** Max memories to process per staleness sweep (bound latency) */
  MAX_SWEEP_BATCH: 50,
  /** Git diff timeout in ms */
  GIT_DIFF_TIMEOUT_MS: 5_000,
  /** Min confidence floor — don't weaken below this (let natural decay handle the rest) */
  WEAKEN_FLOOR: 0.15,
} as const;

// --- Truth Maintenance: contradiction + supersession + decay ----------------
// Prior-art-grounded (MemStrata / TOKI / HALO / AGM). Detection is STRUCTURAL,
// not similarity-based; effects are non-destructive (retire/flag, never delete);
// decay errs toward LONG half-lives (aggressive decay is the bigger risk).

export const TRUTH = {
  /** Kinds whose factual claims can go stale / be superseded. Pitfalls use the
   *  structural staleness pass; goals use isGoalMemoryStale; these are the
   *  claim-bearing durable kinds. */
  CLAIM_KINDS: ['fact', 'decision'] as readonly string[],

  /** Min shared significant (non-numeric, non-stopword) tokens for two memories
   *  to be "about the same subject" — the topical-relatedness gate. Structural,
   *  deliberately conservative to avoid the same-token/opposite-scope trap. */
  SUBJECT_MIN_SHARED_TOKENS: 2,
  /** Min Jaccard overlap of significant subject tokens (belt-and-suspenders with
   *  the absolute count above). */
  SUBJECT_MIN_JACCARD: 0.5,

  /** Prepositional/scope cues — if the two memories carry DIFFERENT scope objects
   *  after one of these cues, a contradiction is VETOED (different scope, not a
   *  conflict). Guards "use X for A" vs "avoid X for B". */
  SCOPE_CUES: ['for', 'when', 'in', 'on', 'with', 'during', 'under', 'if'] as readonly string[],

  /** Negation cues (direct + indirect). Odd parity across a shared subject =
   *  polarity conflict. */
  NEGATION_CUES: ['not', 'never', 'no', "don't", 'dont', 'avoid', 'without', 'fails', 'cannot', "can't", 'stop', 'refuse'] as readonly string[],

  /** Antonym pairs for polarity-flip detection on a shared subject. */
  ANTONYM_PAIRS: [
    ['enable', 'disable'], ['works', 'broken'], ['works', 'fails'], ['add', 'remove'],
    ['allow', 'deny'], ['include', 'exclude'], ['start', 'stop'], ['open', 'close'],
    ['true', 'false'], ['on', 'off'], ['up', 'down'], ['prefer', 'avoid'],
  ] as ReadonlyArray<readonly [string, string]>,

  /** Half-lives (days) for time-sensitive claim classes. Long by design — HALO's
   *  tuned half-lives were ~80–160d; over-decaying is worse than under-decaying.
   *  A claim is flagged "verify" once age exceeds one half-life. */
  // Long by design — HALO's tuned half-lives were ~80–160d; a 33% flag rate on
  // real facts at shorter values was too noisy, and over-flagging annoys more
  // than under-flagging (a stale-but-true fact flagged late beats a fresh fact
  // flagged "verify" for no reason).
  HALFLIFE_DAYS: {
    /** version/semver strings — decay fastest */
    version: 90,
    /** bare metrics/counts/benchmarks */
    metric: 120,
    /** explicit dates */
    date: 180,
    /** volatile adjectives (currently/now/latest/as of) */
    volatile: 60,
  } as Record<string, number>,

  /** Max candidate rows to scan for a conflict on write (bound write latency). */
  CONFLICT_CANDIDATE_LIMIT: 10,
  /** Max claim-bearing memories to flag per staleness sweep. */
  STALE_FLAG_BATCH: 50,
} as const;

// --- Reminders Config -------------------------------------------------------

export const REMINDERS = {
  MAX_ACTIVE: 20,
  MAX_ACTION_CHARS: 200,
  MAX_TRIGGER_CHARS: 200,
} as const;
