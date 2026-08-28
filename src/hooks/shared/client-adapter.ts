/**
 * Payload normalization for multi-agent hook clients.
 *
 * Claude Code is the native payload dialect. Codex emits deliberately
 * wire-compatible payloads with small deltas; this adapter reconciles them
 * in ONE place for both transport paths — the daemon socket (header-borne
 * client identity) and the direct-node fallback (env-borne identity).
 */
import { CLIENT_CLAUDE, CLIENT_CODEX, CLIENT_UNKNOWN } from '../../constants/clients.js';

/** Codex SessionStart source values ([TAG] events/session_start.rs). */
const SESSION_SOURCE_VALUES = ['startup', 'resume', 'clear', 'compact'];

/**
 * Stamp declared client identity and reconcile field-name deltas, in place.
 * Declared identity (relay flag → header/env) is authoritative: it overrides
 * any client_name the payload carries — identity is wiring-declared, never
 * payload-asserted.
 */
export function normalizeHookInput(
  input: Record<string, unknown>,
  clientName?: string,
): Record<string, unknown> {
  if (clientName) {
    input.client_name = clientName;
  }
  // SessionStart dialect: Codex names the session-origin field `source`
  // where Cairn's handlers read `type`. Gated to declared NON-Claude
  // clients: Claude Code also sends `source`, but its sessionType is
  // deliberately derived by tracker/snapshot inference — mapping it here
  // would be an unreviewed Claude behavior change. Explicit `type` wins.
  if (
    clientName && clientName !== CLIENT_CLAUDE &&
    input.type === undefined &&
    input.hook_event_name === 'SessionStart' &&
    typeof input.source === 'string' &&
    SESSION_SOURCE_VALUES.includes(input.source)
  ) {
    input.type = input.source;
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
 * Wrap plain context output in the `hookSpecificOutput` envelope for clients
 * whose hooks engine only injects the JSON contract (Codex). Claude Code
 * injects plain SessionStart/UserPromptSubmit stdout directly, so Claude
 * output passes through unchanged.
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
  if (!output || !isCodexClient(input)) return output;
  return JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext: output } });
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
