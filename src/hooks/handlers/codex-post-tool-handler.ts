/**
 * Codex PostToolUse demux — one hook event, ground-truth routed.
 *
 * Codex fires PostToolUse for successes AND failures with no failure signal
 * in the payload, so this handler looks up the rollout record joined on
 * tool_use_id and routes: failed → error-learning (synthesized
 * PostToolUseFailureInput), completed → success-tracker, no match →
 * outcome-unknown tool event (success stays undefined — it can never count
 * as a success). Mirrors Claude's mutually-exclusive
 * PostToolUse/PostToolUseFailure split.
 */
import type Database from 'better-sqlite3';
import type { PostToolUseInput, PostToolUseFailureInput } from '../shared/hook-io.js';
import type { CachedHookContext } from '../shared/db-client.js';
import { findRolloutToolRecord, type RolloutToolRecord } from '../shared/rollout-lookup.js';
import { handleErrorLearning } from './error-learning-handler.js';
import { handleSuccessTracker } from './success-tracker-handler.js';
import { loadTracker, saveTracker } from '../shared/edit-tracker.js';
import { LIMITS, ROLLOUT_LOOKUP } from '../../constants/index.js';

export interface CodexPostToolResult {
  output: null;
  action: 'error-routed' | 'success-routed' | 'unknown-outcome' | 'skipped';
  exitCode: number | null;
}

const DEMUX_TOOLS = ['Bash', 'apply_patch'];

/** apply_patch tool_response embeds its outcome as literal text — the
 *  fallback when no rollout record matched (verified shape, addendum 2). */
const APPLY_PATCH_EXIT_RE = /^Exit code:\s*(-?\d+)/;

export interface DemuxOutcome {
  /** true = failed, false = succeeded, null = outcome unknown. */
  failed: boolean | null;
  exitCode: number | null;
  errorText: string;
}

/** Pure outcome decision: rollout record first, apply_patch text fallback
 *  second, unknown otherwise. FAIL-SAFE in both directions: a missing
 *  record is never success, and only the literal status "completed" (with
 *  a zero/absent exit code) is — a novel status a future Codex might add
 *  routes to unknown, and a non-zero exit code routes to failure whatever
 *  the status says. */
export function demuxOutcome(
  input: Pick<PostToolUseInput, 'tool_name' | 'tool_response'>,
  record: RolloutToolRecord | null,
): DemuxOutcome {
  if (record) {
    if (record.status === 'failed' || (record.exitCode !== null && record.exitCode !== 0)) {
      return { failed: true, exitCode: record.exitCode, errorText: record.outputText };
    }
    if (record.status === 'completed') {
      return { failed: false, exitCode: record.exitCode, errorText: record.outputText };
    }
    return { failed: null, exitCode: record.exitCode, errorText: '' };
  }
  if (input.tool_name === 'apply_patch') {
    const match = APPLY_PATCH_EXIT_RE.exec(String(input.tool_response ?? ''));
    if (match) {
      const exitCode = Number(match[1]);
      return {
        failed: exitCode !== 0,
        exitCode,
        errorText: String(input.tool_response).slice(0, ROLLOUT_LOOKUP.OUTPUT_MAX_CHARS),
      };
    }
  }
  return { failed: null, exitCode: null, errorText: '' };
}

/** Hook-vs-tailer dedup markers in maintenance_meta (value = ISO timestamp,
 *  pruned by runMaintenance after MARKER_TTL_MS — maintenance runs on every
 *  hosting mode, the tailer only in the standalone daemon). */
export function isToolSeen(db: Database.Database, toolUseId: string): boolean {
  try {
    return db.prepare(
      'SELECT 1 FROM maintenance_meta WHERE key = ?',
    ).get(`codex_seen:${toolUseId}`) !== undefined;
  } catch { return false; }
}

function markToolSeen(db: Database.Database, toolUseId: string | undefined): void {
  if (!toolUseId) return;
  try {
    db.prepare(
      'INSERT OR REPLACE INTO maintenance_meta (key, value) VALUES (?, ?)',
    ).run(`codex_seen:${toolUseId}`, new Date().toISOString());
  } catch { /* best-effort */ }
}

export async function handleCodexPostTool(
  input: PostToolUseInput,
  client: CachedHookContext,
  /** Pre-resolved rollout record (the tailer already parsed the line it is
   *  routing — re-looking it up in a tail window the tailer may have
   *  outrun would silently demote it to unknown). undefined = look up. */
  preResolved?: RolloutToolRecord | null,
): Promise<CodexPostToolResult> {
  if (!DEMUX_TOOLS.includes(input.tool_name)) {
    return { output: null, action: 'skipped', exitCode: null };
  }

  const record = preResolved !== undefined
    ? preResolved
    : await findRolloutToolRecord(input.transcript_path, input.tool_use_id);
  const { failed, exitCode, errorText } = demuxOutcome(input, record);

  if (failed === true) {
    // Claim the id BEFORE dispatching: a tailer tick landing mid-routing
    // would otherwise double-count the error (escalation fires early, the
    // investigation chain gets a duplicate attempt). A lost record on a
    // throw is the better failure — routing is already best-effort.
    markToolSeen(client.db, input.tool_use_id);
    // The REAL error text must be the first line: the classifier derives its
    // errorKey from it, and a fixed "Exit code N" preamble would collapse
    // every codex failure into one key — dedup would then suppress learning
    // after the first. No exit-code trailer either: a lowercase "(exit code
    // N)" matches LEARNABLE_ERROR_PATTERNS' process pattern and would make
    // EVERY failure "learnable", storing junk pitfalls distilled from
    // arbitrary output (measured: 60/105 real failures vs 17 content-driven).
    // The exit code travels structurally in exit_code; the bare text form is
    // used only when the command produced no output at all (error-learning
    // skips empty errors).
    const trimmedError = errorText.trim();
    const failure: PostToolUseFailureInput = {
      ...input,
      error: trimmedError || `Exit code ${exitCode ?? 'unknown'}`,
      exit_code: exitCode ?? undefined,
    };
    await handleErrorLearning(failure, client);
    return { output: null, action: 'error-routed', exitCode };
  }

  if (failed === false) {
    markToolSeen(client.db, input.tool_use_id);
    // DEMUX_TOOLS is a subset of success-tracker's gate (D8 landed), so
    // every confirmed success here is tracked.
    await handleSuccessTracker(input, client);
    return { output: null, action: 'success-routed', exitCode };
  }

  // Outcome unknown — keep the tool chain continuous without asserting an
  // outcome (undefined success is falsy at every consumer). Deliberately
  // NOT marked seen: the tailer may later find the rollout record the hook
  // raced past and route it properly (a routed error beats a slightly
  // duplicated unknown tool event).
  try {
    const tracker = client.cache?.getTracker(input.session_id) ?? loadTracker(input.session_id);
    tracker.toolChain.push({ tool: input.tool_name, timestamp: Date.now() });
    if (tracker.toolChain.length > LIMITS.TOOL_CHAIN_MAX) {
      tracker.toolChain = tracker.toolChain.slice(-LIMITS.TOOL_CHAIN_MAX);
    }
    if (client.cache) {
      client.cache.setTracker(input.session_id, tracker);
    } else {
      saveTracker(tracker, input.session_id);
    }
  } catch { /* best-effort */ }
  return { output: null, action: 'unknown-outcome', exitCode: null };
}
