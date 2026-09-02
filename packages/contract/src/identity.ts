/**
 * Product identity — the single source of truth for every name Waykeep
 * exposes outside its own process.
 *
 * Two distinct things live here and must not be conflated:
 *
 *  - `PRODUCT_DISPLAY_NAME` is the BRAND. It is already "Waykeep" and is
 *    only ever read by human-facing prose.
 *  - `NAMESPACE` is the TECHNICAL SLUG the product occupies in identifiers
 *    users and integrators can see: the environment-variable prefix, the
 *    home-relative state directory, the database filename, the MCP server
 *    name, the MCP tool prefix, and the MCP resource URI scheme. It is
 *    still "cairn" for backward compatibility.
 *
 * Everything in the second group DERIVES from `NAMESPACE`, so completing
 * the rename is a one-line change here rather than an edit across 245
 * files. Nothing downstream may re-spell any of these values inline; the
 * guard test enforces that.
 *
 * This lives in the contract package, not in `src/constants/`, for the
 * same reason `CLIENT_ENV_VAR` does: these values are wire-visible across
 * separately shipped artifacts (the MCP client's config, the compiled
 * hook relay, the shell relay, third-party integrators), so the package
 * that carries the integration contract has to own them. `src/constants/`
 * re-exports rather than redeclares.
 *
 * Changing `NAMESPACE` is a BREAKING change to the contract's additive
 * stability guarantee and requires a major version bump on both this
 * package and the client.
 */

/** Brand name, for human-facing prose only. Never an identifier. */
export const PRODUCT_DISPLAY_NAME = 'Waykeep';

/**
 * The technical slug every machine-visible identifier is built from.
 * Flipping this to 'waykeep' is the v6.0.0 rename, and is the ONLY line
 * that needs to change to perform it.
 */
export const NAMESPACE = 'cairn';

/** Uppercase prefix shared by every environment variable. */
export const ENV_PREFIX = NAMESPACE.toUpperCase() as Uppercase<typeof NAMESPACE>;

/** Home-relative state directory, e.g. `~/.cairn`. */
export const DATA_DIR_NAME = `.${NAMESPACE}` as const;

/** SQLite database filename inside the state directory. */
export const DB_FILENAME = `${NAMESPACE}.db` as const;

/** Name the MCP server registers under; appears in every client's config. */
export const MCP_SERVER_NAME = NAMESPACE;

/** Prefix on every MCP tool name, e.g. `cairn_recall`. */
export const MCP_TOOL_PREFIX = `${NAMESPACE}_` as const;

/** Scheme for MCP resource URIs, e.g. `cairn://briefing/{project}`. */
export const MCP_URI_SCHEME = NAMESPACE;

/**
 * Namespaces this product has used BEFORE the current one, newest first.
 *
 * Every guard needle is built from `NAMESPACE`, so the moment it changes the
 * guards hunt the new name and go blind to the old one — exactly when you are
 * trying to find what the rename missed. This list is what keeps them looking
 * backwards too.
 *
 * Empty while `NAMESPACE` has never changed. The v6.0.0 flip must add the
 * outgoing name here in the same commit, or the guards lose their ability to
 * find stragglers.
 */
export const LEGACY_NAMESPACES: readonly string[] = [];

/**
 * The compiled relay's self-identification handshake. `binaryUsable()` and the
 * plugin launcher run the binary with the flag and require the sentinel back:
 * a wrong-arch ELF exits 127 through /bin/sh and would otherwise look runnable.
 * Both halves live here so the relay and every detector derive from one place —
 * splitting them silently demotes every hook to the slower shell relay.
 */
export const RELAY_PROBE_FLAG = `--${NAMESPACE}-probe` as const;
export const RELAY_PROBE_SENTINEL = `${NAMESPACE}-relay` as const;

/**
 * Build a fully-qualified environment variable name from its suffix:
 * `envName('DB_PATH')` yields the prefixed name. Callers pass the suffix only,
 * so the prefix exists in exactly one place.
 */
export function envName<S extends string>(suffix: S): `${Uppercase<typeof NAMESPACE>}_${S}` {
  return `${ENV_PREFIX}_${suffix}`;
}

/**
 * Build a fully-qualified MCP tool name from its bare verb:
 * `toolName('recall')` yields the prefixed tool name.
 */
export function toolName<S extends string>(verb: S): `${typeof NAMESPACE}_${S}` {
  return `${MCP_TOOL_PREFIX}${verb}`;
}
