/**
 * Claude Code's own configuration surface, as `waykeep init` touches it.
 *
 * These are Claude Code's names, not ours — they follow that product's
 * releases, so they live here rather than deriving from the contract.
 * Verified against Claude Code 2.1.258: `mcpServers` in settings.json is
 * inert (that file carries MCP *policy* keys only); user-scope servers live
 * in `.claude.json` under the home dir — or under `$CLAUDE_CONFIG_DIR` when
 * set, which relocates the whole config dir — and are edited through the
 * `claude mcp` CLI.
 */
export const CLAUDE_CODE = {
  /** Claude Code's env var that relocates its config dir (`.claude.json` and settings.json included). */
  CONFIG_DIR_ENV: 'CLAUDE_CONFIG_DIR',
  /** The default config dir, relative to the home dir. */
  CONFIG_DIR: '.claude',
  /** User-scope MCP registry, relative to the home (or relocated config) dir. */
  CONFIG_FILENAME: '.claude.json',
  /** Settings file (hooks, StatusLine, plugin enablement), inside the config dir. */
  SETTINGS_FILENAME: 'settings.json',
  /** The CLI init shells out to, resolved on PATH unless ENV.CLAUDE_BIN overrides it. */
  CLI_BIN: 'claude',
  /** Where Claude Code's installers put the CLI, relative to the home dir —
   *  probed when PATH lacks it (init often runs from a non-login shell that
   *  never sourced these): the native installer, then the older "local" layout. */
  CLI_HOME_LOCATIONS: [['.local', 'bin'], ['.claude', 'local']],
  /** System-wide locations probed after the home ones (Homebrew, /usr/local). */
  CLI_SYSTEM_LOCATIONS: ['/opt/homebrew/bin', '/usr/local/bin'],
  /** nvm's per-version bin dirs, relative to the home dir; newest version wins. */
  NVM_VERSIONS_DIR: ['.nvm', 'versions', 'node'],
  /** `claude mcp` scope init registers at: available in every project. */
  MCP_SCOPE: 'user',
  /** Deadline for one `claude mcp` invocation — the CLI boots a Node runtime per call. */
  CLI_TIMEOUT_MS: 30_000,
} as const;
