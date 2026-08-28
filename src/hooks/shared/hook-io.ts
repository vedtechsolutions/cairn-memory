/**
 * Standard I/O helpers for Claude Code hooks.
 * Hooks receive JSON via stdin and output via stdout/stderr.
 */
import { readFileSync } from 'node:fs';

/** Read and parse JSON from stdin (synchronous — hooks are short-lived).
 *  Falls back to fd 0 if /dev/stdin device is unavailable (ENXIO). */
export function readStdinJson<T = Record<string, unknown>>(): T {
  let raw: string;
  try {
    raw = readFileSync('/dev/stdin', 'utf-8');
  } catch {
    raw = readFileSync(0, 'utf-8');
  }
  return JSON.parse(raw) as T;
}

/** Common hook input fields (present on all hooks) */
export interface HookInput {
  session_id: string;
  transcript_path: string;
  cwd: string;
  hook_event_name?: string;
  permission_mode?: string;
  client_name?: string;
  client_version?: string;
  client_installation_id?: string;
  client_metadata?: {
    name?: string;
    version?: string;
    installation_id?: string;
    [key: string]: unknown;
  };
  agent_id?: string;
  agent_type?: string;
}

/** Shared fields carried by tool lifecycle events when the client provides them. */
export interface ToolHookInput extends HookInput {
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_use_id?: string;
  duration_ms?: number;
}

/** SessionStart-specific input. `type` is optional on the wire — Claude
 *  Code omits it on post-compaction restarts, and the handler infers the
 *  session type from tracker/snapshot evidence when absent. */
export interface SessionStartInput extends HookInput {
  type?: 'startup' | 'compact' | 'resume' | 'clear';
}

/** PreCompact-specific input */
export interface PreCompactInput extends HookInput {
  trigger: 'manual' | 'auto';
  custom_instructions?: string;
}

/** PostCompact-specific input */
export interface PostCompactInput extends HookInput {
  trigger: 'manual' | 'auto';
  tokens_saved: number;
}

/** SubagentStart-specific input */
export interface SubagentStartInput extends HookInput {
  agent_id: string;
  agent_type: string;
}

/** SessionEnd-specific input */
export interface SessionEndInput extends HookInput {
  reason: 'clear' | 'logout' | 'prompt_input_exit' | 'other';
}

/** UserPromptSubmit input */
export interface UserPromptSubmitInput extends HookInput {
  prompt: string;
}

/** PreToolUse input */
export interface PreToolUseInput extends ToolHookInput {}

/** PostToolUseFailure input */
export interface PostToolUseFailureInput extends ToolHookInput {
  error: string;
  is_interrupt?: boolean;
  interrupted?: boolean;
  timed_out?: boolean;
  exit_code?: number;
  exit_status?: number;
  signal?: string;
}

/** FileChanged wire input, with optional correlation/delivery metadata. */
export interface FileChangedInput extends HookInput {
  file_path?: string;
  tool_use_id?: string;
  delivery_fingerprint?: string;
}

/** Stop input — end of turn */
export interface StopInput extends HookInput {
  stop_hook_active: boolean;
  last_assistant_message: string;
}

/** SubagentStop input — subagent finished */
export interface SubagentStopInput extends HookInput {
  agent_id: string;
  agent_type: string;
  agent_transcript_path?: string;
  last_assistant_message?: string;
}

/** PostToolUse input */
export interface PostToolUseInput extends ToolHookInput {
  tool_response: unknown;
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
