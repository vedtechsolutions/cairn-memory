// ============================================================================
// Token budgets, briefing sizing and transcript parsing
// ============================================================================

// --- Token Budgets ----------------------------------------------------------

export const TOKEN_BUDGET = {
  BRIEFING_MAX: 2000,
  PER_TURN_MAX: 100,
  /** Max chars for a waykeep_plan progress note. 300 gives enough room for a
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
 *           waykeep_expand for full content on demand. Target ~400 tokens.
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
  /** Max IDs accepted by waykeep_expand in a single call */
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
