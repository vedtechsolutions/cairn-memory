/**
 * Agent-client identity — dispatch and provenance, NOT authentication.
 *
 * Client identity is DECLARED by hook wiring (a relay flag becomes the
 * header on the daemon socket or the env var on direct-node fallback
 * paths); it is never sniffed from payload shape. It is a same-UID trust
 * model: any process that can reach the socket can assert any client
 * name, so `origin_client` provenance recorded from these values carries
 * no authorization weight — it answers "which wiring sent this", not
 * "who is allowed to".
 *
 * Canonical names are an OPEN set: the constants below are the values
 * Waykeep ships adapters for, and integrators introduce new canonical
 * names by registering an adapter — consumers must treat unknown names
 * as valid clients, not errors.
 */

import { ENV_PREFIX, NAMESPACE } from './identity.js';

export const CLIENT_CLAUDE = 'claude';
export const CLIENT_CODEX = 'codex';
export const CLIENT_UNKNOWN = 'unknown';

/** Env var the relay sets for direct-node fallback hook processes. */
export const CLIENT_ENV_VAR = `${ENV_PREFIX}_CLIENT` as const;

/** HTTP header carrying declared identity on daemon-socket hook requests.
 *  Stored lowercase (Node's incoming-header form); emitters may send any
 *  casing — comparisons must be case-insensitive. */
export const CLIENT_HEADER = `x-${NAMESPACE}-client` as const;
