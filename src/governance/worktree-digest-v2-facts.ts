/**
 * Worktree digest v2 — the per-entry facts: status and index records parsed
 * from git's porcelain, and the bounded, deadline-checked file facts read
 * only for dirty, untracked and symlinked paths. Split from
 * worktree-digest.ts (phase 4).
 */
import { lstat, readFile, readlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { WORKTREE_DIGEST } from '../constants/index.js';
import {
  DigestIncomplete, checkDeadline, fieldRemainder, nulFields, sha256, within, type FileFact,
} from './worktree-digest-shared.js';

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

export function statusFactsV2(status: Buffer, matches: (path: string) => boolean): StatusFactV2[] {
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

export function indexFactsV2(index: Buffer, matches: (path: string) => boolean): IndexFactV2[] {
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
  if (stat.size > WORKTREE_DIGEST.MAX_FILE_BYTES) throw new DigestIncomplete('relevant file exceeds digest size bound');
  const content = await readFile(absolute);
  checkDeadline(deadlineMs);
  return {
    fact: { path: relativePath, type: 'file', mode, sha256: sha256(content), target: null },
    bytes: content.byteLength,
  };
}

export async function selectedFileFactsV2(
  root: string,
  paths: readonly string[],
  deadlineMs: number,
): Promise<FileFact[]> {
  let totalBytes = 0;
  const facts: FileFact[] = [];
  for (const path of [...new Set(paths)].sort()) {
    const result = await fileFactV2(root, path, deadlineMs);
    totalBytes += result.bytes;
    if (totalBytes > WORKTREE_DIGEST.MAX_TOTAL_BYTES) throw new DigestIncomplete('relevant content exceeds digest bound');
    facts.push(result.fact);
  }
  return facts;
}
