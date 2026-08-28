/**
 * Client-adapter registry — the core side of the contract's extension
 * seam. One adapter per agent; NOTHING else in the pipeline branches on a
 * client name (the capability record replaces the branches that used to).
 *
 * Adapter selection follows DECLARED identity: normalization maps a
 * dialect only for the delivery's wiring-declared client, never for a
 * payload-asserted client_name (same-UID provenance model — see the
 * contract's clients module).
 *
 * Lifecycle contributions (installers, daemon workers) register in
 * src/adapters/ — separate on purpose, so this hot-path module never
 * loads installer or worker code.
 */
import type { ClientAdapter, AdapterCapabilities, RawHookPayload } from '@cairn/contract';
import { CLIENT_CLAUDE, CLIENT_CODEX, CLIENT_UNKNOWN } from '../../constants/clients.js';
import { parseTranscript, emptySnapshot, type TranscriptSnapshot } from './transcript-parser.js';

/** Codex SessionStart source values ([TAG] events/session_start.rs). */
const SESSION_SOURCE_VALUES = ['startup', 'resume', 'clear', 'compact'];

const CLAUDE_CAPABILITIES: AdapterCapabilities = {
  toolFailureSignal: 'event',
  contextOutput: 'plain',
  emitsPermissionDecision: true,
  crossAgentFraming: false,
  sigilNudges: true,
};

const CODEX_CAPABILITIES: AdapterCapabilities = {
  toolFailureSignal: 'lookup',
  contextOutput: 'envelope',
  // Codex 0.150.1 rejects permissionDecision:"allow" from PreToolUse hooks
  // (observed live: "unsupported permissionDecision:allow" hook failure).
  emitsPermissionDecision: false,
  crossAgentFraming: true,
  // Reflection can never run under Codex (no MCP sampling), so nudging
  // for sigils it cannot act on would fire on every decision-bearing turn.
  sigilNudges: false,
};

const claudeAdapter: ClientAdapter = {
  name: CLIENT_CLAUDE,
  capabilities: CLAUDE_CAPABILITIES,
  normalizeInput: () => { /* Claude is the native dialect — no mapping */ },
  wrapContextOutput: (_event, output) => output,
  readTranscriptSnapshot: (path) => parseTranscript(path),
};

const codexAdapter: ClientAdapter = {
  name: CLIENT_CODEX,
  capabilities: CODEX_CAPABILITIES,
  // SessionStart dialect: Codex names the session-origin field `source`
  // where Cairn's handlers read `type`. Gated on DECLARED identity:
  // Claude Code also sends `source`, but its sessionType is deliberately
  // derived by tracker/snapshot inference — mapping it there would be an
  // unreviewed Claude behavior change. Explicit `type` wins.
  normalizeInput: (input: RawHookPayload, declared) => {
    if (declared !== CLIENT_CODEX) return;
    if (
      input.type === undefined &&
      input.hook_event_name === 'SessionStart' &&
      typeof input.source === 'string' &&
      SESSION_SOURCE_VALUES.includes(input.source)
    ) {
      input.type = input.source;
    }
  },
  wrapContextOutput: (hookEventName, output) =>
    JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext: output } }),
  // No readTranscriptSnapshot: transcript_path is a rollout JSONL the
  // Claude-format parser cannot read (rollout parser is a recorded
  // follow-up); callers degrade to an empty snapshot.
};

const registry = new Map<string, ClientAdapter>([
  [CLIENT_CLAUDE, claudeAdapter],
  [CLIENT_CODEX, codexAdapter],
]);

/** Register an additional in-tree adapter (the extension seam). */
export function registerClientAdapter(adapter: ClientAdapter): void {
  registry.set(adapter.name, adapter);
}

/** The adapter for a normalized event. Unknown or absent client names get
 *  Claude's adapter — the native-dialect default every legacy path used. */
export function adapterFor(input: { client_name?: string }): ClientAdapter {
  return registry.get(input.client_name ?? CLIENT_CLAUDE) ?? claudeAdapter;
}

export function capabilitiesOf(input: { client_name?: string }): AdapterCapabilities {
  return adapterFor(input).capabilities;
}

/**
 * Stamp declared client identity and reconcile field-name deltas, in
 * place. Declared identity (relay flag → header/env) is authoritative: it
 * overrides any client_name the payload carries, and dialect mapping runs
 * only for the DECLARED client's adapter.
 */
export function normalizeHookInput(
  input: Record<string, unknown>,
  clientName?: string,
): Record<string, unknown> {
  if (clientName) {
    input.client_name = clientName;
  }
  if (clientName) {
    registry.get(clientName)?.normalizeInput(input, clientName);
  }
  return input;
}

/** True when the event was declared as coming from a Codex client. */
export function isCodexClient(input: { client_name?: string }): boolean {
  return input.client_name === CLIENT_CODEX;
}

/** Canonical origin-client for a hook-path memory write (schema v29).
 *  No declared client means a legacy/Claude wiring — claude. */
export function originClientOf(input: { client_name?: string }): string {
  if (!input.client_name) return CLIENT_CLAUDE;
  return deriveOriginClient(input.client_name);
}

/**
 * Wrap plain context output per the client's injection contract: envelope
 * clients (Codex) get the hookSpecificOutput JSON; plain clients pass
 * through unchanged.
 */
export function wrapContextOutput(
  input: { client_name?: string },
  hookEventName: string,
  output: string,
): string;
export function wrapContextOutput(
  input: { client_name?: string },
  hookEventName: string,
  output: string | null,
): string | null;
export function wrapContextOutput(
  input: { client_name?: string },
  hookEventName: string,
  output: string | null,
): string | null {
  if (!output) return output;
  const adapter = adapterFor(input);
  if (adapter.capabilities.contextOutput === 'plain') return output;
  return adapter.wrapContextOutput(hookEventName, output);
}

/** Parse the event's transcript per its client's format, or an empty
 *  snapshot when the client has no parseable transcript format. */
export function readTranscriptSnapshotFor(
  input: { client_name?: string },
  transcriptPath: string | null,
): TranscriptSnapshot {
  const reader = adapterFor(input).readTranscriptSnapshot;
  if (!reader) return emptySnapshot();
  return reader(transcriptPath) as TranscriptSnapshot;
}

/** Map a client name (MCP initialize clientInfo, or a hook-declared
 *  client_name) to a canonical origin-client value. */
export function deriveOriginClient(clientInfoName: string | undefined): string {
  if (!clientInfoName) return CLIENT_UNKNOWN;
  const name = clientInfoName.toLowerCase();
  if (name.includes('codex')) return CLIENT_CODEX;
  if (name.includes('claude')) return CLIENT_CLAUDE;
  return CLIENT_UNKNOWN;
}
