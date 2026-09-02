// ============================================================================
// Proactive pre-tool warnings and error escalation
// ============================================================================

// --- Proactive Pre-Tool Warnings --------------------------------------------

export const PROACTIVE = {
  /** SNR golden: one highest-priority item per tool call. The turn budget
   *  below prevents different tool calls from each spending this allowance. */
  MAX_WARNINGS_PER_CALL: 1,
  /** Hard cross-tool cap when the client supplies a turn id (or the prompt
   *  hook establishes a synthetic turn boundary). */
  MAX_WARNINGS_PER_TURN: 1,
  /** Conservative total context budget for proactive warnings in one
   *  correlated agent turn, including the Waykeep header. */
  WARNING_TOKEN_BUDGET_PER_TURN: 96,
  /** Rapid re-edit window: same file edited within this window triggers re-read suggestion */
  RAPID_REEDIT_MS: 30_000,
  /** Confidence floor for pitfalls when file has recent session errors */
  SESSION_ERROR_CONFIDENCE_FLOOR: 0.3,
  /** How far back in toolChain to look for loop patterns */
  LOOP_LOOKBACK: 6,
  /** Tools that get proactive pre-tool warnings */
  TOOLS: ['Write', 'Edit', 'MultiEdit', 'Bash', 'apply_patch'] as readonly string[],
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

/** Actionable pitfalls the StopFailure hook stores per API failure type
 *  (keys are Claude Code's StopFailure matchers). Failure types without an
 *  entry are only counted in telemetry — there is nothing to advise. */
export const API_FAILURE_PITFALLS: Record<string, string> = {
  max_output_tokens: 'Break large tasks into smaller steps — the response hit the output token limit. Use plan mode for multi-step work.',
  rate_limit: 'Rate limited — reduce parallel tool calls and batch operations when possible.',
} as const;
