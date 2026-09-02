// ============================================================================
// Package version — the ONE value here with an external contract.
//
// `npm version` rewrites this file through scripts/sync-plugin-versions.mjs,
// and the MCP handshake advertises it. It lives alone so that automation has
// an unambiguous target: it previously sat in a general-purpose module, where
// a file split moved it and the sync script silently stopped matching.
// ============================================================================

// --- Version ----------------------------------------------------------------

/** Kept in lockstep with package.json by scripts/sync-plugin-versions.mjs
 *  (npm `version` lifecycle) and pinned by a test — a "keep in sync"
 *  comment alone let the MCP handshake advertise 5.1.0 on a 5.3.1
 *  install (step-6 validation finding). */
export const VERSION = '6.0.0';
