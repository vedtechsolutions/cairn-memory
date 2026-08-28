/**
 * Agent-client identities Cairn recognizes for hook provenance.
 *
 * Identity is always DECLARED by the hook wiring (relay `--client` flag,
 * daemon header, or env on fallback paths) — never sniffed from payload
 * shape. `claude` is the default dialect and the value assumed when no
 * client is declared (all pre-v29 rows).
 */

export const CLIENT_CLAUDE = 'claude';
export const CLIENT_CODEX = 'codex';
export const CLIENT_UNKNOWN = 'unknown';

/** Env var the relay sets for direct-node fallback hook processes. */
export const CLIENT_ENV_VAR = 'CAIRN_CLIENT';

/** HTTP header (lowercase, as node exposes it) the relay sets on
 *  daemon-socket hook requests. */
export const CLIENT_HEADER = 'x-cairn-client';
