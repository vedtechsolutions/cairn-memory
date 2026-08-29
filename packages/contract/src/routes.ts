/**
 * Hook-socket routes and their response semantics. An integrator cannot
 * generate hook wiring from names alone — whether a hook must WAIT for
 * the response is part of the contract:
 *
 * - `sync`: the caller waits; the 200 response body is meaningful — either
 *   injected context or a decision. NOTE the body of a `200 text/plain`
 *   may itself be a serialized agent-JSON envelope (hookSpecificOutput);
 *   transport content-type says nothing about payload shape.
 * - `async`: fire-and-forget; the relay discards the body (and any
 *   non-2xx — an async route that stops existing fails SILENTLY, which is
 *   why route removals go through a deprecation window, never a delete).
 * - `standalone`: no socket round-trip at all; the relay execs the hook
 *   entry directly.
 *
 * `/statusline` (its own POST path) and `GET /health` sit outside the
 * hook table. /health responses include `contract_revision` so peers can
 * detect the API level of a running daemon.
 */

export const CONTRACT_REVISION = 1;

export const SYNC_ROUTES = [
  'session-start',
  'prompt-check',
  'pitfall-check',
  'plan-bridge',
  'subagent-context',
  'postcompact',
  'governance-gate',
] as const;

export const ASYNC_ROUTES = [
  'success-tracker',
  'error-learning',
  'stop',
  'stop-failure',
  'subagent-stop',
  'file-changed',
  'post-tool',
  // DEPRECATED alias of post-tool. Served indefinitely for already-wired
  // installs (their hook trust is hash-pinned to command strings naming
  // it); removal happens only through a doctor-guided, init-driven
  // migration across a supported-versions window — an async route that
  // disappears fails SILENTLY.
  'codex-post-tool',
  'bump-memory-version',
] as const;

/** No socket round-trip; the relay execs the hook entry directly. */
export const STANDALONE_HOOKS = ['precompact', 'session-end'] as const;

export type SyncRoute = (typeof SYNC_ROUTES)[number];
export type AsyncRoute = (typeof ASYNC_ROUTES)[number];
export type HookRoute = SyncRoute | AsyncRoute;

/** The hookSpecificOutput envelope an agent consumes from sync routes. */
export interface HookSpecificOutput {
  hookEventName: string;
  additionalContext?: string;
  permissionDecision?: 'allow' | 'deny' | 'ask';
  permissionDecisionReason?: string;
  [key: string]: unknown;
}

export interface HookOutputEnvelope {
  hookSpecificOutput: HookSpecificOutput;
  [key: string]: unknown;
}
