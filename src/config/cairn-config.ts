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
/** One warning per problem per file VERSION (mtime+size+ino — mtime alone
 *  can collide across versions), so a broken privacy config is loud once
 *  rather than silent or spammy. */
let warnedIdentity: string | null = null;

/** Parse, distinguishing "no scope configured" (a legal minimal file)
 *  from a WRONG-SHAPED scope block (a typo like private_projects, or a
 *  string where a list belongs) — the latter silently deactivating every
 *  private project is the likelier user error and must warn. */
function parseConfig(raw: string): CairnConfig | 'bad-shape' {
  const parsed = JSON.parse(raw) as unknown;
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return 'bad-shape';
  const scope = (parsed as { scope?: unknown }).scope;
  if (scope === undefined) return EMPTY_CONFIG; // scope simply not configured
  if (scope === null || typeof scope !== 'object') return 'bad-shape';
  const list = (scope as { privateProjects?: unknown }).privateProjects;
  if (list === undefined) {
    // A deliberately empty scope block is legal; a NON-empty one without
    // privateProjects is almost certainly a typo (private_projects,
    // privateProject) — and a typo silently deactivating every private
    // project is the failure this warning exists for.
    return Object.keys(scope as object).length === 0 ? EMPTY_CONFIG : 'bad-shape';
  }
  if (!Array.isArray(list)) return 'bad-shape';
  return {
    scope: {
      privateProjects: new Set(list.filter((p): p is string => typeof p === 'string' && p.length > 0)),
    },
  };
}

export function loadCairnConfig(): CairnConfig {
  const path = cairnConfigPath();
  // throwIfNoEntry covers only ENOENT; any OTHER stat error (EACCES, a
  // directory in the path replaced by a file, ...) must honor the
  // tolerant-reader contract too — empty config, but WITH a signal: an
  // unreadable privacy config silently failing open is the worst outcome.
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(path, { throwIfNoEntry: false });
  } catch (err) {
    if (warnedIdentity !== 'stat-error') {
      console.error(`[cairn] config at ${path} could not be read (${(err as NodeJS.ErrnoException).code ?? 'stat failed'}) — scope settings are INACTIVE`);
      warnedIdentity = 'stat-error';
    }
    cache = null;
    return EMPTY_CONFIG;
  }
  if (!st) {
    // Absent file IS the default config; drop any cache so deleting the
    // file reverts behavior immediately.
    cache = null;
    return EMPTY_CONFIG;
  }
  if (cache && cache.path === path && cache.mtimeMs === st.mtimeMs
    && cache.size === st.size && cache.ino === st.ino) {
    return cache.config;
  }
  const identity = `${st.mtimeMs}:${st.size}:${st.ino}`;
  let config: CairnConfig;
  let problem: string | null = null;
  try {
    const parsed = parseConfig(readFileSync(path, 'utf-8'));
    if (parsed === 'bad-shape') {
      problem = 'has an unrecognized shape (expected { "scope": { "privateProjects": ["<id>"] } })';
      config = EMPTY_CONFIG;
    } else {
      config = parsed;
    }
  } catch {
    problem = 'is invalid JSON';
    config = EMPTY_CONFIG;
  }
  // PRESENT but broken must not degrade silently — one warning per file
  // version (a privacy setting failing open needs a signal).
  if (problem !== null && warnedIdentity !== identity) {
    console.error(`[cairn] config at ${path} ${problem} — scope settings are INACTIVE until fixed`);
    warnedIdentity = identity;
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
  warnedIdentity = null;
}
