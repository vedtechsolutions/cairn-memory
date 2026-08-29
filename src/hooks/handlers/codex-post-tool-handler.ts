/**
 * PostToolUse demux — one hook event, ground-truth routed. Serves the
 * canonical /post-tool route and its deprecated /codex-post-tool alias.
 *
 * Lookup-signal clients (Codex) fire PostToolUse for successes AND
 * failures with no failure signal in the payload, so this handler asks
 * the event's client ADAPTER for the ground-truth outcome
 * (resolveToolOutcome — Codex: rollout record joined on tool_use_id) and
 * routes: failed → error-learning (synthesized PostToolUseFailureInput),
 * completed → success-tracker, no match → outcome-unknown tool event
 * (success stays undefined — it can never count as a success). Mirrors
 * Claude's mutually-exclusive PostToolUse/PostToolUseFailure split.
 */
import type Database from 'better-sqlite3';
import type { ToolOutcome } from '@cairn/contract';
import type { PostToolUseInput, PostToolUseFailureInput } from '../shared/hook-io.js';
import type { CachedHookContext } from '../shared/db-client.js';
import { adapterFor } from '../shared/client-adapter.js';
import { findRolloutToolRecord } from '../shared/rollout-lookup.js';
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
  record: ToolOutcome | null,
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

/**
 * ATOMIC claim of a tool_use_id. A check-then-mark pair is not enough:
 * a hook invocation can pass the seen-check, await its resolver, and
 * resume AFTER a concurrent tailer invocation marked and routed — both
 * would route (reproduced live: two 'success-routed' for one id). The
 * INSERT OR IGNORE makes exactly one caller win; only the winner may
 * dispatch. No id (or a DB error) claims true — dedup is an optimization
 * and its failure must never drop capture.
 */
function claimTool(db: Database.Database, toolUseId: string | undefined): boolean {
  if (!toolUseId) return true;
  try {
    const result = db.prepare(
      'INSERT OR IGNORE INTO maintenance_meta (key, value) VALUES (?, ?)',
    ).run(`codex_seen:${toolUseId}`, new Date().toISOString());
    return result.changes > 0;
  } catch { return true; }
}

export async function handleCodexPostTool(
  input: PostToolUseInput,
  client: CachedHookContext,
  /** Pre-resolved outcome (the tailer already parsed the record it is
   *  routing — re-looking it up in a tail window the tailer may have
   *  outrun would silently demote it to unknown). undefined = resolve
   *  via the event's client adapter. */
  preResolved?: ToolOutcome | null,
): Promise<CodexPostToolResult> {
  if (!DEMUX_TOOLS.includes(input.tool_name)) {
    return { output: null, action: 'skipped', exitCode: null };
  }

  // IDEMPOTENCY: once an outcome has been routed for this tool_use_id,
  // every further delivery is dropped — a relay status-fallback retry,
  // the C relay's bad-status re-exec, or a tailer/hook race must never
  // double-count an error (escalation, investigation chains) or success.
  if (input.tool_use_id && isToolSeen(client.db, input.tool_use_id)) {
    return { output: null, action: 'skipped', exitCode: null };
  }

  // Ground truth comes from the ADAPTER (the extension seam's promise):
  // a lookup-signal client resolves from its own state. A caller with NO
  // resolver (undeclared/legacy delivery straight to this route) gets the
  // pre-seam behavior — direct rollout lookup — rather than a silent
  // degradation to unknown: this route is lookup-based by definition.
  const resolver = adapterFor(input).resolveToolOutcome;
  const record = preResolved !== undefined
    ? preResolved
    : resolver
      ? await resolver(input)
      : await findRolloutToolRecord(input.transcript_path, input.tool_use_id);
  const { failed, exitCode, errorText } = demuxOutcome(input, record);

  if (failed === true) {
    // Atomically claim BEFORE dispatching: the loser of a hook/tailer
    // race exits here instead of double-counting the error (escalation
    // firing early, a duplicate investigation attempt). A lost record on
    // a throw after winning is the better failure — routing is already
    // best-effort.
    if (!claimTool(client.db, input.tool_use_id)) {
      return { output: null, action: 'skipped', exitCode: null };
    }
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
    if (!claimTool(client.db, input.tool_use_id)) {
      return { output: null, action: 'skipped', exitCode: null };
    }
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
