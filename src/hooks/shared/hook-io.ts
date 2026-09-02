/**
 * Standard I/O helpers for agent hooks, plus the event types — the TYPES
 * are the contract's (see waykeep-contract hook-events), re-exported under
 * the codebase's established `*Input` names so import sites stay stable;
 * the stdio FUNCTIONS bind to process stdin/stdout and stay internal.
 */
import { readFileSync } from 'node:fs';

import { CLIENT_ENV_VAR } from '../../constants/clients.js';
import { normalizeHookInput } from './client-adapter.js';

export type {
  RawHookPayload,
  WaykeepHookEvent,
  HookEventBase as HookInput,
  ToolHookEvent as ToolHookInput,
  SessionStartEvent as SessionStartInput,
  UserPromptSubmitEvent as UserPromptSubmitInput,
  PreToolUseEvent as PreToolUseInput,
  PostToolUseEvent as PostToolUseInput,
  PostToolUseFailureEvent as PostToolUseFailureInput,
  StopEvent as StopInput,
  SubagentStartEvent as SubagentStartInput,
  SubagentStopEvent as SubagentStopInput,
  PreCompactEvent as PreCompactInput,
  PostCompactEvent as PostCompactInput,
  SessionEndEvent as SessionEndInput,
  FileChangedEvent as FileChangedInput,
} from 'waykeep-contract';

/** Read and parse JSON from stdin (synchronous — hooks are short-lived).
 *  Falls back to fd 0 if /dev/stdin device is unavailable (ENXIO).
 *  Direct-node fallback path: client identity arrives via env (set by the
 *  relay), so normalization happens here; the daemon path normalizes in
 *  hook-socket from the request header instead. */
export function readStdinJson<T = Record<string, unknown>>(): T {
  let raw: string;
  try {
    raw = readFileSync('/dev/stdin', 'utf-8');
  } catch {
    raw = readFileSync(0, 'utf-8');
  }
  const parsed = JSON.parse(raw) as T;
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    normalizeHookInput(parsed as Record<string, unknown>, process.env[CLIENT_ENV_VAR]);
  }
  return parsed;
}

/** Output helpers for hooks that support additionalContext */
export function outputAdditionalContext(hookEventName: string, context: string): void {
  const output = JSON.stringify({
    hookSpecificOutput: {
      hookEventName,
      additionalContext: context,
    },
  });
  process.stdout.write(output);
}

/** Output for PreToolUse hooks (allow + optional context) */
export function outputPreToolUseAllow(context?: string): void {
  const output: Record<string, unknown> = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      ...(context ? { additionalContext: context } : {}),
    },
  };
  process.stdout.write(JSON.stringify(output));
}
