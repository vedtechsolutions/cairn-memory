/**
 * Worktree digest — the shared contract and primitives: versions and the
 * hard ceiling, option/result shapes, the snapshot model, the incomplete
 * marker, hashing and canonical JSON, the relevant-path glob grammar,
 * containment, git NUL-record parsing and the deadline check. Split from
 * worktree-digest.ts (phase 4).
 */
import { createHash } from 'node:crypto';
import { isAbsolute, posix, relative, sep } from 'node:path';
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

export interface FileFact {
  path: string;
  type: 'file' | 'symlink' | 'directory' | 'missing' | 'other';
  mode: number | null;
  sha256: string | null;
  target: string | null;
}

export interface Snapshot {
  kind: 'git' | 'manifest';
  identity: string;
  head: string;
  index: string;
  status: string;
  submodules: string;
  files: FileFact[];
}

export class DigestIncomplete extends Error {}

export function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function normalizedPatterns(paths: readonly string[]): string[] {
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

export function pathMatcher(patterns: readonly string[]): (path: string) => boolean {
  // The v1 config validator bounds glob text but deliberately does not narrow
  // it to this adapter's small *, **, ? grammar. Unknown constructs must widen
  // the baseline, never exclude a path and create false freshness.
  if (patterns.some(pattern => /[\[\]{}]/u.test(pattern))) return () => true;
  const regexes = patterns.map(globRegex);
  return path => regexes.some(regex => regex.test(path));
}

export function within(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

export function nulFields(buffer: Buffer): string[] {
  const text = buffer.toString('utf8');
  const fields = text.split('\0');
  if (fields.at(-1) === '') fields.pop();
  return fields;
}

export function fieldRemainder(record: string, fieldCount: number): string | null {
  let cursor = 0;
  for (let field = 0; field < fieldCount; field += 1) {
    const space = record.indexOf(' ', cursor);
    if (space < 0) return null;
    cursor = space + 1;
  }
  return record.slice(cursor);
}

export function checkDeadline(deadlineMs: number): number {
  const remaining = Math.floor(deadlineMs - performance.now());
  if (remaining <= 0) throw new DigestIncomplete('digest deadline exceeded');
  return remaining;
}
