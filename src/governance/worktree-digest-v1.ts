/**
 * Worktree digest v1 — the retained synchronous reader: it hashes every
 * relevant file's content (git or manifest) twice and retries once on a
 * race. Split from worktree-digest.ts (phase 4).
 */
import {
  lstatSync, opendirSync, readFileSync, readlinkSync, realpathSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { WORKTREE_DIGEST } from '../constants/index.js';
import {
  DigestIncomplete, WORKTREE_DIGEST_VERSION, canonical, fieldRemainder, normalizedPatterns, nulFields,
  pathMatcher, sha256, within,
  type FileFact, type Snapshot, type WorktreeDigestOptions, type WorktreeDigestResult,
} from './worktree-digest-shared.js';

function fileFact(root: string, relativePath: string): FileFact {
  const absolute = resolve(root, relativePath);
  if (!within(root, absolute)) throw new DigestIncomplete('manifest path escaped project root');
  let stat;
  try {
    stat = lstatSync(absolute);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return { path: relativePath, type: 'missing', mode: null, sha256: null, target: null };
    }
    throw error;
  }
  const mode = stat.mode & 0o7777;
  if (stat.isSymbolicLink()) {
    return {
      path: relativePath, type: 'symlink', mode,
      sha256: null, target: readlinkSync(absolute, 'utf8'),
    };
  }
  if (stat.isDirectory()) {
    return { path: relativePath, type: 'directory', mode, sha256: null, target: null };
  }
  if (!stat.isFile()) {
    return { path: relativePath, type: 'other', mode, sha256: null, target: null };
  }
  if (stat.size > WORKTREE_DIGEST.MAX_FILE_BYTES) throw new DigestIncomplete('relevant file exceeds digest size bound');
  return {
    path: relativePath, type: 'file', mode,
    sha256: sha256(readFileSync(absolute)), target: null,
  };
}

function git(root: string, args: readonly string[], allowFailure = false): Buffer | null {
  const result = spawnSync('git', [...args], {
    cwd: root, encoding: 'buffer', maxBuffer: WORKTREE_DIGEST.MAX_GIT_OUTPUT_BYTES, timeout: WORKTREE_DIGEST.GIT_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error || result.signal !== null || result.status !== 0) {
    if (allowFailure) return null;
    throw new DigestIncomplete(`git ${args[0] ?? 'command'} failed`);
  }
  return result.stdout;
}

function trackedPaths(index: Buffer): string[] {
  const paths: string[] = [];
  for (const entry of nulFields(index)) {
    const tab = entry.indexOf('\t');
    if (tab < 0) throw new DigestIncomplete('malformed git index output');
    paths.push(entry.slice(tab + 1));
  }
  return [...new Set(paths)].sort();
}

function filteredStatus(status: Buffer, matches: (path: string) => boolean): string[] {
  const fields = nulFields(status);
  const records: string[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const record = fields[index];
    const kind = record[0];
    if (kind === '2') {
      const path = fieldRemainder(record, 9);
      if (path === null || index + 1 >= fields.length) throw new DigestIncomplete('malformed rename status');
      const original = fields[index + 1];
      index += 1;
      if (matches(path) || matches(original)) records.push(`${record}\0${original}`);
      continue;
    }
    const path = kind === '?' || kind === '!'
      ? record.slice(2)
      : kind === '1' ? fieldRemainder(record, 8)
      : kind === 'u' ? fieldRemainder(record, 10)
      : null;
    if (!path) throw new DigestIncomplete('malformed git status output');
    if (matches(path)) records.push(record);
  }
  return records.sort();
}

function gitSnapshot(root: string, patterns: readonly string[]): Snapshot {
  const matches = pathMatcher(patterns);
  const gitDirRaw = git(root, ['rev-parse', '--absolute-git-dir']);
  if (gitDirRaw === null) throw new DigestIncomplete('git directory unavailable');
  const gitDir = realpathSync.native(gitDirRaw.toString('utf8').trim());
  const headRaw = git(root, ['rev-parse', '--verify', 'HEAD'], true);
  const head = headRaw === null
    ? `unborn:${git(root, ['symbolic-ref', '-q', 'HEAD'], true)?.toString('utf8').trim() || 'detached'}`
    : headRaw.toString('utf8').trim();
  const indexRaw = git(root, ['ls-files', '--stage', '-z']);
  const statusRaw = git(root, ['status', '--porcelain=v2', '-z', '--untracked-files=all', '--ignore-submodules=none']);
  const untrackedRaw = git(root, ['ls-files', '--others', '--exclude-standard', '-z']);
  if (indexRaw === null || statusRaw === null || untrackedRaw === null) {
    throw new DigestIncomplete('git snapshot unavailable');
  }
  const relevantTracked = trackedPaths(indexRaw).filter(matches);
  const relevantUntracked = nulFields(untrackedRaw).filter(matches);
  const paths = [...new Set([...relevantTracked, ...relevantUntracked])].sort();
  if (paths.length > WORKTREE_DIGEST.MAX_ENTRIES) throw new DigestIncomplete('relevant file count exceeds digest bound');
  let totalBytes = 0;
  const files = paths.map(path => {
    const fact = fileFact(root, path);
    if (fact.type === 'file') totalBytes += lstatSync(resolve(root, path)).size;
    if (totalBytes > WORKTREE_DIGEST.MAX_TOTAL_BYTES) throw new DigestIncomplete('relevant content exceeds digest bound');
    return fact;
  });
  const relevantIndex = nulFields(indexRaw).filter(entry => {
    const tab = entry.indexOf('\t');
    return tab >= 0 && matches(entry.slice(tab + 1));
  }).sort();
  const hasSubmodules = (() => {
    try { return lstatSync(resolve(root, '.gitmodules')).isFile(); } catch { return false; }
  })();
  const submoduleRaw = git(root, ['submodule', 'status', '--recursive'], !hasSubmodules);
  const submodules = (submoduleRaw?.toString('utf8') ?? '').split('\n')
    .filter(Boolean).filter(line => {
      const match = line.match(/^.\S+\s+([^\s]+)(?:\s|$)/u);
      return match !== null && matches(match[1]);
    }).sort();
  return {
    kind: 'git', identity: gitDir, head,
    index: sha256(relevantIndex.join('\0')),
    status: sha256(filteredStatus(statusRaw, matches).join('\0')),
    submodules: sha256(submodules.join('\n')),
    files,
  };
}

function manifestSnapshot(root: string, patterns: readonly string[]): Snapshot {
  const matches = pathMatcher(patterns);
  const paths: string[] = [];
  const pending = ['.'];
  let visited = 0;
  while (pending.length > 0) {
    const relativeDir = pending.pop()!;
    const directory = opendirSync(resolve(root, relativeDir));
    try {
      for (let entry = directory.readSync(); entry !== null; entry = directory.readSync()) {
        visited += 1;
        if (visited > WORKTREE_DIGEST.MAX_ENTRIES) throw new DigestIncomplete('manifest entry count exceeds digest bound');
        const path = relativeDir === '.' ? entry.name : `${relativeDir}/${entry.name}`;
        if (path === '.git') continue;
        if (entry.isDirectory()) pending.push(path);
        if (matches(path)) paths.push(path);
      }
    } finally {
      directory.closeSync();
    }
  }
  paths.sort();
  let totalBytes = 0;
  const files = paths.map(path => {
    const fact = fileFact(root, path);
    if (fact.type === 'file') totalBytes += lstatSync(resolve(root, path)).size;
    if (totalBytes > WORKTREE_DIGEST.MAX_TOTAL_BYTES) throw new DigestIncomplete('manifest content exceeds digest bound');
    return fact;
  });
  return {
    kind: 'manifest', identity: root, head: 'non-git', index: 'non-git',
    status: 'non-git', submodules: 'non-git', files,
  };
}

function takeSnapshot(root: string, patterns: readonly string[], isGit: boolean): Snapshot {
  return isGit ? gitSnapshot(root, patterns) : manifestSnapshot(root, patterns);
}

/**
 * Capture a content-and-status worktree baseline. Each attempt hashes twice;
 * a change between snapshots retries once, and a second race is incomplete.
 */
export function captureWorktreeDigest(options: WorktreeDigestOptions): WorktreeDigestResult {
  const patterns = normalizedPatterns(options.relevantPaths);
  const relevantPathsSha256 = sha256(canonical(patterns));
  let root: string;
  try {
    root = realpathSync.native(resolve(options.projectRoot));
  } catch {
    return {
      status: 'incomplete', digest: null, version: WORKTREE_DIGEST_VERSION,
      relevantPathsSha256, repositoryKind: 'unknown', reason: 'project root is unavailable', attempts: 0,
    };
  }
  const isGit = git(root, ['rev-parse', '--is-inside-work-tree'], true)?.toString('utf8').trim() === 'true';
  try {
    let snapshotNumber = 0;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const before = takeSnapshot(root, patterns, isGit);
      options.onSnapshot?.(++snapshotNumber);
      const after = takeSnapshot(root, patterns, isGit);
      options.onSnapshot?.(++snapshotNumber);
      const beforeCanonical = canonical(before);
      if (beforeCanonical === canonical(after)) {
        const digest = sha256(canonical({
          version: WORKTREE_DIGEST_VERSION, root, configSha256: options.configSha256,
          relevantPathsSha256, snapshot: before,
        }));
        return {
          status: 'complete', digest, version: WORKTREE_DIGEST_VERSION,
          relevantPathsSha256, repositoryKind: before.kind, reason: null, attempts: attempt,
        };
      }
    }
    return {
      status: 'incomplete', digest: null, version: WORKTREE_DIGEST_VERSION,
      relevantPathsSha256, repositoryKind: isGit ? 'git' : 'manifest',
      reason: 'worktree changed during both digest attempts', attempts: 2,
    };
  } catch (error) {
    return {
      status: 'incomplete', digest: null, version: WORKTREE_DIGEST_VERSION,
      relevantPathsSha256, repositoryKind: isGit ? 'git' : 'manifest',
      reason: error instanceof DigestIncomplete ? error.message : 'worktree digest self-error', attempts: 1,
    };
  }
}
