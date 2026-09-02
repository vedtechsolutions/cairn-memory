/**
 * Every environment variable Waykeep reads, in one place.
 *
 * Names are built by `envName()` from the contract's `ENV_PREFIX`, so the
 * prefix is spelled exactly once in the codebase and the v6.0.0 rename
 * does not have to touch any call site. Read them as
 * `process.env[ENV.DB_PATH]` — never as a `process.env.CAIRN_*` literal.
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
export const ALL_ENV_NAMES: readonly string[] = Object.values(ENV);
