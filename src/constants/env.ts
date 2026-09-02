/**
 * Every environment variable Waykeep reads, in one place.
 *
 * Names are built by `envName()` from the contract's `ENV_PREFIX`, so the
 * prefix is spelled exactly once in the codebase and the v6.0.0 rename
 * does not have to touch any call site. Read them as
 * `process.env[ENV.DB_PATH]` — never as a `process.env.WAYKEEP_*` literal.
 * The guard test fails the suite on any inline spelling.
 *
 * Entries marked RELAY are also read by the compiled hook relay
 * (`hook-relay.c`) or the shell relay (`hook-relay.sh`), which cannot
 * import TypeScript. Those two artifacts receive these names through the
 * build-time generator rather than by re-spelling them.
 */

import { envName } from 'waykeep-contract';

export const ENV = {
  // --- Storage -------------------------------------------------------------
  /** Absolute override for the SQLite database path. */
  DB_PATH: envName('DB_PATH'),
  /** Absolute override for the state directory itself. */
  DIR: envName('DIR'),
  /** Absolute override for the config file. Hermetic in tests. */
  CONFIG_PATH: envName('CONFIG_PATH'),
  /** Absolute override for the hook state file. */
  STATE_PATH: envName('STATE_PATH'),

  // --- Client wiring -------------------------------------------------------
  /** Declared agent-client name. RELAY — set by both relays on fallback paths. */
  CLIENT: envName('CLIENT'),
  /** Absolute path to the node binary the relay should exec. RELAY. */
  NODE: envName('NODE'),
  /** Override for `~/.claude/settings.json`. Hermetic in tests. */
  CLAUDE_SETTINGS: envName('CLAUDE_SETTINGS'),
  /** Override for `~/.codex`. Hermetic in tests. */
  CODEX_DIR: envName('CODEX_DIR'),
  /** Override for the Codex rollout-session directory. */
  CODEX_SESSIONS_DIR: envName('CODEX_SESSIONS_DIR'),

  // --- Timeouts ------------------------------------------------------------
  /** Governance-gate deadline in ms. RELAY. */
  GOVERNANCE_TIMEOUT_MS: envName('GOVERNANCE_TIMEOUT_MS'),
  /** Daemon-socket deadline in ms. RELAY. */
  DAEMON_TIMEOUT_MS: envName('DAEMON_TIMEOUT_MS'),

  // --- Retrieval -----------------------------------------------------------
  /** Override the local embedding model id. */
  EMBEDDING_MODEL: envName('EMBEDDING_MODEL'),
  /** Opt in to cross-encoder reranking. */
  RERANK: envName('RERANK'),
  /** Override the reranker model id. */
  RERANK_MODEL: envName('RERANK_MODEL'),
  /** Override the cwd used to fingerprint a recall query. */
  QUERY_CWD: envName('QUERY_CWD'),

  // --- Behaviour flags -----------------------------------------------------
  /** Opt in to persisting unredacted shell command lines locally. */
  PERSIST_RAW_COMMAND: envName('PERSIST_RAW_COMMAND'),
  /** Allow transcripts to be read from temp directories. */
  ALLOW_TMP_TRANSCRIPTS: envName('ALLOW_TMP_TRANSCRIPTS'),
  /** Enable the telemetry rollup pass. */
  ROLLUP: envName('ROLLUP'),
  /** Enable the Codex rollout tailer. */
  TAILER: envName('TAILER'),
  /** IANA timezone override for date rendering. */
  TZ: envName('TZ'),

  // --- Diagnostics ---------------------------------------------------------
  /** Verbose MCP server logging. */
  VERBOSE: envName('VERBOSE'),
  /** Log level passed to the server by `waykeep init`. */
  LOG_LEVEL: envName('LOG_LEVEL'),
  /** Test-only hook for the governance inspector. */
  INSPECTOR_TEST: envName('INSPECTOR_TEST'),
  /** Opt in to the shadow-evaluator benchmark (slow). */
  RUN_SHADOW_BENCHMARK: envName('RUN_SHADOW_BENCHMARK'),
  /** Opt in to the warn-relay latency benchmark (slow). */
  RUN_WARN_RELAY_BENCHMARK: envName('RUN_WARN_RELAY_BENCHMARK'),
} as const;

/** Every env var name Waykeep owns — used by the guard test and the relay generator. */

/**
 * Phase-B compat: honor LEGACY-prefixed environment variables until users
 * migrate their shells/configs. For each owned suffix, an unset current
 * name inherits the value of the first legacy-prefixed name that is set.
 * Runs once at module load — every Waykeep entrypoint imports this module
 * before reading any env — and never overrides an explicitly set current
 * name. Remove with the legacy namespace at Phase D.
 */
import { LEGACY_NAMESPACES } from 'waykeep-contract';

/** Env suffixes that, when inherited from a legacy name, prove the process is
 *  running against a legacy-configured STORE — even with no ~/.cairn home DB
 *  (e.g. the legacy `CAIRN_DB_PATH=/mnt/memory.db`). That user's existing prompts still
 *  call `cairn_*` tools / `cairn://` resources, so legacy compat must stay on
 *  until they migrate (codex B1 review). Unrelated legacy vars (TZ, …) do not
 *  imply an un-migrated store and are deliberately excluded. */
const LEGACY_STORE_SUFFIXES: ReadonlySet<string> = new Set(['DB_PATH', 'DIR', 'CONFIG_PATH']);
/** Suffixes NEVER inherited from a legacy name. CLIENT is a per-invocation
 *  relay→child signal (the relay sets WAYKEEP_CLIENT and clears the legacy name),
 *  NOT a user-configured persistent env. Inheriting a stale/ambient legacy CAIRN_CLIENT
 *  would restore it here and mislabel a Claude event as Codex on any path that
 *  reaches direct-node without the relay's clearing — the settings-wired
 *  PreCompact/SessionEnd hooks, or the plugin's `--node` launcher (codex B1
 *  review). Excluding it at the root fixes every such path at once. */
const BOOTSTRAP_EXCLUDE: ReadonlySet<string> = new Set(['CLIENT']);
let legacyStoreEnvInherited = false;
for (const [suffix, name] of Object.entries(ENV)) {
  if (BOOTSTRAP_EXCLUDE.has(suffix)) continue;
  // Treat an EMPTY current value as unset so it inherits the legacy name —
  // this MUST match the relays, which treat `WAYKEEP_DIR=""` as unset and
  // fall through to the legacy `CAIRN_DIR` (codex B1 review). If the bootstrap instead
  // kept the empty string, `dataDir()`/`configPath()` (which use `|| `) would
  // discard it and fall to the state root while the relays used the legacy
  // override — the daemon and relays would then bind different sockets, and a
  // legacy privacy config would be silently ignored.
  if (process.env[name] !== undefined && process.env[name] !== '') continue;
  for (const ns of LEGACY_NAMESPACES) {
    const legacy = `${ns.toUpperCase()}_${suffix}`;
    const v = process.env[legacy];
    if (v !== undefined && v !== '') {
      process.env[name] = v;
      if (LEGACY_STORE_SUFFIXES.has(suffix)) legacyStoreEnvInherited = true;
      break;
    }
  }
}

/** True when a legacy STORE/config env override was inherited at load — the
 *  process is un-migrated even if no ~/.cairn home store exists. */
export const LEGACY_STORE_ENV_INHERITED = legacyStoreEnvInherited;

export const ALL_ENV_NAMES: readonly string[] = Object.values(ENV);
