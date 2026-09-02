/**
 * The extension seam: one client adapter per agent, registered by
 * canonical name. Adding an agent to Waykeep means implementing this
 * interface — nothing else in the pipeline may branch on a client name.
 *
 * Adapters ship IN-TREE (reviewed like any code); there is no runtime
 * plugin loading — third-party code never runs behind the daemon socket.
 */
import type { RawHookPayload, PostToolUseEvent } from './hook-events.js';

/**
 * Ground-truth outcome of a tool execution, however the adapter obtains
 * it (a distinct failure event, a state lookup, output parsing).
 * `status` is an open set; consumers must treat unknown statuses as
 * neither success nor failure.
 */
export interface ToolOutcome {
  status: string;
  exitCode: number | null;
  outputText: string;
  timedOut?: boolean;
  interrupted?: boolean;
  signal?: string | null;
}

/** What a client's hooks engine and session model support — the flags
 *  that replace scattered per-client branches in the pipeline. */
export interface AdapterCapabilities {
  /** How tool-failure truth arrives: 'event' = the agent emits a distinct
   *  failure event; 'lookup' = the adapter resolves outcomes from agent
   *  state after a unified post-tool event. Learning strictness derives
   *  from this ('lookup' implies whole-output error text, so lesson
   *  distillation must be strict). */
  toolFailureSignal: 'event' | 'lookup';
  /** 'plain' = the agent injects plain hook stdout as context;
   *  'envelope' = only the hookSpecificOutput JSON contract is injected. */
  contextOutput: 'plain' | 'envelope';
  /** Whether PreToolUse responses may carry permissionDecision (some
   *  engines reject an explicit "allow"). */
  emitsPermissionDecision: boolean;
  /** Whether shared context injections need the cross-agent framing line
   *  (non-primary agents have been observed adopting injected plan state
   *  as their own tasking). */
  crossAgentFraming: boolean;
  /** Whether decision-sigil nudges are actionable for this client (they
   *  require a reflection path the client can actually run). */
  sigilNudges: boolean;
}

/**
 * A client adapter. Identity note: adapters are selected by the DECLARED
 * client identity (relay flag → header/env) — a payload-asserted
 * client_name alone must never activate an adapter's normalization.
 */
export interface ClientAdapter {
  /** Canonical client name — an open set; unknown names are valid. */
  readonly name: string;
  readonly capabilities: AdapterCapabilities;
  /** Reconcile this agent's wire dialect into the normalized event, in
   *  place. `declared` is the wiring-declared identity for this delivery;
   *  implementations must gate dialect mapping on it. */
  normalizeInput(input: RawHookPayload, declared: string | undefined): void;
  /** Wrap plain context for injection per this agent's contract. */
  wrapContextOutput(hookEventName: string, output: string): string;
  /** Parse this agent's transcript format into the caller's snapshot
   *  shape; absent when the format is not parseable by Waykeep. (A semantic
   *  method rather than a format enum — a third format is a new
   *  implementation, not a new enum value.) */
  readTranscriptSnapshot?(transcriptPath: string | null): unknown;
  /** Resolve ground-truth tool outcome (lookup-signal agents). */
  resolveToolOutcome?(event: PostToolUseEvent): Promise<ToolOutcome | null>;
}

/**
 * Lifecycle contributions an adapter makes OUTSIDE the hot hook path:
 * installer detection/wiring and long-running daemon workers (e.g. a
 * state tailer). Registered separately from the hot-path adapter so the
 * relay/daemon dispatch never loads installer or worker code.
 */
export interface ClientAdapterLifecycle {
  readonly name: string;
  /** Is this agent installed on the machine? */
  detectInstall?(): boolean;
  /** Generate this agent's hook wiring for a resolved relay command. */
  hooksConfig?(relayCommand: string): unknown;
  /** Long-running daemon workers; each returns a stop handle. */
  daemonWorkers?: ReadonlyArray<(context: unknown) => { stop(): void }>;
}
