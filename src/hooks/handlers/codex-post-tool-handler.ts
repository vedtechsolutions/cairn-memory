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
import type { PostToolUseInput, PostToolUseFailureInput } from '../shared/hook-io.js';
import type { CachedHookContext } from '../shared/db-client.js';
import { findRolloutToolRecord, type RolloutToolRecord } from '../shared/rollout-lookup.js';
import { handleErrorLearning } from './error-learning-handler.js';
import { handleSuccessTracker } from './success-tracker-handler.js';
import { loadTracker, saveTracker } from '../shared/edit-tracker.js';
import { ROLLOUT_LOOKUP } from '../../constants/index.js';

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
 *  second, unknown otherwise. Never infers success from a missing record. */
export function demuxOutcome(
  input: Pick<PostToolUseInput, 'tool_name' | 'tool_response'>,
  record: RolloutToolRecord | null,
): DemuxOutcome {
  if (record) {
    return {
      failed: record.status === 'failed',
      exitCode: record.exitCode,
      errorText: record.outputText,
    };
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

export async function handleCodexPostTool(
  input: PostToolUseInput,
  client: CachedHookContext,
): Promise<CodexPostToolResult> {
  if (!DEMUX_TOOLS.includes(input.tool_name)) {
    return { output: null, action: 'skipped', exitCode: null };
  }

  const record = await findRolloutToolRecord(input.transcript_path, input.tool_use_id);
  const { failed, exitCode, errorText } = demuxOutcome(input, record);

  if (failed === true) {
    const failure: PostToolUseFailureInput = {
      ...input,
      // Exit-code preamble keeps the text non-empty (error-learning skips
      // empty errors) and gives the classifier a stable anchor even when
      // the command produced no output.
      error: `Exit code ${exitCode ?? 'unknown'}\n${errorText}`.trim(),
      exit_code: exitCode ?? undefined,
    };
    await handleErrorLearning(failure, client);
    return { output: null, action: 'error-routed', exitCode };
  }

  if (failed === false) {
    await handleSuccessTracker(input, client);
    return { output: null, action: 'success-routed', exitCode };
  }

  // Outcome unknown — keep the tool chain continuous without asserting an
  // outcome (undefined success is falsy at every consumer).
  try {
    const tracker = client.cache?.getTracker(input.session_id) ?? loadTracker(input.session_id);
    tracker.toolChain.push({ tool: input.tool_name, timestamp: Date.now() });
    if (tracker.toolChain.length > 20) {
      tracker.toolChain = tracker.toolChain.slice(-20);
    }
    if (client.cache) {
      client.cache.setTracker(input.session_id, tracker);
    } else {
      saveTracker(tracker, input.session_id);
    }
  } catch { /* best-effort */ }
  return { output: null, action: 'unknown-outcome', exitCode: null };
}
