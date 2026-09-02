/**
 * Every filesystem location Waykeep owns, derived from the contract's
 * `DATA_DIR_NAME` / `DB_FILENAME` so the v6.0.0 rename touches no call site.
 *
 * Two different directories share the namespaced name and must not be
 * conflated:
 *
 *  - the HOME STATE DIR (`~/.cairn`) holds the database, config, hook
 *    socket and scratch files for one user;
 *  - the PROJECT GATE DIR (`<repo>/.cairn/gates.json`) is a per-repository
 *    marker committed alongside the code it governs.
 *
 * Renaming affects them differently: the first is migrated for the user,
 * the second lives in repositories we do not own.
 *
 * Every accessor is a FUNCTION, never a module-level constant. The env
 * overrides have to be read lazily or a test that sets one after import
 * order has already resolved silently reads the real home directory —
 * the hazard `state-io.ts` documents.
 */

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { DATA_DIR_NAME, DB_FILENAME, NAMESPACE } from 'waykeep-contract';
import { ENV } from './env.js';

export { DATA_DIR_NAME, DB_FILENAME };

/** Filenames Waykeep writes. Values, not paths — join them onto a directory. */
export const FILES = {
  /** SQLite database, inside the home state dir. */
  DB: DB_FILENAME,
  /** User config, inside the home state dir. */
  CONFIG: 'config.json',
  /** Hook daemon unix socket, inside the home state dir.
   *  Joined onto `dataDir()` by `socket-ownership.ts`, which owns the single
   *  `socketPath()` definition — do not add a second one here. */
  SOCKET: 'hook-daemon.sock',
  /** Hook daemon pid file, inside the home state dir. */
  PID: 'hook-daemon.pid',
  /** Error-dedup scratch state, inside the home state dir. */
  ERROR_DEDUP: 'error-dedup.json',
  /** Relay fallback diagnostic log, inside the home state dir. */
  RELAY_FALLBACK_LOG: 'hook-relay-fallback.log',
  /** Governance gate config, inside a PROJECT dir — not the home state dir. */
  GATES: 'gates.json',
  /** Shared context-mode state, written by StatusLine into the CLIENT's dir. */
  CLIENT_STATE: `${NAMESPACE}-state.json`,
  /** Codex trust shadow, written into the Codex client dir. */
  TRUST_SHADOW: `.${NAMESPACE}-trust-shadow.json`,
} as const;

/** Suffix appended when backing a client config file up before rewriting it. */
export const BACKUP_SUFFIX = `.${NAMESPACE}-backup` as const;

/**
 * The home state directory, honoring the `DIR` override.
 * Single definition — socket ownership, the edit tracker and the error
 * classifier each resolved this independently before centralization.
 */
export function dataDir(): string {
  return process.env[ENV.DIR] ?? join(homedir(), DATA_DIR_NAME);
}

/**
 * The home state directory WITHOUT the `DIR` override — the real one, always.
 * Only for callers that must reach a user's actual install (the benchmark
 * ingester reading a live database while pointed at a fixture elsewhere).
 */
export function realHomeDataDir(): string {
  return resolve(homedir(), DATA_DIR_NAME);
}

/** Tilde-form default database path, expanded by `resolveDbPath`. */
export const DB_DEFAULT_PATH = `~/${DATA_DIR_NAME}/${DB_FILENAME}` as const;

/** Error-dedup scratch file. */
export function errorDedupPath(): string {
  return join(dataDir(), FILES.ERROR_DEDUP);
}

/**
 * User config file, honoring the `CONFIG_PATH` override only.
 * Deliberately NOT built on `dataDir()`: `CONFIG_PATH` is the sole override
 * here, and routing it through `DIR` would silently widen what relocates it.
 */
export function configPath(): string {
  return process.env[ENV.CONFIG_PATH] ?? join(homedir(), DATA_DIR_NAME, FILES.CONFIG);
}

/** Governance gate config for a PROJECT root (already resolved by the caller). */
export function gatesPath(projectRoot: string): string {
  return join(projectRoot, DATA_DIR_NAME, FILES.GATES);
}

/** Display form of the gate config location, for operator-facing messages. */
export const GATES_RELATIVE_PATH = `${DATA_DIR_NAME}/${FILES.GATES}` as const;

/** Display form of the user config location, for operator-facing messages. */
export const CONFIG_DISPLAY_PATH = `~/${DATA_DIR_NAME}/${FILES.CONFIG}` as const;
