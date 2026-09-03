import { MS_PER_MINUTE, MS_PER_HOUR } from './time.js';

// ============================================================================
// Hard limits, rollup, import, sync-apply and owner RPC
// ============================================================================

// --- Limits -----------------------------------------------------------------

/** Tokens-saved report (Phase 1 step 4). Numbers are INTERNAL tuning,
 *  never contract. */
export const ROLLUP = {
  /** Estimated tokens to re-derive one VERIFIED-useful memory (an impact
   *  event: a surfaced lesson followed by a confirmed success). This is a
   *  deliberate, conservative stand-in — re-deriving a pitfall typically
   *  means re-reading files and re-hitting the error — and the report
   *  labels every number built from it as an estimate. */
  IMPACT_PROXY_TOKENS: 150,
  /** Rollup rows outlive the 7-day telemetry prune by design; a year
   *  bounds growth (~a few rows per session event). */
  RETENTION_DAYS: 365,
  /** Default report window. */
  REPORT_DAYS: 30,
} as const;

/** Rollup metric names (internal vocabulary, not contract). */
export const ROLLUP_METRICS = {
  /** COST: context Waykeep injected (briefings, warnings, subagent context). */
  INJECTED: 'injected',
  /** GROSS, client-reported: PostCompact tokens_saved. */
  COMPACT_SAVED: 'compact_saved',
  /** GROSS, estimated: verified impact events x IMPACT_PROXY_TOKENS. */
  IMPACT_PROXY: 'impact_proxy',
} as const;

/** Importer tuning (internal). */
export const IMPORT = {
  /** Keyword tags carried per imported task group (retrieval, not noise). */
  MAX_KEYWORD_TAGS: 3,
  /** Sections shorter than this are headers/noise, not lessons. */
  MIN_SECTION_CHARS: 20,
  /** A heading with at least this many bullets splits per-bullet. */
  MIN_BULLETS_FOR_SPLIT: 2,
} as const;

/** Inbound sync-apply bounds (slice-4 Codex gate #1): every cap fails
 *  the whole batch closed — malformed input never advances the cursor. */
export const SYNC_APPLY = {
  MAX_EVENTS_PER_BATCH: 500,
  MAX_PAYLOAD_BYTES: 65_536,
  MAX_CONTRIBUTORS: 64,
  MAX_MEMBER_IDS: 32,
  MAX_ID_LENGTH: 128,
  MAX_ANCHOR_CHARS: 4_096,
} as const;

/** Owner-control RPC bounds and backoff (brief D3). */
export const OWNER_RPC = {
  MAX_BODY_BYTES: 1_048_576,
  BODY_TIMEOUT_MS: 5_000,
  BUSY_ATTEMPTS: 3,
  BUSY_BACKOFF_MS: 25,
  CAPABILITY_REVISION: 1,
} as const;

export const LIMITS = {
  MAX_TAGS: 5,
  MAX_TAG_CHARS: 50,
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
  /** Rolling per-session tool-chain window kept in the tracker. */
  TOOL_CHAIN_MAX: 20,
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
   *  different labels. Same value as DECISION_DEDUP_JACCARD, deliberately. */
  GOAL_TIER_DEDUP_JACCARD: 0.55,
  /** T1↔T2 decision dedup Jaccard threshold (GAP F). Slightly looser than staleness. */
  DECISION_DEDUP_JACCARD: 0.55,
  /** Goal staleness Jaccard threshold (GAP E): ≥60% token overlap flags stale. */
  GOAL_STALE_JACCARD: 0.6,
  /** Goal ship-detection coverage: when the goal's meaningful tokens are
   *  covered by recent commit subjects at this ratio, the goal is treated as
   *  shipped and suppressed. Below 1.0 so commit subjects need not repeat
   *  every goal word verbatim. */
  GOAL_SHIPPED_COVERAGE: 0.6,
  /** Provenance tag slugs (`type:…`, `topic:…`, `group:…`) are capped here. */
  SLUG_MAX_CHARS: 40,
  /** Shortest userContext message that may stand in as a fallback goal. */
  FALLBACK_GOAL_MIN_CHARS: 20,
  /** Branch-name-derived goals shorter or longer than this are not goals. */
  BRANCH_GOAL_MIN_CHARS: 12,
  BRANCH_GOAL_MAX_CHARS: 200,
  /** Safety bound on a reminder condition expression. */
  MAX_CONDITION_CHARS: 200,
  /** Attempts recorded per investigation chain before the chain is closed. */
  MAX_ATTEMPTS_PER_CHAIN: 10,
  /** A query fingerprint with fewer meaningful tokens than this uses the
   *  BROAD relevance policy; the cross-project guard still runs against the
   *  full synthesised fingerprint (overlap 0 still blocks unfingerprinted
   *  globals). Replaces the cold-boot `queryFp ?? BRIEFING_BROAD_FP` kludge
   *  with a policy based on actual fingerprint content. */
  NARROW_OVERLAP_MIN_MEANINGFUL_TOKENS: 2,
} as const;

// --- Governance worktree digest --------------------------------------------

/** Caps that keep a digest of a pathological worktree bounded in time and memory. */
export const WORKTREE_DIGEST = {
  MAX_ENTRIES: 50_000,
  MAX_FILE_BYTES: 64 * 1024 * 1024,
  MAX_TOTAL_BYTES: 512 * 1024 * 1024,
  MAX_GIT_OUTPUT_BYTES: 32 * 1024 * 1024,
  GIT_TIMEOUT_MS: 10_000,
} as const;

/** Shape limits on a governance rule record. */
export const GOVERNANCE_RULE = {
  MAX_PROJECT_CHARS: 512,
  MAX_CONTENT_CHARS: 2_000,
  MAX_PATHS: 64,
  MAX_PATH_CHARS: 512,
  MAX_GATES: 32,
} as const;

/** How old a capability heartbeat may be before it stops counting, and how far
 *  in the future one may sit (clock skew) before it is treated as forged. */
export const CAPABILITY_HEARTBEAT = {
  MAX_AGE_MS: 30 * MS_PER_MINUTE,
  FUTURE_SKEW_MS: MS_PER_MINUTE,
} as const;

/** Bounds on the project scanner's git subprocesses and its upward walk. */
export const GIT_SUBPROCESS = {
  TIMEOUT_MS: 5_000,
  /** Ancestor directories examined when looking for a repository root. */
  MAX_ANCESTOR_DEPTH: 64,
} as const;

// --- Source hygiene (enforced by tests/source-ratchets.test.ts) --------------

export const SOURCE_HYGIENE = {
  /** Files above this are split; the ratchet holds today's offenders at their
   *  current size and refuses new ones. */
  MAX_FILE_LINES: 300,
  /** Numeric literals that never need a name: indices, parity, off-by-one. */
  TRIVIAL_NUMERIC_LITERALS: [0, 1, 2],
} as const;

// --- Governance bounds ----------------------------------------------------

const OVERRIDE_MAX_DURATION_HOURS = 24;

export const GOVERNANCE_BOUNDS = {
  /** Longest shell command the command matcher will parse. */
  MAX_SHELL_COMMAND_CHARS: 65_536,
  /** Argv items considered from an observed command. */
  MAX_OBSERVED_ARGV_ITEMS: 256,
  /** Cap on the recorder's internal reason strings. */
  MAX_INTERNAL_REASON_CHARS: 240,
  /** Longest a governance override may run; the default duration is the max. */
  OVERRIDE_MAX_DURATION_HOURS,
  OVERRIDE_MAX_DURATION_MS: OVERRIDE_MAX_DURATION_HOURS * MS_PER_HOUR,
  /** Per-session cap on governance warnings, and the size cap on each. */
  WARNING_MAX_PER_SESSION: 5,
  WARNING_MAX_CHARS: 4_000,
  /** Default time budget for the shadow evaluator. */
  SHADOW_EVALUATOR_DEFAULT_BUDGET_MS: 250,
  /** Wall-clock budget for assembling override context. The window spans a
   *  filesystem walk and a git subprocess, so it is load-sensitive: an overrun
   *  surfaces as an evaluator fault (`self_error`), not a timeout, which makes
   *  it easy to misread as a logic bug under CI contention. Equal to the
   *  worktree-digest hard ceiling by coincidence, not by contract — they bound
   *  different work and should be tunable apart. */
  OVERRIDE_CONTEXT_DEADLINE_MS: 1_000,
} as const;

/** Decision sigils (`[dec: …]`) parsed from assistant text. */
export const SIGIL = {
  /** Max content length for one sigil decision (matches the legacy extractor cap). */
  MAX_LENGTH: 200,
  /** Max distinct sigils returned per turn — guards against pathological input. */
  MAX_PER_TURN: 8,
} as const;

/** Secret scanner bounds. */
export const SECRET_SCAN = {
  /** Longest private-key body the lazy PEM matcher will consume. A real
   *  4096-bit RSA key body is ~3.4 KB, well under this; bounding the lazy
   *  body keeps the scan linear when fed many unterminated BEGIN markers. */
  MAX_PRIVATE_KEY_BODY_BYTES: 4096,
} as const;
