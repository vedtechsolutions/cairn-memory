/**
 * Shared edit tracker — file-based state shared between pitfall-check and success-tracker hooks.
 * Each hook process is short-lived, so state is persisted to disk.
 *
 * Session isolation: each Claude Code session gets its own tracker file
 * (edit-tracker-{session_id}.json) to prevent cross-session interference
 * when multiple sessions run concurrently in the same project.
 * Subagents share the parent session_id, so they naturally share the tracker.
 */
import { readFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync, rmdirSync } from 'node:fs';
import { writeFileAtomic } from '../../utils/atomic-write.js';
import { join, dirname } from 'node:path';
import {
  TRACKER_FILENAME,
  TRACKER_ORPHAN_MAX_AGE_DAYS,
  TRACKER_LOCK_STALE_MS,
  TRACKER_LOCK_MAX_WAIT_MS,
  TRACKER_LOCK_RETRY_MS,
} from '../../constants/index.js';
import type { ToolEvent, SuccessDedup } from '../../utils/success-classifier.js';
import { dataDir } from '../../constants/paths.js';
import { MS_PER_DAY } from '../../constants/time.js';

const TRACKER_BASE = TRACKER_FILENAME.replace('.json', '');

/** Tracker directory — WAYKEEP_DIR env override (mirrors WAYKEEP_DB_PATH) keeps
 *  tests and sandboxed environments off the real ~/.waykeep. Resolved lazily
 *  so the override works regardless of import order. */
function waykeepDir(): string {
  return dataDir();
}

/** Get tracker path — per-session when session_id is provided (concurrent session isolation) */
export function getTrackerPath(sessionId?: string): string {
  if (!sessionId) return join(waykeepDir(), TRACKER_FILENAME);
  return join(waykeepDir(), `${TRACKER_BASE}-${sessionId}.json`);
}

export interface SessionErrorEntry {
  count: number;
  firstSeen: number;
}

/** Resume cursor — last successful edit location (Phase 2 of North Star).
 *  Populated by success-tracker-handler on Write/Edit/MultiEdit PostToolUse.
 *  Surfaced by session-start-handler in the briefing when (now - at) <
 *  RESUME_CURSOR_STALE_MS, so the briefing can render "Resume:
 *  foo.ts:240 (Edit, 3m ago)". When line extraction fails (file unreadable,
 *  race with git, etc.) `line` is null — the cursor still carries file +
 *  tool + timestamp. Persisted to disk with the rest of the tracker. */
export interface ResumeCursor {
  file: string;
  line: number | null;
  tool: 'Write' | 'Edit' | 'MultiEdit';
  at: number;
}

export interface EditTracker {
  lastEditPath: string | null;
  lastEditTime: number;
  /** Phase 2: resume cursor for post-compact / post-exit continuity */
  lastEditCursor: ResumeCursor | null;
  /** Phase 3: per-file edit counter. Incremented by success-tracker-handler
   *  on every successful Write/Edit/MultiEdit. SessionEnd walks this map at
   *  the end of the session and auto-creates a pitfall for any file where
   *  the count exceeds LIMITS.ITERATION_COST_THRESHOLD — "X required N
   *  edits — plan more carefully next time". Cleared on session boundary
   *  (detected via sessionId change, same as sessionErrorCounts). */
  editCountsByFile: Record<string, number>;
  surfacedPitfalls: Record<string, string[]>; // filePath → memory IDs
  toolChain: ToolEvent[];
  successDedup: SuccessDedup;
  /** Session-scoped error counts for escalation detection */
  sessionErrorCounts: Record<string, SessionErrorEntry>;
  /** Session ID for boundary detection — reset counts on new session */
  sessionId: string | null;
  /** Recently surfaced pitfall IDs with timestamps — for cooldown dedup */
  recentlySurfaced: Record<string, number>;
  /**
   * Session-aware warning cooldown map. Key: "A1:<file>" | "A2:<file>" | "A3:<file>".
   * Value: ms timestamp of the last fire. Prevents A1/A2/A3 from re-firing on
   * every subsequent edit of the same file within WARNING_COOLDOWN_MS.
   */
  recentWarningFired: Record<string, number>;
  /** Turn-correlated proactive warning budget. Optional so tracker files
   *  written by older releases remain valid without migration. */
  warningBudgetTurnKey?: string | null;
  warningBudgetSequence?: number;
  warningTokensInjectedThisTurn?: number;
  warningCountInjectedThisTurn?: number;
  /** Whether a pre-flight workflow reminder has been shown this session */
  preflightFired: boolean;
  /** Whether a compliance nudge has been shown this session (Layer 2a) */
  complianceNudgeFired: boolean;
  /** Whether a decision reminder has been shown this session (Layer 2b) */
  decisionReminderFired: boolean;
  /**
   * Layer 1c (Socratic Stop reflection) — nudge flag.
   *
   * Set by the Stop handler when the last turn contained decision markers
   * (countDecisionMarkers >= REFLECTION.MIN_MARKERS) but no sigils were
   * emitted AND reflectOnTurn returned an empty array (either sampling
   * unavailable or the LLM returned no decisions). The next
   * UserPromptSubmit reads this field, emits a single-line nudge, and
   * clears it to zero.
   *
   * Carries the raw marker count so the nudge can say "N decision
   * markers" rather than a generic "some decisions" message.
   */
  pendingDecisionNudge: number;
  /** Memory IDs already injected this session — prevents repeated surfacing */
  injectedMemoryIds: string[];
  /** Timestamp of last compaction event (ms since epoch) — set by PostCompact hook */
  lastCompactAt: number;
  /** Session ID from the last compaction event */
  lastCompactSessionId: string | null;
  /** Tokens saved in the last compaction */
  lastCompactTokensSaved: number;
  /** Post-compaction briefing effectiveness tracking */
  briefingEffectiveness: {
    /** Whether we're in a post-compact state awaiting first prompt */
    awaitingFirstPrompt: boolean;
    /** Files mentioned in briefing (for measuring if user re-reads them) */
    briefingFiles: string[];
    /** Timestamp when briefing was injected */
    briefingAt: number;
  } | null;
}

/**
 * Factory for a fresh default tracker. Returns a new object every call so
 * mutable containers (objects and arrays) are never shared across trackers.
 * Previously DEFAULTS was a module-level constant and `{ ...DEFAULTS }` only
 * did a shallow spread, causing every tracker loaded from defaults to alias
 * the same `recentlySurfaced`, `sessionErrorCounts`, `injectedMemoryIds`,
 * etc. — a latent state-leak bug that surfaced when a new cooldown map
 * was added in phase 6b.
 */
function defaultTracker(): EditTracker {
  return {
    lastEditPath: null,
    lastEditTime: 0,
    lastEditCursor: null,
    editCountsByFile: {},
    surfacedPitfalls: {},
    toolChain: [],
    successDedup: { lastPattern: null, lastTime: 0 },
    sessionErrorCounts: {},
    sessionId: null,
    recentlySurfaced: {},
    recentWarningFired: {},
    warningBudgetTurnKey: null,
    warningBudgetSequence: 0,
    warningTokensInjectedThisTurn: 0,
    warningCountInjectedThisTurn: 0,
    preflightFired: false,
    complianceNudgeFired: false,
    decisionReminderFired: false,
    pendingDecisionNudge: 0,
    injectedMemoryIds: [],
    lastCompactAt: 0,
    lastCompactSessionId: null,
    lastCompactTokensSaved: 0,
    briefingEffectiveness: null,
  };
}

export function loadTracker(sessionId?: string): EditTracker {
  const path = getTrackerPath(sessionId);
  try {
    if (!existsSync(path)) return defaultTracker();
    const raw = readFileSync(path, 'utf-8');
    return { ...defaultTracker(), ...JSON.parse(raw) };
  } catch {
    return defaultTracker();
  }
}

export function saveTracker(tracker: EditTracker, sessionId?: string): void {
  const path = getTrackerPath(sessionId);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  // Atomic replace prevents TORN writes only. For load→mutate→save
  // sequences use updateTracker, which additionally holds a lock across the
  // whole read-modify-write. Daemon mode is safe either way (SessionCache
  // serialises tracker access in-process).
  writeFileAtomic(path, JSON.stringify(tracker));
}

/** Synchronous sleep without spinning — hooks are short-lived sync processes. */
function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Acquire a mkdir-based lock (atomic on POSIX). Returns true if held.
 *  Stale locks (crashed holder) are stolen after TRACKER_LOCK_STALE_MS.
 *  Fail-open after TRACKER_LOCK_MAX_WAIT_MS: hooks must never hang Claude
 *  Code — an occasional lost update beats a stuck tool call. */
function acquireTrackerLock(lockPath: string): boolean {
  const deadline = Date.now() + TRACKER_LOCK_MAX_WAIT_MS;
  while (Date.now() < deadline) {
    try {
      mkdirSync(lockPath);
      return true;
    } catch {
      try {
        const age = Date.now() - statSync(lockPath).mtimeMs;
        if (age > TRACKER_LOCK_STALE_MS) {
          rmdirSync(lockPath);
          continue; // retry immediately after stealing
        }
      } catch { /* raced with the holder's release — retry */ }
      sleepMs(TRACKER_LOCK_RETRY_MS);
    }
  }
  return false;
}

/**
 * Atomic read-modify-write for the tracker (closes audit H6's lost-update
 * half): two standalone hook processes handling the same tool event both
 * did load→mutate→save, and the second write silently discarded the first
 * mutation. The mutate callback may modify the tracker in place or return
 * a replacement. Returns the saved tracker.
 */
export function updateTracker(
  sessionId: string | undefined,
  mutate: (tracker: EditTracker) => EditTracker | void,
): EditTracker {
  const lockPath = `${getTrackerPath(sessionId)}.lock`;
  const dir = dirname(lockPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const held = acquireTrackerLock(lockPath);
  try {
    const tracker = loadTracker(sessionId);
    const result = mutate(tracker) ?? tracker;
    saveTracker(result, sessionId);
    return result;
  } finally {
    if (held) {
      try { rmdirSync(lockPath); } catch { /* best-effort */ }
    }
  }
}

/** Delete a session's tracker file (called from session-end) */
export function deleteTracker(sessionId: string): boolean {
  const path = getTrackerPath(sessionId);
  try {
    if (existsSync(path)) {
      unlinkSync(path);
      return true;
    }
  } catch { /* best-effort */ }
  return false;
}

/** Remove orphaned tracker files older than maxAgeDays (called from session-start maintenance) */
export function cleanupOrphanTrackers(): number {
  const prefix = `${TRACKER_BASE}-`;
  let cleaned = 0;
  try {
    const dir = waykeepDir();
    const files = readdirSync(dir);
    const maxAgeMs = TRACKER_ORPHAN_MAX_AGE_DAYS * MS_PER_DAY;
    const now = Date.now();
    for (const file of files) {
      if (!file.startsWith(prefix) || !file.endsWith('.json')) continue;
      const fullPath = join(dir, file);
      try {
        const stat = statSync(fullPath);
        if (now - stat.mtimeMs > maxAgeMs) {
          unlinkSync(fullPath);
          cleaned++;
        }
      } catch { /* skip individual file errors */ }
    }
  } catch { /* dir may not exist */ }
  return cleaned;
}
