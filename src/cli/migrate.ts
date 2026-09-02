/**
 * `waykeep migrate` — Phase B2: migrate the HOME store from the legacy
 * `~/.cairn` to the current `~/.waykeep`, then write the migration marker that
 * makes `~/.waykeep` authoritative (see `resolveStateRoot()`).
 *
 * SAFETY MODEL (the store is the user's real, irreplaceable memory):
 *   - The legacy store is COPIED, never moved — `~/.cairn` is left fully intact
 *     as a rollback path. The database is copied with the SQLite online-backup
 *     API (WAL-safe: a consistent single-file snapshot from a READ-ONLY source)
 *     — never a raw file copy, which would drop un-checkpointed WAL frames.
 *   - The db AND config migrate together as one coherent unit: a divergent target
 *     config (a fork artifact — the authoritative pre-migration config lived
 *     under the legacy root) is moved aside and the legacy config applied, so the
 *     user's privacy settings never silently fail to carry (dual review).
 *   - The copy is VERIFIED before the marker: integrity_check, foreign_key_check,
 *     and a per-table row-count manifest across EVERY table — not just `memories`
 *     (plans, reminders, tombstones and journals count too), so a truncated copy
 *     or a zero-memory-but-populated store cannot pass vacuously.
 *   - The database and config are fsync'd, then the marker is published LAST via a
 *     temp-file + atomic rename (never a truncating in-place write): a partial or
 *     power-lost migration never flips authority to a half-populated store.
 *   - A cross-process lock serializes concurrent invocations; the marker is
 *     re-checked under the lock so a race cannot flip authority onto an absent db.
 *   - Idempotent: a marker already present ⇒ no-op. No legacy store ⇒ no-op.
 *   - A pre-existing target db/config (an accidental fork) is moved aside to a
 *     COLLISION-FREE timestamped backup, never clobbered.
 *   - The target dir is forced owner-only (0700) and verified self-owned before it
 *     is made authoritative — directory containment is the store's access boundary
 *     (mirrors socket-ownership), which is why the per-file chmod stays best-effort.
 *
 * The migration takes effect only after the agent/daemon RESTARTS. For a clean
 * copy the daemon should be STOPPED first; the command says both.
 */
import { renameSync, chmodSync, readFileSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import { LEGACY_NAMESPACES, DATA_DIR_NAME, DB_FILENAME } from 'waykeep-contract';
import { MIGRATION_MARKER, FILES, realHomeDataDir } from '../constants/paths.js';
import { FS_PERMS } from '../constants/index.js';
import {
  LOCK_FILE, DB_SUFFIXES, isFile, lexists, isRegularFile, tableManifest, fkViolationKeys, freeBackupPath,
  fsyncStrict, publishFile, secureTargetDir, acquireLock, releaseLock,
} from './migrate-fs.js';
import { planConfig, describeConfig, applyConfig } from './migrate-config.js';

/** Marker schema version — bump if the recorded fields change. */
const MARKER_SCHEMA = 1;

export interface MigrateOptions {
  /** Preview only — resolve and report, write nothing. */
  dryRun?: boolean;
  /** Home root to migrate under. Defaults to the resolved absolute home; tests
   *  pass an isolated fake home so they never touch a real legacy `~/.cairn`. */
  home?: string;
}

/** A live daemon holding a store dir open — a PID file naming a running process.
 *  A live daemon is a concurrent DB writer: a memory it commits AFTER the backup
 *  snapshot is absent from the copy yet still in legacy, so it would vanish once
 *  authority flips. The migration therefore ABORTS (not just warns) when one is
 *  found, on either the source or the target dir. */
function daemonPidAt(dir: string): number | null {
  const pidFile = join(dir, FILES.PID);
  if (!isFile(pidFile)) return null;
  try {
    const pid = Number(readFileSync(pidFile, 'utf-8').trim());
    if (!Number.isFinite(pid) || pid <= 0) return null;
    process.kill(pid, 0); // throws if the process is gone
    return pid;
  } catch { return null; }
}

export async function runMigrate(opts: MigrateOptions = {}): Promise<number> {
  const dry = opts.dryRun === true;
  const home = opts.home ?? dirname(realHomeDataDir());
  const ns = LEGACY_NAMESPACES[0];
  const legacyDir = join(home, `.${ns}`);
  const legacyDb = join(legacyDir, `${ns}.db`);
  const legacyConfig = join(legacyDir, FILES.CONFIG);
  const currentDir = join(home, DATA_DIR_NAME);
  const currentDb = join(currentDir, DB_FILENAME);
  const currentConfig = join(currentDir, FILES.CONFIG);
  const markerPath = join(currentDir, MIGRATION_MARKER);

  // Idempotent no-ops (also short-circuit dry-run). isRegularFile, not isFile: a
  // symlink named like the marker must not read as an authoritative marker (it
  // would falsely skip the migration); this run replaces it with a real file.
  if (isRegularFile(markerPath)) {
    console.log(`= already migrated — ${markerPath} exists; ${currentDir} is authoritative. Nothing to do.`);
    return 0;
  }
  if (!isFile(legacyDb)) {
    console.log(`= no legacy store at ${legacyDb} — this install is already on ${currentDir} (or is fresh). Nothing to do.`);
    return 0;
  }

  const sourceManifest = tableManifest(legacyDb);
  const sourceMemories = sourceManifest.get('memories') ?? 0;
  const daemon = daemonPidAt(legacyDir) ?? daemonPidAt(currentDir);

  console.log(`Migrate ${legacyDir} → ${currentDir}`);
  console.log(`  source db: ${legacyDb} (${sourceMemories} memories)`);
  console.log(`  target db: ${currentDb}`);
  const configLine = describeConfig(planConfig(legacyConfig, currentConfig), legacyConfig, currentConfig);
  if (configLine) console.log(configLine);
  if (daemon !== null) {
    console.log(`  ! a daemon (pid ${daemon}) is serving the store — STOP it before migrating (a live daemon can commit a memory the copy would miss), then restart it after.`);
  }

  if (dry) {
    console.log(`\n(dry run — nothing written. ${legacyDir} would be left intact as a backup.)`);
    return 0;
  }

  // --- write path ---
  // A live daemon is a concurrent DB writer — abort rather than lose a memory it
  // commits after the snapshot. Re-checked here: one may have started since the
  // preview above.
  const liveDaemon = daemonPidAt(legacyDir) ?? daemonPidAt(currentDir);
  if (liveDaemon !== null) {
    console.error(`✗ migration ABORTED — a daemon (pid ${liveDaemon}) is still serving the store. Stop it first (a memory it commits after the copy would be lost once authority flips), then re-run. No marker written; ${legacyDir} stays authoritative.`);
    return 1;
  }

  if (!secureTargetDir(currentDir)) {
    console.error(`✗ migration ABORTED — ${currentDir} is not an owner-only, self-owned directory (group/other-accessible or foreign-owned). Fix its ownership and run \`chmod 700\` on it, then re-run. No marker written; ${legacyDir} stays authoritative.`);
    return 1;
  }

  const lockFd = acquireLock(currentDir);
  if (lockFd === null) {
    console.error(`✗ another migration is already in progress (${join(currentDir, LOCK_FILE)} is held). If none is running, delete that stale lock file and re-run.`);
    return 1;
  }
  let guard: InstanceType<typeof Database> | null = null;
  try {
    // Re-check under the lock: a concurrent migration may have just published.
    if (isRegularFile(markerPath)) {
      console.log(`= already migrated (a concurrent run won the race) — ${currentDir} is authoritative. Nothing to do.`);
      return 0;
    }
    // And re-check the daemon under the lock — one may have started since the
    // pre-lock check (a late writer could otherwise commit past the snapshot).
    const raceDaemon = daemonPidAt(legacyDir) ?? daemonPidAt(currentDir);
    if (raceDaemon !== null) {
      console.error(`✗ migration ABORTED — a daemon (pid ${raceDaemon}) started serving the store. Stop it and re-run. No marker written; ${legacyDir} stays authoritative.`);
      return 1;
    }

    // Hold ONE source connection open across the whole copy+verify. Its
    // `data_version` changes iff ANOTHER connection commits to the legacy db — so
    // this catches VALUE-ONLY writes (e.g. a plan step's status/timestamp) that
    // leave every table's row count unchanged and would otherwise slip past the
    // manifest (codex round-4). It needs no cooperation from other openers.
    guard = new Database(legacyDb, { readonly: true });
    const dataVersionBefore = guard.pragma('data_version', { simple: true }) as number;

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');

    // Never write THROUGH a pre-existing target db entry — an accidental fork, or a
    // planted symlink that `.backup()` would follow to an unverified location — move
    // it and any WAL/SHM sidecars aside to a COLLISION-FREE backup first. lexists,
    // not isFile, so a symlink (even a dangling one) is moved aside, not followed.
    if (DB_SUFFIXES.some((s) => lexists(currentDb + s))) {
      const asideBase = freeBackupPath(currentDb, stamp, DB_SUFFIXES);
      for (const suffix of DB_SUFFIXES) {
        if (lexists(currentDb + suffix)) renameSync(currentDb + suffix, asideBase + suffix);
      }
      console.log(`  moved a pre-existing ${currentDb} aside to ${asideBase}`);
    }

    // WAL-safe online backup from a READ-ONLY source to a PRIVATE, unpublished stage
    // path. Its random name is known to nothing external, so the copy's content is stable
    // through verification — closing the race where a writer commits to the KNOWN target
    // path between the backup and a post-hoc guard baseline (codex). Published atomically.
    const stageDb = join(currentDir, `.migrating-${randomBytes(8).toString('hex')}.db`);
    const cleanupStage = (): void => {
      for (const s of DB_SUFFIXES) { try { unlinkSync(stageDb + s); } catch { /* not present */ } }
    };
    let targetMemories = 0;
    try {
      const src = new Database(legacyDb, { readonly: true });
      try { await src.backup(stageDb); } finally { src.close(); }

      // Collapse the stage to a SINGLE self-contained file: `.backup()` inherits the
      // source's WAL mode, so opening the copy spawns -wal/-shm sidecars. A rollback
      // journal checkpoints all content into the main file and drops them, so the atomic
      // rename publishes ONE complete inode, nothing orphaned (the daemon re-enables WAL).
      const collapse = new Database(stageDb);
      try { collapse.pragma('journal_mode = DELETE'); } finally { collapse.close(); }

      // Verify the private stage: integrity, foreign-key fidelity, per-table manifest.
      const verify = new Database(stageDb, { readonly: true });
      let integrity: string;
      try { integrity = (verify.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check; }
      finally { verify.close(); }
      if (integrity !== 'ok') {
        console.error(`✗ migration ABORTED — the copied database failed its integrity check (${integrity}). No marker written; ${legacyDir} stays authoritative.`);
        cleanupStage();
        return 1;
      }
      // Foreign-key fidelity: the copy must carry the IDENTICAL set of FK violations as
      // the source (SQLite doesn't enforce FKs, so pre-existing dangling refs are normal
      // data). The full (table, rowid, parent, fkid) set — not just the count — also
      // catches a count-preserving swap (one orphan resolved, a different row orphaned).
      const sourceFk = fkViolationKeys(legacyDb);
      const stageFk = fkViolationKeys(stageDb);
      if (sourceFk.length !== stageFk.length || sourceFk.some((k, i) => k !== stageFk[i])) {
        console.error(`✗ migration ABORTED — the copy's foreign-key violation set differs from the source's (source ${sourceFk.length}, copy ${stageFk.length}) — the copy is not faithful. No marker written; ${legacyDir} stays authoritative.`);
        cleanupStage();
        return 1;
      }
      // Per-table row-count parity, source vs the stage.
      const sourceManifest = tableManifest(legacyDb);
      const stageManifest = tableManifest(stageDb);
      const drift = [...new Set([...sourceManifest.keys(), ...stageManifest.keys()])]
        .filter((t) => (sourceManifest.get(t) ?? 0) !== (stageManifest.get(t) ?? 0))
        .map((t) => `${t} (legacy ${sourceManifest.get(t) ?? 0}, copy ${stageManifest.get(t) ?? 0})`);
      if (drift.length > 0) {
        console.error(`✗ migration ABORTED — row-count mismatch after the copy: ${drift.join(', ')}. No marker written; ${legacyDir} stays authoritative.`);
        cleanupStage();
        return 1;
      }
      targetMemories = stageManifest.get('memories') ?? 0;
      if (stageFk.length > 0) {
        console.log(`  note: ${stageFk.length} pre-existing foreign-key violation(s) in ${legacyDir} (SQLite does not enforce FKs) copied faithfully — identical set, not introduced by the migration.`);
      }

      // The SOURCE must not have changed during backup+verify — data_version on the held
      // source connection, as the LAST source read before we commit. (The stage needs no
      // such guard: its path is private, so nothing external can have written to it.)
      if ((guard.pragma('data_version', { simple: true }) as number) !== dataVersionBefore) {
        console.error(`✗ migration ABORTED — the legacy store was modified during the copy (a writer committed a change, including a possibly value-only one). Stop all agents/daemons and re-run. No marker written; ${legacyDir} stays authoritative.`);
        cleanupStage();
        return 1;
      }

      // Durability, then ATOMIC PUBLISH: fsync the verified stage's content, then rename
      // it into place — a single atomic step, so the published inode IS the verified one
      // and no writer can have touched the target path before publication.
      try { chmodSync(stageDb, FS_PERMS.FILE); } catch { /* best-effort; the 0700 dir is the access boundary */ }
      try { fsyncStrict(stageDb); }
      catch (err) {
        console.error(`✗ migration ABORTED — could not durably fsync the copy (${(err as Error).message}); it is not on disk. No marker written; ${legacyDir} stays authoritative.`);
        cleanupStage();
        return 1;
      }
      renameSync(stageDb, currentDb);
    } catch (err) {
      cleanupStage();
      throw err;
    }

    // Carry the config as one coherent unit with the db (recomputed under the lock
    // — a foreign writer may have created the target config since the preview, and
    // the legacy privacy config must never be silently dropped for a fork's).
    const configPlan = planConfig(legacyConfig, currentConfig);
    applyConfig(configPlan, legacyConfig, currentConfig, currentDir, stamp);
    // An identical target config was left in place; make its bytes durable too — a
    // fork may have written it without fsync, and the marker must not outlive it.
    if (configPlan.kind === 'identical') {
      try { fsyncStrict(currentConfig); }
      catch (err) {
        console.error(`✗ migration ABORTED — could not durably fsync ${currentConfig} (${(err as Error).message}). No marker written; ${legacyDir} stays authoritative.`);
        return 1;
      }
    }

    // The published db entry + config entry must be durable before the marker flips
    // authority (the db CONTENT is already durable from the stage fsync); a swallowed
    // EIO/ENOSPC would let a crash persist the marker over a not-yet-durable rename.
    try {
      fsyncStrict(currentDir);
    } catch (err) {
      console.error(`✗ migration ABORTED — could not durably fsync ${currentDir} (${(err as Error).message}). No marker written; ${legacyDir} stays authoritative.`);
      return 1;
    }

    const marker = {
      schema: MARKER_SCHEMA,
      migratedAt: new Date().toISOString(),
      from: { dir: legacyDir, db: legacyDb },
      to: { dir: currentDir, db: currentDb },
      memories: targetMemories,
      note: `${legacyDir} was COPIED, not moved — it remains intact as a rollback backup.`,
    };
    publishFile(currentDir, MIGRATION_MARKER, `${JSON.stringify(marker, null, 2)}\n`, FS_PERMS.FILE);

    console.log(`\n✓ migrated ${targetMemories} memories to ${currentDb} and wrote ${markerPath}.`);
    console.log(`  ${legacyDir} is untouched — keep it until you have confirmed the new store, then remove it.`);
    console.log(`  START your agent/daemon now so it serves the new store.`);
    console.log(`  To roll back: stop your agent first, delete ${markerPath}, then restart — authority reverts to ${legacyDir} (the store root is chosen once per process, so a running agent keeps using ${currentDir} until it exits). ${legacyDir} holds this migration's snapshot; anything written to ${currentDir} afterward stays only there.`);
    return 0;
  } finally {
    if (guard) { try { guard.close(); } catch { /* already closed */ } }
    releaseLock(currentDir, lockFd);
  }
}
