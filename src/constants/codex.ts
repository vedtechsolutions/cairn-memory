/**
 * Codex CLI's configuration surface and the hook timings `waykeep init`
 * writes for it. Codex's names, not ours — they follow that product's
 * releases, so they live here rather than deriving from the contract.
 */
export const CODEX = {
  /** Codex's config dir, relative to the home dir. */
  CONFIG_DIR: '.codex',
  /** Rollout session logs, inside the config dir. */
  SESSIONS_SUBDIR: 'sessions',
  /** Codex's own memory files, inside the config dir (import source). */
  MEMORIES_SUBDIR: 'memories',
  /** Hook timeouts written to hooks.json, in seconds. Codex clamps SessionEnd
   *  to 3s and warns above it. */
  HOOK_TIMEOUT_S: {
    SESSION_END: 3,
    SYNC: 10,
    ASYNC: 30,
  },
  /** Explicit additionalContext limit so a Codex default change cannot
   *  silently spill the briefing. */
  CONTEXT_LIMIT_TOKENS: 2500,
} as const;
