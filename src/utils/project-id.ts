import { createHash } from 'node:crypto';
import { getGitRemote } from './project-scanner.js';

/**
 * Project identity.
 *
 * Preferred: derived from the normalized `origin` git remote, so the SAME repo
 * yields the SAME id on every clone/machine/path (the stable identity the team
 * sync layer depends on, and the fix for bare-name/path-hash mismatches).
 * Fallback: the legacy path hash, used only when there is no resolvable remote.
 *
 * Format (both paths): "<name>-<8-char-sha256>". Keeping one shape means every
 * call site and the bare-name resolver stay uniform.
 */

/** Mirror SessionCache's GIT_CACHE_TTL_MS: resolve `origin` at most once per
 *  cwd per 5 minutes in a long-lived process, so this never runs a subprocess
 *  on the hot hook path more than the existing getGitHash cache does. */
const REMOTE_CACHE_TTL_MS = 300_000;
interface RemoteCacheEntry { canonical: string | null; cachedAt: number }
const remoteCache = new Map<string, RemoteCacheEntry>();

function resolveCanonicalRemote(dirPath: string): string | null {
  const hit = remoteCache.get(dirPath);
  if (hit && Date.now() - hit.cachedAt <= REMOTE_CACHE_TTL_MS) return hit.canonical;
  const raw = getGitRemote(dirPath);
  const canonical = raw ? normalizeGitRemote(raw) : null;
  remoteCache.set(dirPath, { canonical, cachedAt: Date.now() });
  return canonical;
}

/**
 * Canonicalize a git remote URL to `host[:port]/path` (no scheme, no
 * credentials, no `.git`, no trailing slash; host lowercased, path case
 * preserved). All of these map to `github.com/org/repo`:
 *   git@github.com:org/repo.git
 *   https://github.com/org/repo(.git)
 *   ssh://git@github.com/org/repo
 *   https://user:token@github.com/org/repo.git   (credentials stripped)
 * Returns null for unusable remotes (malformed, or no host — e.g. file://).
 */
export function normalizeGitRemote(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) return null;

  let host: string;
  let pathPart: string;
  let port: string | null = null;

  // scp-like syntax: [user@]host:path (no scheme, single colon before path)
  const scp = !trimmed.includes('://') ? /^(?:[^@\s]+@)?([^:\s/]+):(.+)$/.exec(trimmed) : null;
  if (scp) {
    host = scp[1];
    pathPart = scp[2];
  } else {
    try {
      const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed) ? trimmed : `ssh://${trimmed}`;
      const u = new URL(withScheme);
      host = u.hostname;
      pathPart = u.pathname;
      const defaultPort: Record<string, string> = { 'https:': '443', 'http:': '80', 'ssh:': '22', 'git:': '9418' };
      if (u.port && u.port !== defaultPort[u.protocol]) port = u.port;
    } catch {
      return null;
    }
  }

  host = host.toLowerCase();
  pathPart = pathPart.replace(/^\/+/, '').replace(/\/+$/, '');
  if (pathPart.toLowerCase().endsWith('.git')) pathPart = pathPart.slice(0, -4);
  if (!host || !pathPart) return null;
  return port ? `${host}:${port}/${pathPart}` : `${host}/${pathPart}`;
}

function idFrom(name: string, hashInput: string): string {
  const hash = createHash('sha256').update(hashInput).digest('hex').slice(0, 8);
  return `${name}-${hash}`;
}

/** Remote-derived id: name = last path segment of the canonical remote. */
export function remoteProjectId(canonical: string): string {
  const name = canonical.split('/').filter(Boolean).pop() ?? 'unknown';
  return idFrom(name, canonical);
}

/** Legacy path-hash id (the pre-remote algorithm). Exported so the migration
 *  can compute "what the old id would have been" for a given path. */
export function legacyProjectId(dirPath: string): string {
  const name = dirPath.split('/').filter(Boolean).pop() ?? 'unknown';
  return idFrom(name, dirPath);
}

/**
 * Deterministic project id for a working directory. Prefers the clone-stable
 * git-remote id; falls back to the legacy path hash when there is no remote.
 */
export function projectId(dirPath: string): string {
  const canonical = resolveCanonicalRemote(dirPath);
  return canonical ? remoteProjectId(canonical) : legacyProjectId(dirPath);
}

/** Test-only: clear the remote cache so tests can change a repo's remote and
 *  observe the new id without waiting out the TTL. */
export function __resetProjectIdCacheForTests(): void {
  remoteCache.clear();
}
