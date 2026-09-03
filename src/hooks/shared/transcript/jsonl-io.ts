/**
 * Low-level transcript file access: path validation plus bookend
 * (head/tail) reads for large JSONL files.
 */
import { openSync, readSync, closeSync, realpathSync, constants } from 'node:fs';
import { resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { ENV } from '../../../constants/env.js';
import { CLAUDE_CODE } from '../../../constants/claude-code.js';

/** Bytes to read from head of large files for initial goal extraction */
export const HEAD_READ_BYTES = 32 * 1024; // 32KB — enough to capture first few user messages

/** Open flags for transcript reads: read-only and refuse to follow a symlink
 *  at the final path component (paired with the realpath check below). Falls
 *  back to plain O_RDONLY where O_NOFOLLOW is unavailable (non-POSIX hosts). */
const READ_NOFOLLOW = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);

/** Validate transcript path is absolute and under expected directories.
 *  Real Claude Code transcripts live under ~/.claude/ — that is the only
 *  production allowlist entry. The OS tmpdir (tmpdir() rather than a
 *  hardcoded '/tmp/', for macOS /var/folders and systemd PrivateTmp) is
 *  world-writable, so it is admitted only when WAYKEEP_ALLOW_TMP_TRANSCRIPTS
 *  is set — tests/hermetic-env.cjs sets it for mkdtemp fixtures (M3).
 *
 *  The path is checked both lexically and after symlink resolution (M4): a
 *  link planted inside an allowed dir must not redirect the read to an
 *  arbitrary target, so both the given path and its realpath must be
 *  contained. A path that does not exist yet falls back to the lexical check
 *  — the subsequent open fails on its own. */
export function isSafeTranscriptPath(p: string): boolean {
  if (!p || typeof p !== 'string') return false;
  const resolved = resolve(p);
  const home = homedir();
  const roots = [`${home}/${CLAUDE_CODE.CONFIG_DIR}`];
  if (process.env[ENV.ALLOW_TMP_TRANSCRIPTS]) roots.push(tmpdir());
  // Canonicalize target and each allowed root, then require the target's real
  // path to sit under a root's real path. Canonicalizing both sides keeps a
  // symlinked temp root (e.g. macOS /tmp -> /private/tmp) from false-negating,
  // while a symlink escaping an allowed dir still fails the containment check.
  let canonical = resolved;
  try { canonical = realpathSync.native(resolved); } catch { /* nonexistent — lexical fallback */ }
  return roots.some(root => {
    let canonRoot = root;
    try { canonRoot = realpathSync.native(root); } catch { /* absent root — keep lexical */ }
    const rootSep = canonRoot.endsWith('/') ? canonRoot : `${canonRoot}/`;
    return canonical.startsWith(rootSep);
  });
}

/** Read the head of a large file synchronously (for initial goal extraction) */
export function readHead(filePath: string, headBytes: number): string {
  const buf = Buffer.alloc(headBytes);
  const fd = openSync(filePath, READ_NOFOLLOW);
  try {
    readSync(fd, buf, 0, headBytes, 0);
  } finally {
    closeSync(fd);
  }
  const raw = buf.toString('utf-8');
  // Trim partial last line
  const lastNewline = raw.lastIndexOf('\n');
  return lastNewline >= 0 ? raw.slice(0, lastNewline) : raw;
}

/** Read the tail of a large file synchronously */
export function readTail(filePath: string, fileSize: number, tailBytes: number): string {
  const offset = Math.max(0, fileSize - tailBytes);
  const bytesToRead = fileSize - offset;
  const buf = Buffer.alloc(bytesToRead);
  const fd = openSync(filePath, READ_NOFOLLOW);
  try {
    readSync(fd, buf, 0, bytesToRead, offset);
  } finally {
    closeSync(fd);
  }
  const raw = buf.toString('utf-8');
  // Skip partial first line (we likely landed mid-line)
  const firstNewline = raw.indexOf('\n');
  return firstNewline >= 0 ? raw.slice(firstNewline + 1) : raw;
}
