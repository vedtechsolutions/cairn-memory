/**
 * Every filesystem location Waykeep owns, derived from the contract's
 * `DATA_DIR_NAME` / `DB_FILENAME` so the v6.0.0 rename touches no call site.
 *
 * Two different directories share the namespaced name and must not be
 * conflated:
 *
 *  - the HOME STATE DIR (`~/.waykeep`) holds the database, config, hook
 *    socket and scratch files for one user;
 *  - the PROJECT GATE DIR (`<repo>/.waykeep/gates.json`) is a per-repository
 *    marker committed alongside the code it governs (legacy `.cairn/gates.json`
 *    is still honored — see `legacyGatesPaths`).
 *
 * Renaming affects them differently: the first is migrated for the user,
 * the second lives in repositories we do not own.
 *
 * Every accessor is a FUNCTION, never a module-level constant. The env
 * overrides have to be read lazily or a test that sets one after import
 * order has already resolved silently reads the real home directory —
 * the hazard `state-io.ts` documents.
 */

import { statSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join, resolve, isAbsolute } from 'node:path';
import { LEGACY_NAMESPACES, DATA_DIR_NAME, DB_FILENAME, NAMESPACE } from 'waykeep-contract';
import { ENV, LEGACY_STORE_ENV_INHERITED } from './env.js';

/**
 * An ABSOLUTE home directory, robust to an empty/unset HOME. Node's `homedir()`
 * returns `""` when HOME is present but empty — `join("", ".waykeep")` is then a
 * CWD-RELATIVE `.waykeep`, and `openDatabase` would mint a shadow store there
 * while the real store (and the relays, which fall back to the passwd entry)
 * stay at the legacy `~/.cairn` — silent memory loss (codex B1 review). Fall back to the
 * passwd home (`userInfo().homedir`, which ignores HOME) whenever `homedir()`
 * is empty or non-absolute, so the state root is always an absolute real home.
 */
export function robustHomedir(): string {
  const h = homedir();
  if (isAbsolute(h)) return h;
  try {
    const u = userInfo().homedir;
    if (u && isAbsolute(u)) return u;
  } catch { /* no passwd entry — fall through to the fail-closed throw */ }
  // No absolute home is resolvable (HOME is non-absolute AND no passwd entry —
  // e.g. a container running a uid absent from /etc/passwd). Resolving `h`
  // against CWD would mint a PER-PROJECT shadow store and split the TS server
  // from its (fail-closed) relays and (HOME-clearing) plugin launchers. Refuse
  // instead — loud failure beats silent memory loss (codex B1 review). An
  // explicit `WAYKEEP_DIR`/`WAYKEEP_DB_PATH` override bypasses this entirely.
  throw new Error(
    `${NAMESPACE}: cannot resolve an absolute home directory — HOME is not an absolute path and no passwd entry exists for this uid. Set HOME to an absolute path, or pass ${ENV.DIR}.`,
  );
}

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
/** Marker file the Phase-B2 migration writes into the CURRENT state dir.
 *  Its presence is what makes ~/.waykeep authoritative — a bare directory
 *  (something ran mkdir) must never shadow a populated legacy store. */
export const MIGRATION_MARKER = `${NAMESPACE}-migrated.json` as const;

export interface StateRoot {
  dir: string;
  dbFilename: string;
  /** true while running on an un-migrated legacy root (Phase-B window). */
  legacy: boolean;
}

let cachedRoot: StateRoot | null = null;

/**
 * THE single migration decision (codex B1 review): every state path —
 * database, user config, state files, hook socket — derives from ONE root
 * chosen ONCE per process, so no combination of independent existence
 * checks can ever split a process across namespaces (the failure mode
 * where the DB came from the legacy store while the legacy privacy config
 * silently read as absent).
 *
 * Decision order:
 *  1. CURRENT root when the migration MARKER exists (B2 migration ran).
 *  2. Otherwise an EXISTING legacy DATABASE (un-migrated Phase-B window):
 *     everything — db (under its legacy filename), config, state, socket —
 *     stays together under the legacy dir.
 *  3. Otherwise the CURRENT root (fresh install, no legacy store).
 *
 * The presence of a current DB FILE is deliberately NOT a trigger: an
 * accidental empty ~/.waykeep/waykeep.db (a fresh binary that touched the
 * new path once before the migration ran) must never shadow a populated
 * legacy store — that shadow presents as total memory loss. Erring toward
 * the legacy store never abandons the user's data, and the marker is
 * trivial to write. Symmetrically, the legacy trigger is the legacy DB
 * FILE, not merely its directory, so an empty leftover legacy ~/.cairn cannot
 * capture a genuine fresh install. Explicit per-item env overrides still
 * win downstream, as before the flip.
 */
/** statSync().isFile() with existence tolerance — a directory shaped like the
 *  marker/db must NOT satisfy it (that is the whole point of isFile vs exists). */
function isFile(p: string): boolean {
  try { return statSync(p).isFile(); } catch { return false; }
}

export function resolveStateRoot(): StateRoot {
  if (cachedRoot) return cachedRoot;
  const currentDir = join(robustHomedir(), DATA_DIR_NAME);
  const current: StateRoot = { dir: currentDir, dbFilename: DB_FILENAME, legacy: false };
  if (isFile(join(currentDir, MIGRATION_MARKER))) {
    cachedRoot = current;
    return current;
  }
  for (const ns of LEGACY_NAMESPACES) {
    const legacyDb = join(robustHomedir(), `.${ns}`, `${ns}.db`);
    if (isFile(legacyDb)) {
      cachedRoot = { dir: join(robustHomedir(), `.${ns}`), dbFilename: `${ns}.db`, legacy: true };
      return cachedRoot;
    }
  }
  cachedRoot = current;
  return current;
}

/** Test-only: clear the per-process root memo (hermetic HOME swaps). */
export function resetStateRootForTests(): void {
  cachedRoot = null;
}

/** true when the Phase-B2 migration marker is present: the current root is
 *  authoritative and legacy compatibility surfaces are retired. Home-relative,
 *  so it tolerates an unresolvable home (an explicit DB/DIR override may still
 *  let the process run) — treat that as "not migrated" (codex B1 review). */
export function isMigrated(): boolean {
  try { return isFile(join(robustHomedir(), DATA_DIR_NAME, MIGRATION_MARKER)); }
  catch { return false; }
}

/**
 * Whether legacy compatibility surfaces — `cairn_*` tool aliases and `cairn://`
 * resource URIs — should still be served. True when running on an un-migrated
 * legacy home store, OR when a legacy STORE/config env override is in use
 * (e.g. `CAIRN_DB_PATH` with no home store — the user is clearly un-migrated
 * and their existing prompts still call `cairn_*`). Never true once migrated:
 * the marker is the intended end state and retires the aliases (codex B1 review).
 */
export function legacyCompatActive(): boolean {
  // Tool/resource registration calls this during startup; an explicit
  // WAYKEEP_DB_PATH/DIR override must not be stranded by robustHomedir's
  // fail-closed throw when the home is unresolvable (codex B1 review). If the
  // home root can't be determined, fall back to the env signal alone.
  let homeLegacy = false;
  try { homeLegacy = resolveStateRoot().legacy; } catch { /* unresolvable home */ }
  return homeLegacy || (!isMigrated() && LEGACY_STORE_ENV_INHERITED);
}

export function dataDir(): string {
  // An EMPTY override is treated as unset (matches the relays' empty-var
  // handling — codex B1 review): `|| ` not `?? `.
  return process.env[ENV.DIR] || resolveStateRoot().dir;
}

/**
 * The home state directory WITHOUT the `DIR` override — the real one, always.
 * Only for callers that must reach a user's actual install (the benchmark
 * ingester reading a live database while pointed at a fixture elsewhere).
 */
export function realHomeDataDir(): string {
  return resolve(robustHomedir(), DATA_DIR_NAME);
}

/** Default database path under the COHERENT state root (Phase B). Deliberately
 *  independent of the `DIR` override: the database has its own per-item
 *  override (`DB_PATH`), and relocating it implicitly with the directory
 *  would hand an existing install an empty store. Anything that must run
 *  hermetically sets `DB_PATH` explicitly (the test preload does). */
export function defaultDbPath(): string {
  const root = resolveStateRoot();
  return join(root.dir, root.dbFilename);
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
  return process.env[ENV.CONFIG_PATH] || join(resolveStateRoot().dir, FILES.CONFIG);
}

/** Governance gate config for a PROJECT root (already resolved by the caller). */
export function gatesPath(projectRoot: string): string {
  return join(projectRoot, DATA_DIR_NAME, FILES.GATES);
}

/** Legacy governance gate paths for a PROJECT root, newest first — repos
 *  configured before the namespace flip carry a legacy `.cairn/gates.json`, and
 *  governance must not silently deactivate on them (Phase-B compat). */
export function legacyGatesPaths(projectRoot: string): string[] {
  return LEGACY_NAMESPACES.map(ns => join(projectRoot, `.${ns}`, FILES.GATES));
}

/** Display form of the gate config location, for operator-facing messages. */
export const GATES_RELATIVE_PATH = `${DATA_DIR_NAME}/${FILES.GATES}` as const;

/** Display form of the user config location, for operator-facing messages. */
export const CONFIG_DISPLAY_PATH = `~/${DATA_DIR_NAME}/${FILES.CONFIG}` as const;
