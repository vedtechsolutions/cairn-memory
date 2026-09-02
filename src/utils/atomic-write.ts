/**
 * Atomic file replacement — ONE implementation of temp-plus-rename.
 *
 * The temp name is UNPREDICTABLE and opened with `wx` (O_CREAT|O_EXCL), so
 * it refuses to open through any pre-existing path, symlinks included: a
 * predictable `<path>.<pid>.tmp` let a planted link at the name a writer
 * would use next redirect the write (Codex pack review, delta Z3). Rename is
 * atomic on POSIX, so a reader sees the old file or the new one, never a
 * torn write. A temp that was created but never renamed is removed, so a
 * failed write leaves no litter. Four copies of the predictable shape lived
 * on after the hardened one was written (audit) — this replaces all of them.
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, closeSync, fsyncSync, lstatSync, openSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { ATOMIC_WRITE } from '../constants/runtime.js';

/** Codes meaning "fsync does not apply to this target" — not "the bytes are not durable". */
const FSYNC_NOT_APPLICABLE: ReadonlySet<string> = new Set(['EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'EISDIR']);

/** fsync a path best-effort — for cases where a failure is fail-closed-safe (a
 *  lost directory entry leaves NO file, so the previous state stays in force).
 *  Some filesystems reject fsync on directories; that's fine. */
export function fsyncPath(p: string): void {
  try { const fd = openSync(p, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
  catch { /* best-effort */ }
}

/** fsync a path and THROW if the bytes are genuinely not durable (EIO, ENOSPC, …).
 *  Only "fsync not implemented for this target" errors are tolerated. */
export function fsyncStrict(p: string): void {
  let fd: number;
  try { fd = openSync(p, 'r'); }
  catch (err) {
    if (FSYNC_NOT_APPLICABLE.has((err as NodeJS.ErrnoException).code ?? '')) return;
    throw err;
  }
  try { fsyncSync(fd); }
  catch (err) {
    if (!FSYNC_NOT_APPLICABLE.has((err as NodeJS.ErrnoException).code ?? '')) throw err;
  } finally { closeSync(fd); }
}

/** A regular file by lstat — a symlink to one does NOT count. */
export function isRegularFile(path: string): boolean {
  try { return lstatSync(path).isFile(); } catch { return false; }
}

/** True when SOMETHING exists at `path` — a dangling symlink included, which
 *  `existsSync` (it follows links) would report as absent. */
function lexists(path: string): boolean {
  try { lstatSync(path); return true; } catch { return false; }
}

/** Test-only fault injection: filesystem failures such as ENOSPC mid-write
 *  or a temp-name collision cannot be produced portably, so the cleanup
 *  and retry contracts are pinned through these seams. Production callers
 *  pass nothing. */
export interface TempSeams {
  /** Overrides the random temp name for a given attempt. */
  tempName?: (attempt: number) => string;
  /** Runs after the exclusive create and before the bytes are written. */
  onCreated?: () => void;
}

/** Create an exclusive temp file beside `target` holding `bytes`; returns its
 *  path. A name collision is retried. Any failure AFTER the create — a full
 *  disk, an I/O error — removes the partial temp before propagating, so no
 *  caller can leak one (Codex review). */
export function writeTempExclusive(target: string, bytes: string | Buffer, mode?: number, seams: TempSeams = {}): string {
  const dir = dirname(target);
  for (let attempt = 0; attempt < ATOMIC_WRITE.TEMP_NAME_ATTEMPTS; attempt++) {
    const tmp = seams.tempName?.(attempt)
      ?? join(dir, `.${basename(target)}.${randomBytes(ATOMIC_WRITE.TEMP_NAME_RANDOM_BYTES).toString('hex')}.tmp`);
    let fd: number;
    try {
      fd = openSync(tmp, 'wx', mode);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw err;
    }
    try {
      seams.onCreated?.();
      const data = typeof bytes === 'string' ? Buffer.from(bytes, 'utf-8') : bytes;
      let offset = 0;
      while (offset < data.length) offset += writeSync(fd, data, offset, data.length - offset);
      closeSync(fd);
      return tmp;
    } catch (err) {
      try { closeSync(fd); } catch { /* already closed */ }
      try { unlinkSync(tmp); } catch { /* nothing to remove */ }
      throw err;
    }
  }
  throw new Error(`could not allocate a temp file beside ${target}`);
}

export interface AtomicWriteOptions {
  /** Mode for the new file (set on the temp, so it is never observable without it). */
  mode?: number;
  /** fsync the bytes (throwing on a genuine durability failure) and the directory
   *  best-effort — for data whose loss would flip an authority decision. */
  durable?: boolean;
  /** Refuse to replace a destination that exists and is not a regular file
   *  (a directory, a symlink) — the pack codec's rule for untrusted dirs. */
  refuseNonRegular?: boolean;
}

/** Replace `target` with `bytes` atomically. */
export function writeFileAtomic(target: string, bytes: string | Buffer, options: AtomicWriteOptions = {}, seams: TempSeams = {}): void {
  // lexists, not existsSync: a DANGLING symlink must be refused too (Codex review).
  if (options.refuseNonRegular && lexists(target) && !isRegularFile(target)) {
    throw new Error(`${basename(target)} exists and is not a regular file — refusing to write through it`);
  }
  const tmp = writeTempExclusive(target, bytes, options.mode, seams);
  let published = false;
  try {
    if (options.mode !== undefined) { try { chmodSync(tmp, options.mode); } catch { /* best-effort on exotic FS */ } }
    if (options.durable) fsyncStrict(tmp);
    renameSync(tmp, target);
    published = true;
    if (options.durable) fsyncPath(dirname(target));
  } finally {
    if (!published) { try { unlinkSync(tmp); } catch { /* nothing to remove */ } }
  }
}
