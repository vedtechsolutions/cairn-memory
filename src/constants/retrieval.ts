// ============================================================================
// Briefing allocation, fingerprinting and scoring profiles
// ============================================================================

import { SOURCE_WEIGHT } from './scoring.js';

// --- Deduplication ----------------------------------------------------------

export const DEDUP = {
  /** Token overlap threshold for dedup — lowered from 0.6 to catch paraphrased duplicates */
  SIMILARITY_THRESHOLD: 0.5,
} as const;

// --- Relevance Scoring ------------------------------------------------------

/** Typed retrieval-path contract (remediation step 5 — embedding lifecycle).
 *  The CHOICE of record: typed degraded status, zero-wait. A recall never
 *  blocks on model readiness — cold-start calls run FTS-only and say so
 *  through EXACTLY these strings (single source; the handler must not mint
 *  its own). The bounded-readiness-barrier alternative was rejected on
 *  design grounds: warmup is asynchronous and unbounded (a cold pipeline
 *  build has no latency guarantee), so no user-acceptable barrier budget
 *  can promise conversion to hybrid, while taxing every cold call by the
 *  full budget; eager warmup at
 *  server/daemon start (server.ts / waykeep-daemon.ts) minimizes the window
 *  instead. Bistability between the two rankings is step 6's remit — this
 *  step guarantees the path is never SILENT. */
export const RETRIEVAL_PATHS = {
  hybrid: {
    header: 'hybrid (fts+vector, rrf)',
    /** minimal mode carries no marker on the healthy path */
    compactMarker: null,
  },
  fts_degraded: {
    header: 'FTS-only — embedding model not ready; ranking may differ from hybrid',
    compactMarker: '[FTS-only]',
  },
} as const;
export type RetrievalPathKind = keyof typeof RETRIEVAL_PATHS;

/** Degradation label for the rerank stage — beside, not inside,
 *  RETRIEVAL_PATHS: reranking is an ordering stage layered on a retrieval
 *  path, and its fallback (RRF order) composes with either path. Single
 *  source for the same no-drift reason. */
export const RERANK_FALLBACK_LABEL = '[rerank unavailable — results in RRF order]';

export const RELEVANCE = {
  INJECTION_THRESHOLD: 0.25,
  MIN_CONFIDENCE_FOR_PITFALL: 0.65,
  MIN_CONFIDENCE_FOR_FACT: 0.55,
  MIN_SCORE_FOR_INJECTION: 0.45,
  RECENCY_BOOST_7_DAYS: 1.2,
  RECENCY_BOOST_30_DAYS: 1.0,
  RECENCY_BOOST_STALE: 0.8,
  /** Min RRF score for hybrid vector search results (Layer 1c) */
  MIN_RRF_SCORE: 0.012,
  /** Min embedding cosine similarity to auto-create a cross-kind 'informs' edge */
  CROSS_KIND_EDGE_THRESHOLD: 0.6,
  /** Branch-name segments that carry no task signal (union of the two sets
   *  that had drifted between pitfall-handler and briefing-compiler) */
  BRANCH_NOISE_TOKENS: ['feat', 'fix', 'chore', 'main', 'dev', 'master', 'release', 'hotfix', 'refactor'] as readonly string[],
  /** Max rows the JS cosine fallback loads when sqlite-vec is unavailable —
   *  unbounded scans block the single-threaded MCP stdio loop on large stores */
  VECTOR_FALLBACK_SCAN_LIMIT: 200,
} as const;


// --- Briefing Allocation (TurboQuant-inspired) ------------------------------

/** Impact-proportional token allocation + correction pass constants.
 *  Tier-based: T1 (plan+goal+git) > T2 (decisions) > T3 (pitfalls) > T4 (corrections+user) > T5 (project context).
 *  Multi-pass reduction cuts bottom-up: T5 first, then T4, then low-effectiveness T3/T2. */
export const BRIEFING_ALLOCATION = {
  /** Tier-4 corrections candidate pool, fetched BEFORE the JS eligibility
   *  filters (M9 / step 6): the display cap stays 3, but eligibility is
   *  decided over this pool so ineligible high-confidence rows cannot
   *  starve the tier. Bounded — the query is confidence-ordered. */
  CORRECTION_CANDIDATE_POOL: 24,
  // --- Tier token budgets (multi-pass reduction cuts bottom-up) ---
  /** Tier 1: plan state + goal + git state (always included) */
  TIER1_BUDGET: 200,
  /** Tier 2: decisions — effectiveness-ranked */
  TIER2_BUDGET: 500,
  /** Tier 3: pitfalls — effectiveness-ranked */
  TIER3_BUDGET: 500,
  /** Tier 4: corrections + user profile */
  TIER4_BUDGET: 150,
  /** Tier 5: project context (skipped on compact) */
  TIER5_BUDGET: 80,

  // --- Effectiveness thresholds (shared by decisions + pitfalls) ---
  /** Effectiveness score above which items get full rendering (content + why + how_to_apply) */
  HIGH_EFFECTIVENESS_THRESHOLD: 0.5,
  /** Effectiveness score below which items are excluded from briefing entirely */
  LOW_EFFECTIVENESS_THRESHOLD: 0.25,
  /** Max chars for low-effectiveness pitfall content */
  LOW_EFFECTIVENESS_MAX_CHARS: 80,

  // --- Correction pass (Stage 2 recovery of dropped high-impact pitfalls) ---
  /** Min impact_count for a pitfall to be recovered in correction pass */
  CORRECTION_PASS_MIN_IMPACT: 2,
  /** Min confidence for correction pass recovery */
  CORRECTION_PASS_MIN_CONFIDENCE: 0.5,
  /** Max items recovered by correction pass */
  CORRECTION_PASS_MAX_ITEMS: 2,
  /** Max chars per recovery item */
  CORRECTION_PASS_MAX_CHARS: 60,
  /** Min remaining token budget to attempt correction pass */
  CORRECTION_PASS_MIN_BUDGET: 30,
} as const;

// --- Fingerprint Retrieval --------------------------------------------------

export const FINGERPRINT = {
  /** Weights for multi-signal scoring (6 signals) */
  WEIGHTS: {
    FINGERPRINT: 0.20,
    VECTOR: 0.20,
    CONTENT: 0.20,
    CONFIDENCE: 0.15,
    RECENCY: 0.10,
    PRECISION: 0.15,
  } as Record<string, number>,
  /** Weights for fingerprint dimension overlap */
  DIMENSION_WEIGHTS: {
    MODULE: 0.5,
    FRAMEWORK: 0.3,
    LANG: 0.2,
  },
  /** Minimum multi-signal score for pitfall injection */
  MIN_SCORE: 0.15,
  /** Score multiplier when query and memory have known but disjoint lang dimensions */
  LANG_MISMATCH_PENALTY: 0.5,
  /** Multiplier for candidate fetch (fetch N * this for re-ranking) */
  CANDIDATE_MULTIPLIER: 3,
} as const;

// --- Scoring Profiles (roadmap W3) ------------------------------------------

/** The AUTHORITATIVE weight profiles for the two scoring families (plus
 *  the hook-side tag path, a surfacing consumer). Shared signal primitives
 *  live in utils/scoring-primitives.ts; forms stay distinct. Entries that
 *  alias older constants (SOURCE_WEIGHT, FINGERPRINT.*, RELEVANCE.*) do so
 *  for compatibility with their non-scoring consumers — the profile is the
 *  documented read path for scoring code. Behavior locked by
 *  tests/scoring-characterization.test.ts — tuning any value here must
 *  consciously update those goldens. */
export const SCORING_PROFILES = {
  /** computeScore — multiplicative recall ranking:
   *  conf × source × recency × (FLOOR + GAIN × overlap) */
  RECALL: {
    /** Provenance multipliers — aliases SOURCE_WEIGHT (decay stability
     *  also consumes that object). */
    SOURCE_WEIGHTS: SOURCE_WEIGHT,
    /** Relevance factor floor when content and query share nothing.
     *  Step 6 (M1): 0.3 gave the query-independent prior a ~22.5× range
     *  against a ~1.3× relevance range — confidence outranked answers.
     *  At 0.05, near-zero-relevance rows keep only a sliver of their prior. */
    RELEVANCE_FLOOR: 0.05,
    /** Relevance factor gain per unit of (token overlap × BM25 share).
     *  Sized so the incident fixture's distilled-lesson/raw-paste factor
     *  ratio (≈1.49) clears the worst prior ratio (0.89×1.2 / 0.8×1.0 ≈
     *  1.335) with margin — relevance decides, the prior breaks ties. */
    RELEVANCE_GAIN: 1.9,
  },
  SURFACING: {
    /** multiSignalScore — additive surfacing score */
    MULTI_SIGNAL: {
      /** Signal weights — aliases FINGERPRINT.WEIGHTS */
      WEIGHTS: FINGERPRINT.WEIGHTS,
      /** Aliases FINGERPRINT.LANG_MISMATCH_PENALTY */
      LANG_MISMATCH_PENALTY: FINGERPRINT.LANG_MISMATCH_PENALTY,
      /** Precision proxy multiplier for never-surfaced memories (conf × this) */
      UNPROVEN_PRECISION_PROXY: 0.3,
      /** Injection floor for multi-signal surfaces — aliases FINGERPRINT.MIN_SCORE */
      MIN_SCORE: FINGERPRINT.MIN_SCORE,
    },
    /** scoreRelevance — hook-side tag relevance (utils/relevance.ts) */
    TAG_RELEVANCE: {
      /** Tag equals the file extension */
      EXTENSION_WEIGHT: 0.6,
      /** Tag equals a path segment */
      PATH_PART_WEIGHT: 0.3,
      /** Command string contains the tag */
      COMMAND_WEIGHT: 0.2,
      /** User message contains the tag */
      MESSAGE_WEIGHT: 0.4,
      /** Aliases RELEVANCE.INJECTION_THRESHOLD (strict >) */
      INJECTION_THRESHOLD: RELEVANCE.INJECTION_THRESHOLD,
    },
  },
} as const;

// --- Prediction -------------------------------------------------------------

export const PREDICTION = {
  /** Min co-recall count to consider a prediction reliable (filters single co-occurrence noise) */
  MIN_CO_COUNT: 2,
  /** Max predictions to surface per prompt */
  MAX_PER_PROMPT: 2,
  /** Preferred kinds when intent is 'task' (pitfalls more useful than facts during work) */
  TASK_PREFERRED_KINDS: ['pitfall', 'decision'] as readonly string[],
  /** Preferred kinds when intent is 'question' (facts more useful for Q&A) */
  QUESTION_PREFERRED_KINDS: ['fact', 'decision'] as readonly string[],
} as const;

// --- Hybrid Search ----------------------------------------------------------

export const HYBRID_SEARCH = {
  /** RRF smoothing constant (standard value — rarely needs tuning) */
  RRF_K: 60,
  /** Candidates to fetch from each retriever before fusion */
  CANDIDATES_PER_RETRIEVER: 20,
} as const;
