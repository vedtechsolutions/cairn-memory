/**
 * Hook event payloads — the "Waykeep hook event", i.e. the NORMALIZED shape
 * handlers may rely on, not any one agent's wire dialect.
 *
 * Two layers, deliberately separate:
 * - `RawHookPayload` is what a relay delivers (daemon socket body or
 *   direct-node stdin) BEFORE normalization.
 * - The per-event interfaces (and the `WaykeepHookEvent` union) describe the
 *   payload AFTER normalization: declared client identity stamped, agent
 *   field dialects reconciled (e.g. Codex's SessionStart `source` mapped
 *   onto `type`).
 *
 * Tolerant-reader rule (the extension bag, as behavior rather than an
 * index signature): agents attach extra top-level fields — `turn_id` and
 * `model` began as Codex extensions — and normalization PRESERVES unknown
 * fields. Consumers must ignore fields they do not know; an index
 * signature is intentionally not used so known-field typos still fail to
 * compile inside implementations.
 *
 * `transcript_path` is `string | null` and its FORMAT is agent-specific
 * (Claude Code: session-transcript JSONL; Codex: rollout JSONL) — never
 * parse it without knowing the client.
 */

/** A relay-delivered payload before normalization. */
export interface RawHookPayload {
  hook_event_name?: string;
  [key: string]: unknown;
}

/** Fields common to every normalized hook event. */
export interface HookEventBase {
  session_id: string;
  /** Agent-format transcript/rollout path; null when the agent has none. */
  transcript_path: string | null;
  cwd: string;
  hook_event_name?: string;
  /** Declared client identity (dispatch/provenance, NOT authentication). */
  client_name?: string;
  client_version?: string;
  client_installation_id?: string;
  client_metadata?: {
    name?: string;
    version?: string;
    installation_id?: string;
    [key: string]: unknown;
  };
  permission_mode?: string;
  /** Turn-scoped correlation id (originated as a Codex extension). */
  turn_id?: string;
  model?: string;
  agent_id?: string;
  agent_type?: string;
}

/** Shared fields of tool lifecycle events. */
export interface ToolHookEvent extends HookEventBase {
  tool_name: string;
  /** Arbitrary JSON — shape is per (agent, tool); never assume fields. */
  tool_input: Record<string, unknown>;
  tool_use_id?: string;
  duration_ms?: number;
}

export interface SessionStartEvent extends HookEventBase {
  /** Session origin. Normalization fills this from an agent's `source`
   *  field for declared non-Claude clients; absence is legal and consumers
   *  must infer or default. */
  type?: 'startup' | 'compact' | 'resume' | 'clear';
  source?: string;
}

export interface UserPromptSubmitEvent extends HookEventBase {
  prompt: string;
}

export interface PreToolUseEvent extends ToolHookEvent {}

export interface PostToolUseEvent extends ToolHookEvent {
  tool_response: unknown;
}

export interface PostToolUseFailureEvent extends ToolHookEvent {
  error: string;
  is_interrupt?: boolean;
  interrupted?: boolean;
  timed_out?: boolean;
  exit_code?: number;
  exit_status?: number;
  signal?: string;
}

export interface StopEvent extends HookEventBase {
  stop_hook_active: boolean;
  /** Nullable/absent in the wild: Codex 0.150.1 emits null when the turn
   *  ended without assistant text. Consumers must guard. */
  last_assistant_message?: string | null;
}

export interface SubagentStartEvent extends HookEventBase {
  agent_id: string;
  agent_type: string;
}

export interface SubagentStopEvent extends HookEventBase {
  agent_id: string;
  agent_type: string;
  agent_transcript_path?: string;
  last_assistant_message?: string;
}

export interface PreCompactEvent extends HookEventBase {
  trigger: 'manual' | 'auto';
  custom_instructions?: string;
}

export interface PostCompactEvent extends HookEventBase {
  trigger: 'manual' | 'auto';
  /** Absent on engines that do not report it (Codex 0.150.1). */
  tokens_saved?: number;
}

export interface SessionEndEvent extends HookEventBase {
  reason: 'clear' | 'logout' | 'prompt_input_exit' | 'other';
}

export interface FileChangedEvent extends HookEventBase {
  file_path?: string;
  tool_use_id?: string;
  delivery_fingerprint?: string;
}

/**
 * The normalized hook event as a discriminated union: `hook_event_name`
 * is REQUIRED here — a payload without it is a RawHookPayload, not a
 * WaykeepHookEvent. (Core interfaces keep the field optional for legacy
 * tolerance; the union is the forward contract integrators code against.)
 *
 * Scope: the union covers the events Waykeep WIRES, not every event an
 * engine can emit (Codex 0.150.x also has PermissionRequest, Interrupt,
 * …). An unlisted event arrives as a RawHookPayload; tolerate it.
 */
export type WaykeepHookEvent =
  | (SessionStartEvent & { hook_event_name: 'SessionStart' })
  | (UserPromptSubmitEvent & { hook_event_name: 'UserPromptSubmit' })
  | (PreToolUseEvent & { hook_event_name: 'PreToolUse' })
  | (PostToolUseEvent & { hook_event_name: 'PostToolUse' })
  | (PostToolUseFailureEvent & { hook_event_name: 'PostToolUseFailure' })
  | (StopEvent & { hook_event_name: 'Stop' })
  | (SubagentStartEvent & { hook_event_name: 'SubagentStart' })
  | (SubagentStopEvent & { hook_event_name: 'SubagentStop' })
  | (PreCompactEvent & { hook_event_name: 'PreCompact' })
  | (PostCompactEvent & { hook_event_name: 'PostCompact' })
  | (SessionEndEvent & { hook_event_name: 'SessionEnd' })
  | (FileChangedEvent & { hook_event_name: 'FileChanged' });

/**
 * @deprecated Phase-B compat alias for the renamed {@link WaykeepHookEvent}.
 * Kept so consumers pinned to the pre-rename name keep compiling; removed with
 * the legacy namespace at Phase D.
 */
export type CairnHookEvent = WaykeepHookEvent;
