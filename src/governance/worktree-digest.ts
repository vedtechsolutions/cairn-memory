import { createHash } from 'node:crypto';
import {
  lstatSync, opendirSync, readFileSync, readlinkSync, realpathSync,
} from 'node:fs';
import {
  lstat, opendir, readFile, readlink, realpath,
} from 'node:fs/promises';
import { isAbsolute, posix, relative, resolve, sep } from 'node:path';
import { execFile, spawnSync, type ExecFileException } from 'node:child_process';
import { performance } from 'node:perf_hooks';

export const WORKTREE_DIGEST_V1_VERSION = 1;
/** Compatibility name for the retained synchronous v1 reader. */
export const WORKTREE_DIGEST_VERSION = WORKTREE_DIGEST_V1_VERSION;
export const WORKTREE_DIGEST_V2_VERSION = 2;
export const WORKTREE_DIGEST_HARD_CEILING_MS = 1_000;

export interface WorktreeDigestOptions {
  projectRoot: string;
  relevantPaths: readonly string[];
  configSha256: string;
  /** Test-only observation point used to force a race between snapshots. */
  onSnapshot?: (snapshotNumber: number) => void;
}

export interface WorktreeDigestResult {
  status: 'complete' | 'incomplete';
  digest: string | null;
  version: typeof WORKTREE_DIGEST_VERSION;
  relevantPathsSha256: string;
  repositoryKind: 'git' | 'manifest' | 'unknown';
  reason: string | null;
  attempts: number;
}

export interface WorktreeDigestV2Options {
  projectRoot: string;
  relevantPaths: readonly string[];
  configSha256: string;
  /** Absolute monotonic deadline from performance.now(). Defaults to the 1s hard ceiling. */
  deadlineMs?: number;
  /** Test-only observation point used to force a race between snapshots. */
  onSnapshot?: (snapshotNumber: number) => void | Promise<void>;
}

export interface WorktreeDigestV2Result {
  status: 'complete' | 'incomplete';
  digest: string | null;
  version: typeof WORKTREE_DIGEST_V2_VERSION;
  relevantPathsSha256: string;
  repositoryKind: 'git' | 'manifest' | 'unknown';
  reason: string | null;
  attempts: number;
}

const MAX_ENTRIES = 50_000;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const MAX_GIT_OUTPUT = 32 * 1024 * 1024;
const GIT_TIMEOUT_MS = 10_000;

interface FileFact {
  path: string;
  type: 'file' | 'symlink' | 'directory' | 'missing' | 'other';
  mode: number | null;
  sha256: string | null;
  target: string | null;
}

interface Snapshot {
  kind: 'git' | 'manifest';
  identity: string;
  head: string;
  index: string;
  status: string;
  submodules: string;
  files: FileFact[];
}

class DigestIncomplete extends Error {}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function normalizedPatterns(paths: readonly string[]): string[] {
  const normalized = paths.map(path => posix.normalize(path.replaceAll('\\', '/')).replace(/^\.\//, ''));
  return [...new Set(normalized.length > 0 ? normalized : ['**'])].sort();
}

function globRegex(pattern: string): RegExp {
  let source = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        index += 1;
        if (pattern[index + 1] === '/') {
          index += 1;
          source += '(?:.*/)?';
        } else {
          source += '.*';
        }
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += char.replace(/[\\^$+.()|{}\[\]]/g, '\\$&');
    }
  }
  return new RegExp(`${source}$`, 'u');
}

function pathMatcher(patterns: readonly string[]): (path: string) => boolean {
  // The v1 config validator bounds glob text but deliberately does not narrow
  // it to this adapter's small *, **, ? grammar. Unknown constructs must widen
  // the baseline, never exclude a path and create false freshness.
  if (patterns.some(pattern => /[\[\]{}]/u.test(pattern))) return () => true;
  const regexes = patterns.map(globRegex);
  return path => regexes.some(regex => regex.test(path));
}

function within(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

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
  if (stat.size > MAX_FILE_BYTES) throw new DigestIncomplete('relevant file exceeds digest size bound');
  return {
    path: relativePath, type: 'file', mode,
    sha256: sha256(readFileSync(absolute)), target: null,
  };
}

function git(root: string, args: readonly string[], allowFailure = false): Buffer | null {
  const result = spawnSync('git', [...args], {
    cwd: root, encoding: 'buffer', maxBuffer: MAX_GIT_OUTPUT, timeout: GIT_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error || result.signal !== null || result.status !== 0) {
    if (allowFailure) return null;
    throw new DigestIncomplete(`git ${args[0] ?? 'command'} failed`);
  }
  return result.stdout;
}

function nulFields(buffer: Buffer): string[] {
  const text = buffer.toString('utf8');
  const fields = text.split('\0');
  if (fields.at(-1) === '') fields.pop();
  return fields;
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

function fieldRemainder(record: string, fieldCount: number): string | null {
  let cursor = 0;
  for (let field = 0; field < fieldCount; field += 1) {
    const space = record.indexOf(' ', cursor);
    if (space < 0) return null;
    cursor = space + 1;
  }
  return record.slice(cursor);
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
  if (paths.length > MAX_ENTRIES) throw new DigestIncomplete('relevant file count exceeds digest bound');
  let totalBytes = 0;
  const files = paths.map(path => {
    const fact = fileFact(root, path);
    if (fact.type === 'file') totalBytes += lstatSync(resolve(root, path)).size;
    if (totalBytes > MAX_TOTAL_BYTES) throw new DigestIncomplete('relevant content exceeds digest bound');
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
        if (visited > MAX_ENTRIES) throw new DigestIncomplete('manifest entry count exceeds digest bound');
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
    if (totalBytes > MAX_TOTAL_BYTES) throw new DigestIncomplete('manifest content exceeds digest bound');
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

interface StatusFactV2 {
  canonical: string;
  paths: string[];
  worktreeDirty: boolean;
  untracked: boolean;
}

interface IndexFactV2 {
  canonical: string;
  path: string;
  mode: string;
  stage: string;
}

interface AsyncFileFact {
  fact: FileFact;
  bytes: number;
}

function checkDeadline(deadlineMs: number): number {
  const remaining = Math.floor(deadlineMs - performance.now());
  if (remaining <= 0) throw new DigestIncomplete('digest deadline exceeded');
  return remaining;
}

function gitAsync(
  root: string,
  args: readonly string[],
  deadlineMs: number,
  allowFailure = false,
): Promise<Buffer | null> {
  const timeout = Math.min(GIT_TIMEOUT_MS, checkDeadline(deadlineMs));
  return new Promise((resolvePromise, rejectPromise) => {
    execFile('git', [...args], {
      cwd: root, encoding: 'buffer', maxBuffer: MAX_GIT_OUTPUT, timeout,
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

function statusFactsV2(status: Buffer, matches: (path: string) => boolean): StatusFactV2[] {
  const fields = nulFields(status);
  const facts: StatusFactV2[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const record = fields[index];
    const kind = record[0];
    if (kind === '2') {
      const path = fieldRemainder(record, 9);
      if (path === null || index + 1 >= fields.length) {
        throw new DigestIncomplete('malformed rename status');
      }
      const original = fields[index + 1];
      index += 1;
      if (matches(path) || matches(original)) {
        const [_, xy, submodule] = record.split(' ', 3);
        facts.push({
          canonical: `${record}\0${original}`,
          paths: [path, original],
          worktreeDirty: (xy?.[1] ?? '.') !== '.' || (submodule ?? 'N...') !== 'N...',
          untracked: false,
        });
      }
      continue;
    }
    const path = kind === '?' || kind === '!'
      ? record.slice(2)
      : kind === '1' ? fieldRemainder(record, 8)
      : kind === 'u' ? fieldRemainder(record, 10)
      : null;
    if (!path) throw new DigestIncomplete('malformed git status output');
    if (!matches(path)) continue;
    const [_, xy, submodule] = record.split(' ', 3);
    facts.push({
      canonical: record,
      paths: [path],
      worktreeDirty: kind === '?' || kind === 'u' ||
        (kind === '1' && ((xy?.[1] ?? '.') !== '.' || (submodule ?? 'N...') !== 'N...')),
      untracked: kind === '?',
    });
  }
  return facts.sort((left, right) =>
    left.canonical < right.canonical ? -1 : left.canonical > right.canonical ? 1 : 0);
}

function indexFactsV2(index: Buffer, matches: (path: string) => boolean): IndexFactV2[] {
  const facts: IndexFactV2[] = [];
  for (const entry of nulFields(index)) {
    const match = entry.match(/^([0-7]{6}) ([0-9a-f]+) ([0-3])\t(.+)$/u);
    if (match === null) throw new DigestIncomplete('malformed git index output');
    const [, mode, objectId, stage, path] = match;
    if (!matches(path)) continue;
    facts.push({ canonical: `${mode} ${objectId} ${stage}\t${path}`, path, mode, stage });
  }
  return facts.sort((left, right) =>
    left.canonical < right.canonical ? -1 : left.canonical > right.canonical ? 1 : 0);
}

async function fileFactV2(
  root: string,
  relativePath: string,
  deadlineMs: number,
): Promise<AsyncFileFact> {
  checkDeadline(deadlineMs);
  const absolute = resolve(root, relativePath);
  if (!within(root, absolute)) throw new DigestIncomplete('manifest path escaped project root');
  let stat;
  try {
    stat = await lstat(absolute);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return {
        fact: { path: relativePath, type: 'missing', mode: null, sha256: null, target: null },
        bytes: 0,
      };
    }
    throw error;
  }
  const mode = stat.mode & 0o7777;
  if (stat.isSymbolicLink()) {
    const target = await readlink(absolute, { encoding: 'utf8' });
    checkDeadline(deadlineMs);
    return {
      fact: { path: relativePath, type: 'symlink', mode, sha256: null, target },
      bytes: Buffer.byteLength(target),
    };
  }
  if (stat.isDirectory()) {
    return {
      fact: { path: relativePath, type: 'directory', mode, sha256: null, target: null }, bytes: 0,
    };
  }
  if (!stat.isFile()) {
    return {
      fact: { path: relativePath, type: 'other', mode, sha256: null, target: null }, bytes: 0,
    };
  }
  if (stat.size > MAX_FILE_BYTES) throw new DigestIncomplete('relevant file exceeds digest size bound');
  const content = await readFile(absolute);
  checkDeadline(deadlineMs);
  return {
    fact: { path: relativePath, type: 'file', mode, sha256: sha256(content), target: null },
    bytes: content.byteLength,
  };
}

async function selectedFileFactsV2(
  root: string,
  paths: readonly string[],
  deadlineMs: number,
): Promise<FileFact[]> {
  let totalBytes = 0;
  const facts: FileFact[] = [];
  for (const path of [...new Set(paths)].sort()) {
    const result = await fileFactV2(root, path, deadlineMs);
    totalBytes += result.bytes;
    if (totalBytes > MAX_TOTAL_BYTES) throw new DigestIncomplete('relevant content exceeds digest bound');
    facts.push(result.fact);
  }
  return facts;
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
  if (indexes.length + untracked.length > MAX_ENTRIES) {
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
      if (visited > MAX_ENTRIES) throw new DigestIncomplete('manifest entry count exceeds digest bound');
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
