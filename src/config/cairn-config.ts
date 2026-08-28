/**
 * Cairn's config file — ~/.cairn/config.json, overridable via
 * CAIRN_CONFIG_PATH (same hermeticity pattern as CAIRN_CODEX_DIR: tests
 * point it into a temp dir and can never read a real user's config).
 *
 * TOLERANT READER, absent-equals-default: no file, unreadable file,
 * invalid JSON, or wrong-shaped fields all yield the empty config — the
 * behavior with no config present must be exactly the pre-config
 * behavior. The schema is INTERNAL in v1 (documented in the README, not
 * part of @cairn/contract): only additive changes, unknown fields
 * ignored.
 *
 * Read path is hot (guard functions consult it per memory-set filter),
 * so the parsed config is cached and re-read only when the file's mtime
 * changes — cheap statSync per access, daemon-safe (a long-lived daemon
 * picks up edits without restart).
 */
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface CairnScopeConfig {
  /** Projects whose memories never surface OUTSIDE the project — on any
   *  surface, regardless of fingerprint overlap. Inside the project
   *  everything behaves normally. */
  privateProjects: ReadonlySet<string>;
}

export interface CairnConfig {
  scope: CairnScopeConfig;
}

const EMPTY_CONFIG: CairnConfig = { scope: { privateProjects: new Set() } };

export function cairnConfigPath(): string {
  return process.env.CAIRN_CONFIG_PATH ?? join(homedir(), '.cairn', 'config.json');
}

/** Cache identity is (path, mtime, size, inode): mtimeMs alone is lossy —
 *  measured 1ms granularity lets a rapid rewrite (or a same-size atomic
 *  replace) share a timestamp, which for THIS file means a stale privacy
 *  policy served indefinitely. A very fresh mtime (within its granularity
 *  of now) is additionally never cached, so back-to-back edits re-read. */
interface ConfigCache { path: string; mtimeMs: number; size: number; ino: number; config: CairnConfig }
let cache: ConfigCache | null = null;
const MTIME_GRANULARITY_MS = 2;
let warnedInvalidAt: number | null = null;

function parseConfig(raw: string): CairnConfig {
  const parsed = JSON.parse(raw) as unknown;
  if (parsed === null || typeof parsed !== 'object') return EMPTY_CONFIG;
  const scope = (parsed as { scope?: unknown }).scope;
  if (scope === null || typeof scope !== 'object') return EMPTY_CONFIG;
  const list = (scope as { privateProjects?: unknown }).privateProjects;
  if (!Array.isArray(list)) return EMPTY_CONFIG;
  return {
    scope: {
      privateProjects: new Set(list.filter((p): p is string => typeof p === 'string' && p.length > 0)),
    },
  };
}

export function loadCairnConfig(): CairnConfig {
  const path = cairnConfigPath();
  // throwIfNoEntry: the absent-file case is the COMMON case and must not
  // pay exception cost on hot filters (measured ~15us/throw vs ~1us).
  const st = statSync(path, { throwIfNoEntry: false });
  if (!st) {
    // Absent (or unstatable) file IS the default config; drop any cache
    // so deleting the file reverts behavior immediately.
    cache = null;
    return EMPTY_CONFIG;
  }
  if (cache && cache.path === path && cache.mtimeMs === st.mtimeMs
    && cache.size === st.size && cache.ino === st.ino) {
    return cache.config;
  }
  let config: CairnConfig;
  try {
    config = parseConfig(readFileSync(path, 'utf-8'));
  } catch {
    // PRESENT but unparseable must not degrade silently: an invalid file
    // fails open (no restrictions), and for a privacy setting that needs
    // a signal. Once per file version, not per access.
    if (warnedInvalidAt !== st.mtimeMs) {
      console.error(`[cairn] config at ${path} is invalid JSON — scope settings are INACTIVE until fixed`);
      warnedInvalidAt = st.mtimeMs;
    }
    config = EMPTY_CONFIG;
  }
  if (Date.now() - st.mtimeMs >= MTIME_GRANULARITY_MS) {
    cache = { path, mtimeMs: st.mtimeMs, size: st.size, ino: st.ino, config };
  } else {
    cache = null; // too fresh to fingerprint reliably — re-read next time
  }
  return config;
}

/** True when the project is marked private in the scope config. Null
 *  (global scope) is never private — global visibility is governed at
 *  promote time, not here. */
export function isPrivateProject(project: string | null): boolean {
  if (!project) return false;
  return loadCairnConfig().scope.privateProjects.has(project);
}

/**
 * Session-binding for EXPLICIT reads: a private project's content is
 * readable through MCP tools only when the session's own working project
 * IS that project. This is preference isolation for an autonomous agent
 * (keeping client work out of unrelated contexts), not access control —
 * the DB file belongs to the same user either way.
 */
export function canReadPrivate(memoryProject: string | null, sessionProjectId: string | null): boolean {
  if (!memoryProject) return true;
  if (!isPrivateProject(memoryProject)) return true;
  return memoryProject === sessionProjectId;
}

/** TEST-ONLY cache reset (config path changes between hermetic tests). */
export function resetConfigCacheForTests(): void {
  cache = null;
  warnedInvalidAt = null;
}
