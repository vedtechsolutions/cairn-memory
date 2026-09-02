/**
 * Filesystem-safety primitives for `waykeep migrate` (Phase B2). Kept separate
 * from the migration orchestration so the durability/atomicity/locking rules —
 * the parts that must be exactly right when moving irreplaceable memory — read
 * as one focused unit. See src/cli/migrate.ts for how they compose.
 */
import {
  statSync, lstatSync, mkdirSync, writeFileSync, renameSync, chmodSync, readFileSync,
  openSync, fsyncSync, closeSync, unlinkSync, linkSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import { FS_PERMS } from '../constants/index.js';
import { isOwnerOnly } from '../mcp/socket-ownership.js';

/** Lock file (inside the target dir) that serializes concurrent migrations. */
export const LOCK_FILE = '.migrate.lock';
/** Database sidecars that must move together with the main file. */
export const DB_SUFFIXES = ['', '-wal', '-shm'] as const;
/** fsync failures that mean "this filesystem does not implement fsync for the
 *  target", NOT "the bytes are not durable" — tolerated. Anything else (EIO,
 *  ENOSPC, …) means the data is NOT on disk and must fail the migration. */
const FSYNC_NOT_APPLICABLE = new Set(['EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'EISDIR']);
/** link(2) failures that mean "this filesystem has no hard links" (FAT, some
 *  network mounts) — fall back to a no-clobber rename rather than fail-closing a
 *  migration that would otherwise succeed. */
const LINK_UNSUPPORTED = new Set(['ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'EMLINK', 'EXDEV']);

export function isFile(p: string): boolean {
  try { return statSync(p).isFile(); } catch { return false; }
}

/** Any filesystem entry at `p` — a symlink included, even a dangling one —
 *  WITHOUT following it. A planted symlink at the db path must be moved aside,
 *  not followed (which would write the store to an unverified location). */
export function lexists(p: string): boolean {
  try { lstatSync(p); return true; } catch { return false; }
}

/** A REAL regular file at `p` — NOT a symlink, even one pointing at a regular
 *  file. lstat-based, so a symlink is never mistaken for the file it targets
 *  (a symlinked marker/config must not read as an authoritative regular one). */
export function isRegularFile(p: string): boolean {
  try { return lstatSync(p).isFile(); } catch { return false; }
}

/** Per-table row counts for EVERY application table (sqlite internals excluded),
 *  from a store opened READ-ONLY. The completeness proof for the copy: a missing
 *  plan/reminder/tombstone/journal row surfaces here even when `memories` matches. */
export function tableManifest(dbPath: string): Map<string, number> {
  const db = new Database(dbPath, { readonly: true });
  try {
    const counts = new Map<string, number>();
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
    ).all() as { name: string }[];
    for (const { name } of tables) {
      // Names come from sqlite_master, not user input; double-quote-escape anyway.
      const row = db.prepare(`SELECT COUNT(*) AS n FROM "${name.replace(/"/g, '""')}"`).get() as { n: number };
      counts.set(name, row.n);
    }
    return counts;
  } finally { db.close(); }
}

/** Every `PRAGMA foreign_key_check` row for a store opened READ-ONLY, as a SORTED
 *  list of stable `(table, rowid, parent, fkid)` keys. SQLite does NOT enforce
 *  foreign keys by default, so a real store carries dangling references (orphaned
 *  rows) that are pre-existing data, not corruption. A faithful `.backup()` yields
 *  the IDENTICAL set on source and copy; the migration requires exact set equality,
 *  so even a count-preserving corruption (one orphan resolved while a different row
 *  is orphaned) is caught — a plain count comparison would miss it (codex review). */
export function fkViolationKeys(dbPath: string): string[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    // safeIntegers so a 64-bit rowid comes back as BigInt, not a float64 that would
    // collapse rowids past 2^53 (e.g. 9007199254740992 and …993) into one key (codex
    // review). JSON.stringify (not a delimiter join) keeps the encoding INJECTIVE — a
    // table/parent name containing a delimiter can't collide two distinct tuples; the
    // BigInt rowid is encoded as its exact decimal string.
    const stmt = db.prepare('PRAGMA foreign_key_check').safeIntegers(true);
    return (stmt.all() as { table: string; rowid: bigint | null; parent: string; fkid: bigint }[])
      .map((v) => JSON.stringify([v.table, v.rowid === null ? null : v.rowid.toString(), v.parent, Number(v.fkid)]))
      .sort();
  } finally { db.close(); }
}

/** Two files compared byte-for-byte; false if either is unreadable. */
export function sameBytes(a: string, b: string): boolean {
  try { return readFileSync(a).equals(readFileSync(b)); } catch { return false; }
}

/** A `.pre-migrate-<stamp>` backup base (for every `suffix` variant) guaranteed
 *  not to exist — never overwrites a prior backup (clock rollback / earlier run).
 *  Uses lexists so a dangling symlink at a candidate slot still counts as taken. */
export function freeBackupPath(base: string, stamp: string, suffixes: readonly string[]): string {
  for (let i = 0; ; i++) {
    const tag = i === 0 ? `pre-migrate-${stamp}` : `pre-migrate-${stamp}.${i}`;
    const candidate = `${base}.${tag}`;
    if (suffixes.every((s) => !lexists(candidate + s))) return candidate;
  }
}

/** fsync a path best-effort — for cases where a failure is fail-closed-safe (a
 *  lost marker directory entry leaves NO marker, so the legacy store stays
 *  authoritative). Some filesystems reject fsync on directories; that's fine. */
export function fsyncPath(p: string): void {
  try { const fd = openSync(p, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
  catch { /* best-effort */ }
}

/** fsync a path and THROW if the bytes are genuinely not durable (EIO, ENOSPC, …).
 *  Only "fsync not implemented for this target" errors are tolerated. Used before
 *  the marker for the db/config, so a silent durability failure cannot flip
 *  authority onto data that is not on disk. */
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

/** Atomic REPLACING publish (for the marker, which the lock makes exclusive):
 *  write an unpredictable `wx` temp, durably fsync it, rename into place, fsync
 *  the dir. Mirrors src/pack/pack.ts's symlink-safe write. Any temp we created
 *  but did not rename into place is removed, so a failed publish leaves no litter. */
export function publishFile(dir: string, name: string, bytes: string | Buffer, mode: number): void {
  const target = join(dir, name);
  for (let attempt = 0; attempt < 3; attempt++) {
    const tmp = join(dir, `.tmp-${randomBytes(8).toString('hex')}`);
    let created = false;
    try {
      writeFileSync(tmp, bytes, { flag: 'wx', mode });
      created = true;
      try { chmodSync(tmp, mode); } catch { /* best-effort on exotic FS */ }
      fsyncStrict(tmp);
      renameSync(tmp, target);
      created = false; // it IS the target now — do not clean it up
      fsyncPath(dir);
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST' && !created) continue; // temp-name collision
      throw err;
    } finally {
      if (created) { try { unlinkSync(tmp); } catch { /* nothing to remove */ } }
    }
  }
  throw new Error(`could not allocate a temp file for ${name}`);
}

/** Atomic NO-REPLACE publish: write a `wx` temp, durably fsync it, then hard-LINK
 *  it into place — link fails EEXIST rather than clobbering, so a file a writer
 *  raced in is never silently deleted. On a collision `moveAside` preserves the
 *  raced file and we retry. Used for the config, whose only possible concurrent
 *  writer is the user editing it by hand. */
export function publishFileNoReplace(
  dir: string, name: string, bytes: string | Buffer, mode: number, moveAside: (raced: string) => void,
): void {
  const target = join(dir, name);
  for (let attempt = 0; attempt < 4; attempt++) {
    const tmp = join(dir, `.tmp-${randomBytes(8).toString('hex')}`);
    let created = false;
    try {
      writeFileSync(tmp, bytes, { flag: 'wx', mode });
      created = true;
      try { chmodSync(tmp, mode); } catch { /* best-effort on exotic FS */ }
      fsyncStrict(tmp);
      try {
        linkSync(tmp, target); // atomic, no-clobber; EEXIST if a writer raced a file in
        fsyncPath(dir);
        return;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code ?? '';
        if (code === 'EEXIST') {
          moveAside(target); // preserve the raced file, then retry the link
        } else if (LINK_UNSUPPORTED.has(code)) {
          // No hard links on this filesystem (FAT, some network mounts). Fall back
          // to a no-clobber rename: preserve any target that exists, then rename in.
          // The tiny check→rename window is acceptable — nothing writes config.json
          // programmatically, so the only racer is a hand edit.
          if (lexists(target)) moveAside(target);
          renameSync(tmp, target);
          created = false; // it IS the target now — do not clean it up
          fsyncPath(dir);
          return;
        } else {
          throw err;
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST' && !created) continue; // temp-name collision
      throw err;
    } finally {
      try { unlinkSync(tmp); } catch { /* never created, or already linked away */ }
    }
  }
  throw new Error(`could not publish ${name} without clobbering a raced file`);
}

/** Force the target dir owner-only and confirm it is self-owned before it is made
 *  authoritative. mkdir's mode never tightens an already-existing loose dir. */
export function secureTargetDir(currentDir: string): boolean {
  mkdirSync(currentDir, { recursive: true, mode: FS_PERMS.DIR });
  try { chmodSync(currentDir, FS_PERMS.DIR); } catch { /* best-effort on exotic FS */ }
  return isOwnerOnly(currentDir, { followSymlink: true });
}

/** Acquire the exclusive migration lock; null when another migration holds it. */
export function acquireLock(currentDir: string): number | null {
  try { return openSync(join(currentDir, LOCK_FILE), 'wx', FS_PERMS.FILE); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return null;
    throw err;
  }
}

export function releaseLock(currentDir: string, fd: number): void {
  try { closeSync(fd); } catch { /* already closed */ }
  try { unlinkSync(join(currentDir, LOCK_FILE)); } catch { /* already gone */ }
}
