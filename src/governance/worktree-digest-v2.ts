/**
 * Worktree digest v2 — concurrent git queries within a snapshot, sequential
 * snapshots for race safety, no hashing of clean tracked content. Split from
 * worktree-digest.ts (phase 4).
 */
import { opendir, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFile, type ExecFileException } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { WORKTREE_DIGEST } from '../constants/index.js';
import {
  DigestIncomplete, WORKTREE_DIGEST_HARD_CEILING_MS, WORKTREE_DIGEST_V2_VERSION, canonical, checkDeadline,
  normalizedPatterns, pathMatcher, sha256, within,
  type Snapshot, type WorktreeDigestV2Options, type WorktreeDigestV2Result,
} from './worktree-digest-shared.js';
import { indexFactsV2, selectedFileFactsV2, statusFactsV2 } from './worktree-digest-v2-facts.js';

function gitAsync(
  root: string,
  args: readonly string[],
  deadlineMs: number,
  allowFailure = false,
): Promise<Buffer | null> {
  const timeout = Math.min(WORKTREE_DIGEST.GIT_TIMEOUT_MS, checkDeadline(deadlineMs));
  return new Promise((resolvePromise, rejectPromise) => {
    execFile('git', [...args], {
      cwd: root, encoding: 'buffer', maxBuffer: WORKTREE_DIGEST.MAX_GIT_OUTPUT_BYTES, timeout,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    }, (error: ExecFileException | null, stdout: Buffer) => {
      if (error === null) {
        resolvePromise(stdout);
        return;
      }
      if (performance.now() >= deadlineMs || error.killed) {
        rejectPromise(new DigestIncomplete('digest deadline exceeded'));
        return;
      }
      if (allowFailure) {
        resolvePromise(null);
        return;
      }
      rejectPromise(new DigestIncomplete(`git ${args[0] ?? 'command'} failed`));
    });
  });
}

async function gitSnapshotV2(
  root: string,
  patterns: readonly string[],
  deadlineMs: number,
  depth = 0,
): Promise<Snapshot> {
  if (depth > 4) throw new DigestIncomplete('submodule nesting exceeds digest bound');
  const matches = pathMatcher(patterns);
  const [gitDirRaw, headRaw, indexRaw, statusRaw] = await Promise.all([
    gitAsync(root, ['rev-parse', '--absolute-git-dir'], deadlineMs),
    gitAsync(root, ['rev-parse', '--verify', 'HEAD'], deadlineMs, true),
    gitAsync(root, ['ls-files', '--stage', '-z'], deadlineMs),
    gitAsync(root, [
      'status', '--porcelain=v2', '-z', '--untracked-files=all', '--ignore-submodules=none',
    ], deadlineMs),
  ]);
  if (gitDirRaw === null || indexRaw === null || statusRaw === null) {
    throw new DigestIncomplete('git snapshot unavailable');
  }
  const identity = await realpath(gitDirRaw.toString('utf8').trim());
  checkDeadline(deadlineMs);
  const symbolicRaw = headRaw === null
    ? await gitAsync(root, ['symbolic-ref', '-q', 'HEAD'], deadlineMs, true) : null;
  const head = headRaw?.toString('utf8').trim() ??
    `unborn:${symbolicRaw?.toString('utf8').trim() || 'detached'}`;
  const indexes = indexFactsV2(indexRaw, matches);
  const statuses = statusFactsV2(statusRaw, matches);
  const untracked = statuses.filter(fact => fact.untracked).flatMap(fact => fact.paths).sort();
  const trackedSymlinks = indexes
    .filter(fact => fact.stage === '0' && fact.mode === '120000')
    .map(fact => fact.path);
  const gitlinks = indexes
    .filter(fact => fact.stage === '0' && fact.mode === '160000')
    .map(fact => fact.path);
  const gitlinkSet = new Set(gitlinks);
  const dirtyWorktree = statuses
    .filter(fact => fact.worktreeDirty)
    .flatMap(fact => fact.paths)
    .filter(path => !gitlinkSet.has(path));
  const contentPaths = [...new Set([...dirtyWorktree, ...untracked, ...trackedSymlinks])];
  if (indexes.length + untracked.length > WORKTREE_DIGEST.MAX_ENTRIES) {
    throw new DigestIncomplete('relevant file count exceeds digest bound');
  }
  const filesPromise = selectedFileFactsV2(root, contentPaths, deadlineMs);
  const submoduleFactsPromise = Promise.all(gitlinks.map(async path => {
    const child = resolve(root, path);
    if (!within(root, child)) throw new DigestIncomplete('submodule path escaped project root');
    try {
      const canonicalChild = await realpath(child);
      const snapshot = await gitSnapshotV2(canonicalChild, ['**'], deadlineMs, depth + 1);
      return `${path}\0${sha256(canonical(snapshot))}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return `${path}\0unavailable`;
      throw error;
    }
  }));
  const [files, submoduleFacts] = await Promise.all([filesPromise, submoduleFactsPromise]);
  return {
    kind: 'git', identity, head,
    index: sha256(indexes.map(fact => fact.canonical).join('\0')),
    status: sha256(statuses.map(fact => fact.canonical).join('\0')),
    submodules: sha256(submoduleFacts.sort().join('\n')),
    files,
  };
}

async function manifestSnapshotV2(
  root: string,
  patterns: readonly string[],
  deadlineMs: number,
): Promise<Snapshot> {
  const matches = pathMatcher(patterns);
  const paths: string[] = [];
  const pending = ['.'];
  let visited = 0;
  while (pending.length > 0) {
    checkDeadline(deadlineMs);
    const relativeDir = pending.pop()!;
    const directory = await opendir(resolve(root, relativeDir));
    for await (const entry of directory) {
      visited += 1;
      if (visited > WORKTREE_DIGEST.MAX_ENTRIES) throw new DigestIncomplete('manifest entry count exceeds digest bound');
      const path = relativeDir === '.' ? entry.name : `${relativeDir}/${entry.name}`;
      if (path === '.git') continue;
      if (entry.isDirectory()) pending.push(path);
      if (matches(path)) paths.push(path);
    }
  }
  const files = await selectedFileFactsV2(root, paths.sort(), deadlineMs);
  return {
    kind: 'manifest', identity: root, head: 'non-git', index: 'non-git',
    status: 'non-git', submodules: 'non-git', files,
  };
}

async function takeSnapshotV2(
  root: string,
  patterns: readonly string[],
  isGit: boolean,
  deadlineMs: number,
): Promise<Snapshot> {
  return isGit
    ? gitSnapshotV2(root, patterns, deadlineMs)
    : manifestSnapshotV2(root, patterns, deadlineMs);
}

/**
 * Capture digest v2 without hashing clean/staged tracked worktree content.
 * Git object ids represent that content; only dirty/untracked/symlink and
 * nested submodule worktree state is read. Git queries within each snapshot
 * are concurrent, while snapshots A and B remain sequential for race safety.
 */
export async function captureWorktreeDigestV2(
  options: WorktreeDigestV2Options,
): Promise<WorktreeDigestV2Result> {
  const patterns = normalizedPatterns(options.relevantPaths);
  const relevantPathsSha256 = sha256(canonical(patterns));
  const deadlineMs = options.deadlineMs ?? performance.now() + WORKTREE_DIGEST_HARD_CEILING_MS;
  let root: string;
  try {
    root = await realpath(resolve(options.projectRoot));
  } catch {
    return {
      status: 'incomplete', digest: null, version: WORKTREE_DIGEST_V2_VERSION,
      relevantPathsSha256, repositoryKind: 'unknown', reason: 'project root is unavailable', attempts: 0,
    };
  }

  let isGit = false;
  let attempt = 0;
  try {
    checkDeadline(deadlineMs);
    const inside = await gitAsync(root, ['rev-parse', '--is-inside-work-tree'], deadlineMs, true);
    isGit = inside?.toString('utf8').trim() === 'true';
    let snapshotNumber = 0;
    for (attempt = 1; attempt <= 2; attempt += 1) {
      const before = await takeSnapshotV2(root, patterns, isGit, deadlineMs);
      await options.onSnapshot?.(++snapshotNumber);
      const after = await takeSnapshotV2(root, patterns, isGit, deadlineMs);
      await options.onSnapshot?.(++snapshotNumber);
      const beforeCanonical = canonical(before);
      if (beforeCanonical === canonical(after)) {
        const digest = sha256(canonical({
          version: WORKTREE_DIGEST_V2_VERSION, root, configSha256: options.configSha256,
          relevantPathsSha256, snapshot: before,
        }));
        return {
          status: 'complete', digest, version: WORKTREE_DIGEST_V2_VERSION,
          relevantPathsSha256, repositoryKind: before.kind, reason: null, attempts: attempt,
        };
      }
    }
    return {
      status: 'incomplete', digest: null, version: WORKTREE_DIGEST_V2_VERSION,
      relevantPathsSha256, repositoryKind: isGit ? 'git' : 'manifest',
      reason: 'worktree changed during both digest attempts', attempts: 2,
    };
  } catch (error) {
    return {
      status: 'incomplete', digest: null, version: WORKTREE_DIGEST_V2_VERSION,
      relevantPathsSha256, repositoryKind: isGit ? 'git' : 'manifest',
      reason: error instanceof DigestIncomplete ? error.message : 'worktree digest self-error',
      attempts: Math.max(attempt, 1),
    };
  }
}
