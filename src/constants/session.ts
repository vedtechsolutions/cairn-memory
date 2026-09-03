// ============================================================================
// Goal tiers, tool gating, dedup, relevance and session modes
// ============================================================================

import { type ContextMode } from 'waykeep-contract';

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

// --- Context Pressure Modes -------------------------------------------------

export { CONTEXT_MODES, type ContextMode } from 'waykeep-contract';

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
/** Percent scale for the context-window arithmetic. */
export const PERCENT_TOTAL = 100;
export const DEFAULT_CONTEXT_WINDOW_SIZE = 1_000_000;

// --- Session End Reasons ----------------------------------------------------

export const SESSION_END_REASONS = ['clear', 'logout', 'prompt_input_exit', 'other'] as const;
export type SessionEndReason = (typeof SESSION_END_REASONS)[number];

// --- SessionStart Matchers --------------------------------------------------

export const SESSION_START_MATCHERS = ['startup', 'compact', 'resume', 'clear'] as const;
export type SessionStartMatcher = (typeof SESSION_START_MATCHERS)[number];

// --- Session cache (every hook invocation passes through it) ----------------

export const SESSION_CACHE = {
  /** FTS candidate cache lifetime. */
  FTS_TTL_MS: 30_000,
  /** Fallback lifetime for cached git facts (hash, remote) in a long-lived process. */
  GIT_TTL_MS: 300_000,
  /** Bounds the FTS cache so a long session cannot grow it without limit. */
  MAX_FTS_ENTRIES: 50,
  /** Dirty edit trackers are flushed to disk on this cadence. */
  TRACKER_FLUSH_INTERVAL_MS: 60_000,
  /** Hard TTL on skip-gate entries — the staleness bound for a lost invalidation. */
  SKIP_GATE_TTL_MS: 60_000,
  /** Per-process cap on skip-gate entries (FIFO eviction). */
  MAX_SKIP_GATE_ENTRIES: 200,
} as const;

// --- Decision reflector (Stop hook, layer 1c) ------------------------------

export const REFLECTION = {
  /** Minimum decision-marker count before reflection fires. Single-marker
   *  turns are too noisy — casual phrasing often includes one "recommend"
   *  or "going with" without a real architectural choice behind it. */
  MIN_MARKERS: 2,
  /** Max decisions extracted per turn; the prompt caps at 3 to avoid
   *  splitting related thoughts into shallow entries. */
  MAX_DECISIONS: 3,
  /** Max assistant text passed to the reflector (~500 Haiku tokens —
   *  cheap even at high fire rates). */
  INPUT_MAX_CHARS: 2000,
  /** Sampling deadline; on expiry reflection returns empty and the caller
   *  routes to the nudge path. */
  TIMEOUT_MS: 10_000,
} as const;

/** Bounds for freeUntilCompact — a percentage of remaining context. */
export const CONTEXT_FREE_PCT = {
  MIN: 0,
  MAX: 100,
} as const;
