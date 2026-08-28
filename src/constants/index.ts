// ============================================================================
// Cairn Constants — Single source of truth for all enums, defaults, and limits
// ============================================================================

// --- Memory Kinds -----------------------------------------------------------

export const MEMORY_KINDS = ['pitfall', 'decision', 'correction', 'fact', 'task_state', 'user_profile', 'reference', 'pattern', 'goal', 'rule'] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

/** Kinds accepted via cairn_learn (task_state is system-managed).
 *  'pattern' and 'goal' are learnable: patterns are mined from winning
 *  sessions (Phase 3) and can also be stored explicitly; goals are
 *  stored on plan creation and task-intent detection (Phase 4). */
export const LEARNABLE_KINDS = ['pitfall', 'decision', 'correction', 'fact', 'user_profile', 'reference', 'pattern', 'goal'] as const;
export type LearnableKind = (typeof LEARNABLE_KINDS)[number];

/** Policy records have explicit lifecycle only; generic maintenance and
 * confidence feedback must never rewrite their authority metadata. */
export const NON_DECAYING_KINDS = ['rule'] as const satisfies readonly MemoryKind[];

// --- Memory Sources ---------------------------------------------------------

export const MEMORY_SOURCES = ['user', 'learned', 'corrected', 'confirmed'] as const;
export type MemorySource = (typeof MEMORY_SOURCES)[number];

/** Authority ranking for source types — higher wins on dedup merge (never downgrade user → learned) */
export const SOURCE_AUTHORITY: Record<MemorySource, number> = {
  user: 3,
  confirmed: 2,
  corrected: 1,
  learned: 0,
} as const;

// --- Plan Statuses ----------------------------------------------------------

export const PLAN_STATUSES = ['active', 'completed', 'abandoned'] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

// --- Step Statuses ----------------------------------------------------------

export const STEP_STATUSES = ['done', 'in_progress', 'pending', 'blocked'] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

// --- Confidence Defaults ----------------------------------------------------

export const CONFIDENCE = {
  LEARNED: 0.65,
  CORRECTION: 0.8,
  USER_CORRECTION: 0.9,
  AUTO_DETECTED: 0.55,
  BOOST_INCREMENT: 0.05,
  STRENGTHEN_INCREMENT: 0.1,
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
  /** Each recall extends stability: S = base × (1 + recall_count × this) */
  RECALL_STABILITY_FACTOR: 0.3,
  /** runMaintenance no-ops within this window unless force: true —
   *  decay is time-idempotent, so this bounds sweep cost, not correctness */
  MAINTENANCE_MIN_INTERVAL_HOURS: 12,
  /** Stability fallback for kinds missing from STABILITY_BY_KIND */
  DEFAULT_STABILITY_DAYS: 30,
  /** Deltas below this (days) are skipped WITHOUT advancing last_decayed_at —
   *  lossless (the charge accrues until it clears the bar) and avoids
   *  rewriting every row to record microscopic decay on frequent runs */
  MIN_CHARGE_DAYS: 0.01,
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
 *  S = base * (1 + recall_count * DECAY.RECALL_STABILITY_FACTOR) * SOURCE_WEIGHT[source] */
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

// --- Token Budgets ----------------------------------------------------------

export const TOKEN_BUDGET = {
  BRIEFING_MAX: 2000,
  PER_TURN_MAX: 100,
  /** Max chars for a cairn_plan progress note. 300 gives enough room for a
   *  useful handoff snapshot (status + counts + file list + next action)
   *  while still forcing distillation — full descriptions belong in step
   *  outcomes, not notes. */
  NOTE_MAX_CHARS: 300,
  CONTENT_WARN_CHARS: 200,
  RULES_FILE: 120,
  APPROACH_NOTE_MAX_CHARS: 600,
  /** Max chars for goal line in briefing (distilled user goal — truncate) */
  BRIEFING_GOAL_MAX_CHARS: 500,
  /** Max chars for ultra-compact project context on startup (single line) */
  PROJECT_CONTEXT_COMPACT_MAX_CHARS: 120,
  /** Max chars per approach note in briefing (cleaned transcript text — truncate) */
  BRIEFING_APPROACH_MAX_CHARS: 500,
} as const;

/** Dynamic briefing budget — scales with available context window */
export const BRIEFING_BUDGET = {
  /** Generous budget for fresh sessions with >50% context free */
  STARTUP_MAX: 3000,
  /** Standard budget for post-compaction (25-50% free) */
  COMPACT_MAX: 2000,
  /** Reduced budget for low context (10-25% free) */
  MINIMAL_MAX: 1200,
  /** Bare essentials for critically low context (<10% free) */
  CRITICAL_MAX: 600,
} as const;

/**
 * Briefing rendering mode.
 *
 * 'full'  — Tier-based full briefing (historical default; ~700 tokens typical).
 * 'index' — Progressive-disclosure index: compact one-line entries with stable
 *           ID prefixes (dec:/pit:/inv:/cor:) that Claude can pass to
 *           cairn_expand for full content on demand. Target ~400 tokens.
 * 'auto'  — Pick based on session type: full on fresh startup/clear, index on
 *           compact/resume (post-compaction has less context to spare).
 */
export const BRIEFING_MODE = {
  // Default is 'full' to preserve backward compatibility with existing
  // tests and callers that expect the detailed tier-based briefing.
  // Callers (like session-start-handler) can opt into 'auto' or 'index'
  // explicitly via ctx.briefingMode.
  DEFAULT: 'full' as 'full' | 'index' | 'auto',
  /** Max entries per category in index briefings */
  INDEX_MAX_DECISIONS: 5,
  INDEX_MAX_PITFALLS: 6,
  INDEX_MAX_CORRECTIONS: 3,
  INDEX_MAX_CHAINS: 2,
  /** Max chars per index entry line (keeps the whole thing tight) */
  INDEX_LINE_MAX_CHARS: 100,
  /** Max IDs accepted by cairn_expand in a single call */
  EXPAND_MAX_IDS: 10,
} as const;

// --- Transcript Parsing -----------------------------------------------------

export const TRANSCRIPT_TAIL_BYTES = 512 * 1024; // 512KB
export const TRANSCRIPT_FULL_READ_THRESHOLD = 512 * 1024;

// --- Success Pattern Detection ----------------------------------------------

export const SUCCESS_DETECTION_WINDOW_MS = 600_000; // 10 minutes
export const LEARNABLE_SUCCESS_PATTERNS = [
  /^exit code: 0/,
  /tests? pass/i,
  /build succeed/i,
  /no errors/i,
] as const;

// --- Limits -----------------------------------------------------------------

export const LIMITS = {
  MAX_TAGS: 5,
  MAX_CONTENT_CHARS: 2000,
  MAX_STRING_PARAM: 200,
  MAX_PLANS_PER_PROJECT: 50,
  MAX_STEPS_PER_PLAN: 15,
  RECALL_DEFAULT: 5,
  RECALL_COMPACT: 3,
  RECALL_MINIMAL: 2,
  BRIEFING_PITFALLS_NORMAL: 5,
  BRIEFING_PITFALLS_COMPACT: 3,
  BRIEFING_PITFALLS_MINIMAL: 1,
  /** Extra pitfalls to show after a "stuck" session */
  BRIEFING_PITFALLS_STUCK_BONUS: 2,
  /** Max unresolved contradiction pairs surfaced in a briefing */
  BRIEFING_CONTRADICTIONS_MAX: 3,
  RECENT_ERROR_WINDOW_MS: 120_000,
  SELF_CORRECTION_WINDOW_S: 60,
  STALE_PROJECT_DAYS: 90,
  ARCHIVED_PLAN_CLEANUP_DAYS: 180,
  REMINDERS_MAX_FIRE_PER_PROMPT: 3,
  /** Candidate cap for decisions — tier budget controls actual rendered count */
  BRIEFING_MAX_DECISIONS: 8,
  MAX_CROSS_SESSION_DECISIONS: 2,
  CROSS_SESSION_SUMMARY_MAX_CHARS: 200,
  CLEANUP_MAX_DELETE: 100,
  PITFALL_MAX_FOR_READ: 1,
  SUCCESS_MIN_TOOL_CHAIN: 2,
  BRIEFING_MAX_USER_PROFILES: 3,
  /** Auto-archive active plans with all steps pending after this many hours */
  PLAN_UNTOUCHED_ARCHIVE_HOURS: 2,
  /** Snapshot project fallback window (minutes) — prevents cross-session leakage */
  SNAPSHOT_FALLBACK_MINUTES: 5,
  /** Goal scan: max snapshots to check for goal inheritance */
  GOAL_SCAN_LIMIT: 3,
  /** Goal scan: only inherit goals from snapshots within this window (hours) */
  GOAL_SCAN_HOURS: 4,
  /** Snapshot retention: keep snapshots for this many hours (time-based cleanup) */
  SNAPSHOT_RETENTION_HOURS: 24,
  /** Cross-tier decision dedup: prefix length for signature comparison */
  DECISION_DEDUP_PREFIX: 40,
  /** Goal staleness: max times a goal can be inherited before being omitted */
  GOAL_MAX_CARRY_COUNT: 2,
  /** v3.1: max age for a kind=goal memory to be surfaced via the
   *  prompt-handler's recall paths (goal pre-flight + Layer 1a/1b/1c). Older
   *  goal memories are filtered out even if they match the prompt — session-
   *  continuity blurbs lose relevance after a few days and become noise.
   *  72h covers overnight + long-weekend continuity without holding last
   *  week's resume prose as "similar prior goal". */
  GOAL_REMINDER_MAX_AGE_HOURS: 72,
  /** Phase 2: resume cursor staleness threshold (ms). Cursors older than this
   *  are suppressed from the briefing — a 30-minute context switch is long
   *  enough that re-reading the file is cheaper than trusting the pointer. */
  RESUME_CURSOR_STALE_MS: 30 * 60 * 1000,
  /** Phase 3: iteration cost threshold. When a single file is edited more
   *  than this many times in a session, SessionEnd auto-creates a pitfall
   *  "file X required N edits — plan more carefully before editing next
   *  time." Tuned conservatively — legitimate iterative refactors should
   *  land below this. */
  ITERATION_COST_THRESHOLD: 5,
  /** Phase 3: max auto-iteration-cost pitfalls per session. Prevents a single
   *  session with many touched files from flooding the pitfall store. */
  ITERATION_COST_MAX_PER_SESSION: 3,
  /** Phase 3: max patterns to mine from a smooth session. Patterns are
   *  distilled wins; more than 2 per session is likely noise. */
  PATTERN_MINE_MAX_PER_SESSION: 2,
  /** Phase 4: minimum semantic similarity for goal pre-flight match. Only
   *  surface a prior goal bundle when the new prompt is this similar to
   *  an indexed goal. 0.7 aligns with the existing RRF vector thresholds. */
  GOAL_MATCH_MIN_SIMILARITY: 0.7,
  /** Phase 5: recall precision feedback — strengthen increment when a
   *  recalled memory led to a success marker in the session. */
  PRECISION_STRENGTHEN_INCREMENT: 0.05,
  /** Phase 5: recall precision feedback — weaken factor when a recalled
   *  memory was surfaced but did not lead to success. Mild by design so
   *  a single unused recall doesn't crater the memory. */
  PRECISION_WEAKEN_FACTOR: 0.97,
  /** SNR v3 Commit 4: cross-tier goal dedup threshold. When Now ≈ Feature
   *  or Feature ≈ Project by Jaccard token overlap, the less-specific tier
   *  is dropped so the briefing never shows the same goal twice under two
   *  different labels. Mirrors DECISION_DEDUP_JACCARD in briefing-compiler. */
  GOAL_TIER_DEDUP_JACCARD: 0.55,
} as const;

// --- SNR v3 Commit 4: three-tier goal rendering -----------------------------

/** Labels for the three goal tiers surfaced in the briefing. Mapped from
 *  goal source and staleness policy by renderTier1 / compileIndexBriefing.
 *
 *  - Now: per-turn task goal (from snap.initialGoal). Session-boundary
 *    staleness — drops when session_id changes.
 *  - Feature: branch-scoped goal (projectGoal with source='branch').
 *    Branch mismatch / carry count / completed-step / shipped-by-commit.
 *  - Project: durable branch-spanning goal (projectGoal with source ∈
 *    {user, plan, transcript}). Only drops on explicit pivot. */
export const GOAL_TIER_LABELS = {
  now: 'Now',
  feature: 'Feature',
  project: 'Project',
} as const;

export type GoalTier = keyof typeof GOAL_TIER_LABELS;

/** Compact age formatter — renders "Nm ago", "Nh ago", "Nd ago". Used as
 *  the trailing metadata on every goal-tier line so Claude can weight
 *  freshness without a separate captured_at column in the output. */
export function formatAgeCompact(capturedAtIso: string | null | undefined, now: number = Date.now()): string | null {
  if (!capturedAtIso) return null;
  const at = Date.parse(capturedAtIso);
  if (!Number.isFinite(at)) return null;
  const diffMs = now - at;
  if (diffMs < 0) return null;
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export const PITFALL_CHECK_TOOLS = ['Write', 'Edit', 'Bash'] as const;
export const PITFALL_READ_MODES: ContextMode[] = ['normal'];

export const CLEANUP_ACTIONS = ['preview', 'execute'] as const;
export type CleanupAction = (typeof CLEANUP_ACTIONS)[number];

export const STATS_ACTIONS = ['summary', 'health', 'by_kind', 'by_project'] as const;
export type StatsAction = (typeof STATS_ACTIONS)[number];

// --- Deduplication ----------------------------------------------------------

export const DEDUP = {
  /** Token overlap threshold for dedup — lowered from 0.6 to catch paraphrased duplicates */
  SIMILARITY_THRESHOLD: 0.5,
} as const;

// --- Relevance Scoring ------------------------------------------------------

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

// --- Context Pressure Modes -------------------------------------------------

export const CONTEXT_MODES = ['normal', 'compact', 'minimal', 'critical'] as const;
export type ContextMode = (typeof CONTEXT_MODES)[number];

export const CONTEXT_THRESHOLDS = {
  /** Above this % free → normal mode */
  NORMAL: 50,
  /** Above this % free → compact mode */
  COMPACT: 25,
  /** Above this % free → minimal mode */
  MINIMAL: 10,
  /** Below MINIMAL → critical mode */
} as const;

/** Autocompact buffer in tokens (~5% of 1M — triggers compaction with room to spare) */
export const AUTOCOMPACT_BUFFER_TOKENS = 50_000;
export const DEFAULT_CONTEXT_WINDOW_SIZE = 1_000_000;

// --- Session End Reasons ----------------------------------------------------

export const SESSION_END_REASONS = ['clear', 'logout', 'prompt_input_exit', 'other'] as const;
export type SessionEndReason = (typeof SESSION_END_REASONS)[number];

// --- SessionStart Matchers --------------------------------------------------

export const SESSION_START_MATCHERS = ['startup', 'compact', 'resume', 'clear'] as const;
export type SessionStartMatcher = (typeof SESSION_START_MATCHERS)[number];

// --- Version ----------------------------------------------------------------

/** Single source of truth for Cairn version — keep in sync with package.json */
export const VERSION = '5.1.0';

// --- DB Config --------------------------------------------------------------

export const DB = {
  DEFAULT_PATH: '~/.cairn/cairn.db',
  BUSY_TIMEOUT_MS: 5000,
} as const;

// --- Filesystem permissions -------------------------------------------------

/** Owner-only permissions for the Cairn state directory and the sensitive
 *  files inside it (database, hook socket, PID file). The hook socket carries
 *  no authentication of its own, so 0700 directory containment IS the access
 *  control: on a shared or root host it keeps other local users from
 *  connecting to the socket, claiming its ownership, or reading the database.
 *  Cross-UID sharing (a root daemon serving non-root clients) is intentionally
 *  not supported by these perms and needs a future peer-credential design. */
export const FS_PERMS = {
  DIR: 0o700,
  FILE: 0o600,
  /** Group + other permission bits. A path is "owner-only" when none are set;
   *  the fail-closed socket self-verify asserts `(mode & GROUP_OTHER_BITS) === 0`. */
  GROUP_OTHER_BITS: 0o077,
} as const;

// --- Governance -------------------------------------------------------------

export const GOVERNANCE = {
  /** Env flag opting into persisting the full, unredacted shell command line
   *  in the local `governance_tool_events.raw_command` column. Default OFF:
   *  raw commands can contain inline secrets and the DB is a local,
   *  unencrypted file, so the safe default stores only the redacted form plus
   *  a SHA-256 for correlation. The raw column is never synced or exported
   *  regardless of this flag. Set to `1` (or `true`) for local-only forensics. */
  PERSIST_RAW_COMMAND_ENV: 'CAIRN_PERSIST_RAW_COMMAND',
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

// --- Shared State -----------------------------------------------------------

export const TRACKER_FILENAME = 'edit-tracker.json';
/** Max age (days) before orphaned session tracker files are cleaned up */
export const TRACKER_ORPHAN_MAX_AGE_DAYS = 7;
export const STATE_STALENESS_MS = 30_000;
/** updateTracker lock (H6 lost-update fix): a lock dir older than this is a
 *  crashed holder and gets stolen — generous vs the few-ms critical section */
export const TRACKER_LOCK_STALE_MS = 2_000;
/** Max time a hook waits for the tracker lock before proceeding unlocked
 *  (fail-open: hooks must never hang Claude Code) */
export const TRACKER_LOCK_MAX_WAIT_MS = 250;
/** Delay between tracker lock acquisition retries */
export const TRACKER_LOCK_RETRY_MS = 10;

// --- Project Context Scanning -----------------------------------------------

export const PROJECT_SCAN = {
  IGNORED_DIRS: [
    '.git', 'node_modules', 'dist', '__pycache__', '.venv', 'venv',
    'target', 'build', '.next', '.cache', 'coverage', '.tox', '.mypy_cache',
    '.pytest_cache', '.nyc_output', '.turbo', 'vendor',
  ] as readonly string[],
  MAX_TOP_DIRS: 15,
  MAX_SUB_DEPTH: 1,
  MAX_CACHE_PER_PROJECT: 5,
  CONFIG_FILES: [
    'package.json', 'tsconfig.json', 'Cargo.toml', 'pyproject.toml',
    'go.mod', 'Makefile', 'docker-compose.yml', 'build.gradle',
    'pom.xml', 'CMakeLists.txt', 'setup.py', 'setup.cfg',
  ] as readonly string[],
} as const;

// --- Proactive Pre-Tool Warnings --------------------------------------------

export const PROACTIVE = {
  /** Max warnings injected per tool call (alert fatigue threshold — research backed) */
  MAX_WARNINGS_PER_CALL: 3,
  /** Rapid re-edit window: same file edited within this window triggers re-read suggestion */
  RAPID_REEDIT_MS: 30_000,
  /** Confidence floor for pitfalls when file has recent session errors */
  SESSION_ERROR_CONFIDENCE_FLOOR: 0.3,
  /** How far back in toolChain to look for loop patterns */
  LOOP_LOOKBACK: 6,
  /** Tools that get proactive pre-tool warnings */
  TOOLS: ['Write', 'Edit', 'MultiEdit', 'Bash'] as readonly string[],
  /** Max decisions to surface per tool call (only in normal mode) */
  MAX_DECISIONS: 2,
  /** Max investigation chain summaries to surface per tool call */
  MAX_INVESTIGATION_CHAINS: 1,
  /** Min confidence for surfacing decisions at pre-tool time */
  MIN_DECISION_CONFIDENCE: 0.7,
  /** Cooldown: don't re-surface the same pitfall within this window */
  SURFACE_COOLDOWN_MS: 300_000, // 5 minutes
  /**
   * Cooldown for session-aware warnings (A1 recent-failure, A2 edit-fail
   * loop, A3 rapid re-edit). Without this, A3 fires on every consecutive
   * edit of the same file within RAPID_REEDIT_MS, flooding the injection
   * stream with duplicates. 60 s is long enough to avoid repeats across a
   * natural edit cluster and short enough to re-alert on a fresh pattern.
   */
  WARNING_COOLDOWN_MS: 60_000,
  /** Impact threshold: suppress pitfalls surfaced this many times with 0 impact */
  UNPROVEN_SURFACE_THRESHOLD: 5,
  /** Max chars of code content to include in FTS query */
  CONTENT_QUERY_MAX_CHARS: 300,
  /** Auto-weaken window: weaken surfaced pitfalls if tool fails within this window */
  AUTO_WEAKEN_WINDOW_MS: 120_000, // 2 minutes
  /** Probation: new memories (< PROBATION_DAYS old) surface at a lower confidence floor
   *  to bootstrap impact data before the normal gate kicks in */
  PROBATION_DAYS: 7,
  PROBATION_CONFIDENCE_FLOOR: 0.40,
  /** Minimum fingerprint score for probation surfaces (higher than normal MIN_SCORE) */
  PROBATION_MIN_SCORE: 0.25,
  /**
   * Minimum pure fingerprint overlap (jaccard-weighted by DIMENSION_WEIGHTS)
   * required for a cross-project memory (global → current project) to
   * surface as a pitfall or decision. Same-project memories are unaffected.
   * Null-fingerprint globals are never surfaced cross-project, regardless of
   * threshold, since they carry no contextual evidence of relevance.
   *
   * Floor is set to exactly the LANG dimension weight (0.2) so that a
   * pure-lang-only global (e.g., a global TypeScript rule tagged
   * `lang:['typescript']`) can surface on any TS edit — that is the minimum
   * meaningful signal for a global rule. Anything below 0.2 is either a
   * sub-full lang match (partial intersection) or a tangential framework/
   * module echo that should not fire cross-project.
   *
   * Rationale: prevents Odoo 19 / Django / Rails globals from leaking into
   * unrelated project sessions via FTS content matches on common English
   * words ("module", "template", "service", "field"), while preserving broad
   * language-level globals.
   */
  CROSS_PROJECT_MIN_OVERLAP: 0.2,
} as const;

// --- Error Escalation -------------------------------------------------------

export const ESCALATION = {
  /** Number of same-error occurrences in a session before escalation triggers */
  THRESHOLD: 3,
  /** Maximum tool chain length to include in escalation context */
  MAX_CHAIN_CONTEXT: 3,
} as const;

/** Category-specific alternative suggestions keyed by first classification tag.
 *  Positive framing (research: positive directives outperform "STOP" instructions). */
export const ESCALATION_ALTERNATIVES: Record<string, string> = {
  typescript: 'Re-read the file to check current types, or run the build to see full error context.',
  python: 'Check the traceback for the root cause line and re-read that file.',
  javascript: 'Re-read the file to check current variable/function names.',
  node: 'Check import paths and package.json exports field.',
  sqlite: 'Check schema with .schema before retrying the query.',
  testing: 'Read the failing test to understand the expected behavior before fixing.',
  xml: 'Validate the XML structure — check for unclosed tags or encoding issues.',
  orm: 'Check the model definition and field types before retrying.',
  odoo: 'Verify the field exists on the model with fields_get before accessing it.',
} as const;

/** Fallback alternative when no category-specific suggestion exists */
export const ESCALATION_FALLBACK = 'Re-read the relevant files — the content may have changed since your last read.';

/** Tool-specific alternatives for when error category doesn't match */
export const ESCALATION_TOOL_ALTERNATIVES: Record<string, string> = {
  Edit: 'Re-read the file first — the old_string content may have changed.',
  Write: 'Check that the target directory exists and the path is correct.',
  Bash: 'The command failed identically — try a different approach entirely.',
} as const;

// --- Consolidation ----------------------------------------------------------

export const CONSOLIDATION = {
  /** Minimum affinity score to merge two memories */
  AFFINITY_THRESHOLD: 0.7,
  /** Max memories to process per kind per consolidation run */
  MAX_PER_KIND: 50,
  /** Only consolidate kinds that benefit from merging */
  ELIGIBLE_KINDS: ['pitfall', 'decision', 'fact'] as readonly string[],
  /** Min age (days) before a memory is eligible for consolidation */
  MIN_AGE_DAYS: 7,
  /** Weight for embedding cosine similarity when both embeddings available */
  EMBEDDING_WEIGHT: 0.5,
  /** Weight for token overlap when embeddings are available (reduced from 0.7) */
  TOKEN_OVERLAP_WITH_EMBEDDING: 0.2,
  /** Weight for temporal proximity when embeddings are available */
  TEMPORAL_WEIGHT: 0.3,
  /** Min co-recall count before promoting to co_occurred edge */
  CO_RECALL_EDGE_THRESHOLD: 3,
  /** Max co-recall pairs to promote per maintenance run */
  CO_RECALL_PROMOTE_LIMIT: 10,
  /** Max memories auto-promoted to global scope per maintenance run */
  MAX_AUTO_PROMOTIONS: 3,
  /** Age (days) past which co_occurred edges are pruned */
  CO_OCCURRENCE_PRUNE_DAYS: 90,
} as const;

// --- MCP Server Background Workers -------------------------------------------

export const EMBEDDING_BACKFILL = {
  /** Max wait for the embedding model to warm up before skipping backfill */
  MODEL_WARMUP_MAX_WAIT_MS: 30_000,
  /** Poll interval while waiting for model warmup */
  WARMUP_POLL_MS: 500,
  /** Memories embedded per backfill batch */
  BATCH_SIZE: 10,
  /** Pause between batches so backfill doesn't hog the event loop */
  BATCH_PAUSE_MS: 100,
} as const;

export const CONTEXT_VECTOR = {
  /** Rolling-context-vector worker tick interval */
  INTERVAL_MS: 5_000,
  /** Blend weight of the newest prompt embedding */
  BLEND_NEW: 0.7,
  /** Blend weight of the previous rolling vector */
  BLEND_PREV: 0.3,
  /** Drop a pending prompt after this many failed embedding attempts */
  MAX_RETRIES: 3,
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

// --- Briefing Allocation (TurboQuant-inspired) ------------------------------

/** Impact-proportional token allocation + correction pass constants.
 *  Tier-based: T1 (plan+goal+git) > T2 (decisions) > T3 (pitfalls) > T4 (corrections+user) > T5 (project context).
 *  Multi-pass reduction cuts bottom-up: T5 first, then T4, then low-effectiveness T3/T2. */
export const BRIEFING_ALLOCATION = {
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
    /** Relevance factor floor when content and query share nothing */
    RELEVANCE_FLOOR: 0.3,
    /** Relevance factor gain per unit of token overlap */
    RELEVANCE_GAIN: 0.9,
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

// --- Intent Classification --------------------------------------------------

export const INTENTS = ['task', 'question', 'correction', 'status'] as const;
export type UserIntent = (typeof INTENTS)[number];

// --- Error Classification ---------------------------------------------------

export const LEARNABLE_ERROR_PATTERNS = [
  { pattern: /SyntaxError|IndentationError/, tags: ['python', 'syntax'] },
  { pattern: /ImportError|ModuleNotFoundError/, tags: ['python', 'imports'] },
  { pattern: /TypeError|AttributeError/, tags: ['python', 'api'] },
  { pattern: /ParseError|XMLSyntaxError/, tags: ['xml', 'parsing'] },
  { pattern: /AssertionError/, tags: ['testing'] },
  { pattern: /ValidationError|IntegrityError/, tags: ['orm', 'database'] },
  { pattern: /KeyError.*field/, tags: ['odoo', 'fields'] },
  { pattern: /error TS\d+|Cannot find module|Property .+ does not exist/, tags: ['typescript'] },
  { pattern: /ERR_MODULE_NOT_FOUND|ERR_REQUIRE_ESM|Cannot find package/, tags: ['node', 'modules'] },
  { pattern: /ENOENT|EACCES|EPERM|EADDRINUSE/, tags: ['node', 'system'] },
  { pattern: /ReferenceError|RangeError/, tags: ['javascript'] },
  { pattern: /SQLITE_ERROR|SQLITE_CONSTRAINT|SQLITE_BUSY/, tags: ['sqlite', 'database'] },
  { pattern: /npm ERR!|error Command failed|ERR_PNPM_/, tags: ['npm'] },
  { pattern: /Failed to compile|Build failed|build error/i, tags: ['build'] },
  { pattern: /OSError|FileNotFoundError|OverflowError|RuntimeError|RecursionError|NotImplementedError|StopIteration/, tags: ['python'] },
  { pattern: /exit(?:ed)? (?:with )?(?:code|status) [1-9]/, tags: ['process'] },
] as const;

export const NOISE_ERROR_PATTERNS = [
  /ConnectionError|TimeoutError|ConnectionRefused/,
  /PermissionError|Permission denied/,
  /command not found/,
  /KeyboardInterrupt/,
  /SIGTERM|SIGKILL/,
  /ETIMEOUT|ECONNRESET|ECONNREFUSED/,
] as const;

// --- Embedding model registry (roadmap W2) ----------------------------------

export {
  EMBEDDING_MODELS, DEFAULT_EMBEDDING_MODEL_KEY, type EmbeddingModelConfig,
} from './embedding-models.js';
