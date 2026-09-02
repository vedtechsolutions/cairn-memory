/**
 * Phase B2 `waykeep migrate` — rehearsed on a COPY under an isolated fake HOME.
 *
 * The real command migrates the user's LIVE `~/.cairn` memory and must run with
 * the user present (it asks for a restart); these gates never touch it. Each
 * test builds a throwaway home with a seeded fake `~/.cairn` store and drives
 * `runMigrate({ home })` against it, asserting the safety model:
 *   - the legacy store is COPIED, never moved (the rollback path is preserved);
 *   - the marker is written only AFTER row-count parity is verified;
 *   - `resolveStateRoot()` flips to `~/.waykeep` once the marker exists;
 *   - dry-run writes nothing; a second run is an idempotent no-op;
 *   - a pre-existing empty `~/.waykeep/waykeep.db` is moved aside, never clobbered.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync,
  existsSync, statSync, lstatSync, rmSync, chmodSync, symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { openDatabase } from '../src/db/connection.js';
import { MemoryRepository } from '../src/db/memory-repository.js';
import { runMigrate } from '../src/cli/migrate.js';
import { MIGRATION_MARKER, FILES, resolveStateRoot, resetStateRootForTests } from '../src/constants/paths.js';
import { DATA_DIR_NAME, DB_FILENAME, LEGACY_NAMESPACES } from 'waykeep-contract';

const NS = LEGACY_NAMESPACES[0]; // 'cairn'
const LEGACY_DIR_NAME = `.${NS}`; // '.cairn'
const LEGACY_DB_NAME = `${NS}.db`; // 'cairn.db'

const cleanup: string[] = [];
function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'waykeep-b2-'));
  cleanup.push(dir);
  return dir;
}

// runMigrate narrates each step to the console. These gates assert on return
// codes and filesystem state, never on stdout, and the narration's VOLUME (a
// migration per test) floods node:test's serialized IPC channel under
// full-suite parallel load ("Unable to deserialize cloned data"). Silence it.
const realLog = console.log;
const realErr = console.error;
before(() => { console.log = (): void => {}; console.error = (): void => {}; });
after(() => {
  console.log = realLog;
  console.error = realErr;
  for (const d of cleanup) rmSync(d, { recursive: true, force: true });
});

/** Seed a fake legacy `~/.cairn` store with `count` memories; returns count. */
function seedLegacyStore(home: string, count: number): number {
  const legacyDir = join(home, LEGACY_DIR_NAME);
  mkdirSync(legacyDir, { recursive: true });
  const db = openDatabase({ dbPath: join(legacyDir, LEGACY_DB_NAME) });
  try {
    const repo = new MemoryRepository(db);
    for (let i = 0; i < count; i++) {
      repo.create({ content: `seeded memory ${i}`, kind: 'fact', project: 'b2test', skipDedup: true });
    }
  } finally {
    db.close();
  }
  return count;
}

/** Memory rows in a store opened READ-ONLY — mirrors the command's own check. */
function rowCount(dbPath: string): number {
  const db = new Database(dbPath, { readonly: true });
  try { return (db.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number }).n; }
  finally { db.close(); }
}

/** Per-table row counts for every application table — proves the copy carried
 *  EVERY table, not just `memories`. */
function manifest(dbPath: string): Record<string, number> {
  const db = new Database(dbPath, { readonly: true });
  try {
    const out: Record<string, number> = {};
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
    ).all() as { name: string }[];
    for (const { name } of tables) out[name] = (db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number }).n;
    return out;
  } finally { db.close(); }
}

/** Backup files left when a divergent/stray config is moved aside. */
function configBackups(dir: string): string[] {
  return readdirSync(dir).filter((f) => f.startsWith(`${FILES.CONFIG}.pre-migrate-`));
}

/** `PRAGMA foreign_key_check` row count for a store opened READ-ONLY. */
function fkCount(dbPath: string): number {
  const db = new Database(dbPath, { readonly: true });
  try { return (db.prepare('PRAGMA foreign_key_check').all() as unknown[]).length; }
  finally { db.close(); }
}

/** Resolve the state root under a controlled HOME, in-process. `resolveStateRoot`
 *  reads `homedir()` (i.e. HOME) live and memoizes, so we swap HOME, clear the
 *  memo, read, then always restore — no nested subprocess (its extra fork under
 *  full-suite load corrupts the test-runner IPC channel). Subtests in one file
 *  run sequentially, so the transient HOME swap never races a sibling. */
function resolveRootUnderHome(home: string): { dir: string; legacy: boolean } {
  const savedHome = process.env.HOME;
  try {
    process.env.HOME = home;
    resetStateRootForTests();
    const r = resolveStateRoot();
    return { dir: r.dir, legacy: r.legacy };
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    resetStateRootForTests();
  }
}

describe('waykeep migrate (Phase B2, rehearsed on a copy)', () => {
  it('copies the legacy store to ~/.waykeep, verifies row parity, and writes the marker last', async () => {
    const home = tempHome();
    const n = seedLegacyStore(home, 5);

    assert.equal(await runMigrate({ home }), 0);

    const currentDir = join(home, DATA_DIR_NAME);
    const currentDb = join(currentDir, DB_FILENAME);
    const marker = join(currentDir, MIGRATION_MARKER);
    assert.ok(existsSync(currentDb), 'target db must be created');
    assert.equal(rowCount(currentDb), n, 'copied db must carry the same memory count');
    assert.ok(existsSync(marker), 'marker must be written');

    // The legacy store is COPIED, never moved — it survives as a rollback path.
    const legacyDb = join(home, LEGACY_DIR_NAME, LEGACY_DB_NAME);
    assert.ok(existsSync(legacyDb), 'legacy db must remain (copied, never moved)');
    assert.equal(rowCount(legacyDb), n, 'legacy db must be untouched');

    const rec = JSON.parse(readFileSync(marker, 'utf-8')) as { schema: number; memories: number };
    assert.equal(rec.schema, 1, 'marker records its schema version');
    assert.equal(rec.memories, n, 'marker records the verified row count');
  });

  it('makes ~/.waykeep authoritative — resolveStateRoot flips off the legacy root after migration', async () => {
    const home = tempHome();
    seedLegacyStore(home, 3);

    const before = resolveRootUnderHome(home);
    assert.equal(before.legacy, true, 'un-migrated: the legacy root is authoritative');
    assert.equal(before.dir, join(home, LEGACY_DIR_NAME));

    assert.equal(await runMigrate({ home }), 0);

    const afterMigrate = resolveRootUnderHome(home);
    assert.equal(afterMigrate.legacy, false, 'migrated: the current root is authoritative');
    assert.equal(afterMigrate.dir, join(home, DATA_DIR_NAME));
  });

  it('moves a pre-existing empty ~/.waykeep/waykeep.db aside instead of clobbering it', async () => {
    const home = tempHome();
    seedLegacyStore(home, 2);
    const currentDir = join(home, DATA_DIR_NAME);
    mkdirSync(currentDir, { recursive: true });
    // An accidental empty fork already sitting at the target path.
    writeFileSync(join(currentDir, DB_FILENAME), 'STALE');

    assert.equal(await runMigrate({ home }), 0);

    const preserved = readdirSync(currentDir).filter((f) => f.startsWith(`${DB_FILENAME}.pre-migrate-`));
    assert.equal(preserved.length, 1, 'the stale target db must be moved aside, not clobbered');
    assert.equal(readFileSync(join(currentDir, preserved[0]), 'utf-8'), 'STALE', 'the moved-aside copy keeps its bytes');
    assert.equal(rowCount(join(currentDir, DB_FILENAME)), 2, 'the real migrated db replaced the stale fork');
  });

  it('dry-run resolves and reports but writes nothing', async () => {
    const home = tempHome();
    seedLegacyStore(home, 4);

    assert.equal(await runMigrate({ home, dryRun: true }), 0);

    const currentDir = join(home, DATA_DIR_NAME);
    assert.ok(!existsSync(join(currentDir, DB_FILENAME)), 'dry-run must not create the target db');
    assert.ok(!existsSync(join(currentDir, MIGRATION_MARKER)), 'dry-run must not write the marker');
  });

  it('is idempotent — a second run no-ops once the marker exists', async () => {
    const home = tempHome();
    seedLegacyStore(home, 3);
    assert.equal(await runMigrate({ home }), 0);

    const marker = join(home, DATA_DIR_NAME, MIGRATION_MARKER);
    const currentDb = join(home, DATA_DIR_NAME, DB_FILENAME);
    const markerBefore = readFileSync(marker, 'utf-8');
    const dbMtimeBefore = statSync(currentDb).mtimeMs;

    assert.equal(await runMigrate({ home }), 0);

    assert.equal(readFileSync(marker, 'utf-8'), markerBefore, 'marker must not be rewritten on a second run');
    assert.equal(statSync(currentDb).mtimeMs, dbMtimeBefore, 'db must not be re-copied on a second run');
  });

  it('no-ops cleanly when there is no legacy store (fresh install)', async () => {
    const home = tempHome();

    assert.equal(await runMigrate({ home }), 0);

    assert.ok(!existsSync(join(home, DATA_DIR_NAME, MIGRATION_MARKER)), 'no marker is written without a legacy store');
  });

  it('carries the legacy config.json forward when the target has none', async () => {
    const home = tempHome();
    seedLegacyStore(home, 1);
    const config = '{"privacy":"strict"}';
    writeFileSync(join(home, LEGACY_DIR_NAME, FILES.CONFIG), config);

    assert.equal(await runMigrate({ home }), 0);

    const copied = join(home, DATA_DIR_NAME, FILES.CONFIG);
    assert.ok(existsSync(copied), 'legacy config must be carried forward');
    assert.equal(readFileSync(copied, 'utf-8'), config, 'copied config must be byte-identical');
  });

  it('applies the legacy config over a DIVERGENT target config, moving the fork config aside (never dropping privacy)', async () => {
    const home = tempHome();
    seedLegacyStore(home, 2);
    // The exact fork scenario B2 exists for: legacy privacy settings + a stale,
    // divergent ~/.waykeep/config.json that must NOT silently win.
    const legacyConfig = '{"scope":{"privateProjects":["clientwork"]}}';
    writeFileSync(join(home, LEGACY_DIR_NAME, FILES.CONFIG), legacyConfig);
    const currentDir = join(home, DATA_DIR_NAME);
    mkdirSync(currentDir, { recursive: true });
    writeFileSync(join(currentDir, FILES.CONFIG), '{}');

    assert.equal(await runMigrate({ home }), 0);

    const applied = join(currentDir, FILES.CONFIG);
    assert.equal(readFileSync(applied, 'utf-8'), legacyConfig, 'legacy privacy config must be applied, not dropped');
    const backups = configBackups(currentDir);
    assert.equal(backups.length, 1, 'the divergent fork config must be preserved, not clobbered');
    assert.equal(readFileSync(join(currentDir, backups[0]), 'utf-8'), '{}', 'the moved-aside fork config keeps its bytes');
  });

  it('leaves an IDENTICAL target config as-is (no needless move-aside)', async () => {
    const home = tempHome();
    seedLegacyStore(home, 1);
    const config = '{"scope":{"privateProjects":["x"]}}';
    writeFileSync(join(home, LEGACY_DIR_NAME, FILES.CONFIG), config);
    const currentDir = join(home, DATA_DIR_NAME);
    mkdirSync(currentDir, { recursive: true });
    writeFileSync(join(currentDir, FILES.CONFIG), config); // byte-identical

    assert.equal(await runMigrate({ home }), 0);

    assert.equal(readFileSync(join(currentDir, FILES.CONFIG), 'utf-8'), config);
    assert.equal(configBackups(currentDir).length, 0, 'an identical config must not be moved aside');
  });

  it('moves a stray target config aside when the legacy store had none (faithful defaults)', async () => {
    const home = tempHome();
    seedLegacyStore(home, 1); // no legacy config → legacy ran on defaults
    const currentDir = join(home, DATA_DIR_NAME);
    mkdirSync(currentDir, { recursive: true });
    writeFileSync(join(currentDir, FILES.CONFIG), '{"stray":true}');

    assert.equal(await runMigrate({ home }), 0);

    assert.ok(!existsSync(join(currentDir, FILES.CONFIG)), 'a stray fork config must not govern the migrated store');
    const backups = configBackups(currentDir);
    assert.equal(backups.length, 1, 'the stray config must be preserved as a backup');
    assert.equal(readFileSync(join(currentDir, backups[0]), 'utf-8'), '{"stray":true}');
  });

  it('copies EVERY table, not just memories — full per-table manifest parity', async () => {
    const home = tempHome();
    seedLegacyStore(home, 6); // populates memories + FTS + journal tables

    assert.equal(await runMigrate({ home }), 0);

    const legacyDb = join(home, LEGACY_DIR_NAME, LEGACY_DB_NAME);
    const currentDb = join(home, DATA_DIR_NAME, DB_FILENAME);
    const src = manifest(legacyDb);
    assert.ok(Object.keys(src).length > 1, 'seeding must populate more than one table for this to be meaningful');
    assert.deepEqual(manifest(currentDb), src, 'the copy must reproduce every table with the same row counts');
  });

  it('refuses to run while a migration lock is held (no partial state)', async () => {
    const home = tempHome();
    seedLegacyStore(home, 3);
    const currentDir = join(home, DATA_DIR_NAME);
    mkdirSync(currentDir, { recursive: true });
    writeFileSync(join(currentDir, '.migrate.lock'), String(process.pid)); // a lock already held

    assert.equal(await runMigrate({ home }), 1, 'a held lock must refuse the migration');
    assert.ok(!existsSync(join(currentDir, MIGRATION_MARKER)), 'a refused migration must not write the marker');
    assert.ok(!existsSync(join(currentDir, DB_FILENAME)), 'a refused migration must not copy the db');
  });

  it('tightens a group/world-accessible target dir to owner-only before making it authoritative', async () => {
    const home = tempHome();
    seedLegacyStore(home, 1);
    const currentDir = join(home, DATA_DIR_NAME);
    mkdirSync(currentDir, { recursive: true });
    chmodSync(currentDir, 0o777); // a pre-existing loose dir

    assert.equal(await runMigrate({ home }), 0);

    assert.equal(statSync(currentDir).mode & 0o777, 0o700, 'the authoritative dir must be forced owner-only');
  });

  it('aborts when a live daemon is serving the store (a post-snapshot write would be lost)', async () => {
    const home = tempHome();
    seedLegacyStore(home, 3);
    // A live daemon = a pid file naming a running process; our own pid is alive.
    writeFileSync(join(home, LEGACY_DIR_NAME, FILES.PID), String(process.pid));

    assert.equal(await runMigrate({ home }), 1, 'a live daemon must abort the migration');
    assert.ok(!existsSync(join(home, DATA_DIR_NAME, MIGRATION_MARKER)), 'no marker is written when aborted on a live daemon');
    assert.equal(rowCount(join(home, LEGACY_DIR_NAME, LEGACY_DB_NAME)), 3, 'the legacy store is untouched');
  });

  it('moves a symlink at the target db path aside instead of following it out of the secured dir', async () => {
    const home = tempHome();
    seedLegacyStore(home, 2);
    const currentDir = join(home, DATA_DIR_NAME);
    mkdirSync(currentDir, { recursive: true });
    const outside = join(home, 'outside-target.db'); // where a naive .backup() would land
    symlinkSync(outside, join(currentDir, DB_FILENAME)); // dangling symlink at the db path

    assert.equal(await runMigrate({ home }), 0);

    assert.ok(!existsSync(outside), 'the copy must NOT be written through the symlink to outside the dir');
    const st = lstatSync(join(currentDir, DB_FILENAME));
    assert.ok(st.isFile() && !st.isSymbolicLink(), 'the target db must be a real regular file inside the secured dir');
    assert.equal(rowCount(join(currentDir, DB_FILENAME)), 2, 'the migrated db has the seeded rows');
    assert.ok(
      readdirSync(currentDir).some((f) => f.startsWith(`${DB_FILENAME}.pre-migrate-`)),
      'the planted symlink must be moved aside',
    );
  });

  it('does not apply the legacy config THROUGH a symlink at the target config path', async () => {
    const home = tempHome();
    seedLegacyStore(home, 1);
    const legacyConfig = '{"scope":{"privateProjects":["x"]}}';
    writeFileSync(join(home, LEGACY_DIR_NAME, FILES.CONFIG), legacyConfig);
    const currentDir = join(home, DATA_DIR_NAME);
    mkdirSync(currentDir, { recursive: true });
    const outside = join(home, 'outside-config.json');
    symlinkSync(outside, join(currentDir, FILES.CONFIG)); // dangling symlink at the config path

    assert.equal(await runMigrate({ home }), 0);

    assert.ok(!existsSync(outside), 'the legacy config must NOT be written through the symlink');
    const applied = join(currentDir, FILES.CONFIG);
    const st = lstatSync(applied);
    assert.ok(st.isFile() && !st.isSymbolicLink(), 'the applied config must be a real regular file');
    assert.equal(readFileSync(applied, 'utf-8'), legacyConfig, 'the legacy config content is applied');
  });

  it('moves aside a byte-identical config SYMLINK and writes a real file (a symlink is never left authoritative)', async () => {
    const home = tempHome();
    seedLegacyStore(home, 1);
    const cfg = '{"scope":{"privateProjects":["x"]}}';
    writeFileSync(join(home, LEGACY_DIR_NAME, FILES.CONFIG), cfg);
    const currentDir = join(home, DATA_DIR_NAME);
    mkdirSync(currentDir, { recursive: true });
    const identicalTarget = join(home, 'identical-config.json'); // symlink target: byte-identical to legacy
    writeFileSync(identicalTarget, cfg);
    symlinkSync(identicalTarget, join(currentDir, FILES.CONFIG));

    assert.equal(await runMigrate({ home }), 0);

    const applied = join(currentDir, FILES.CONFIG);
    const st = lstatSync(applied);
    assert.ok(st.isFile() && !st.isSymbolicLink(), 'the config must be a real regular file, not a symlink');
    assert.equal(readFileSync(applied, 'utf-8'), cfg);
    assert.equal(configBackups(currentDir).length, 1, 'the symlink is moved aside even though byte-identical');
  });

  it('does not treat a SYMLINK marker as authoritative — it migrates and normalizes it to a real marker file', async () => {
    const home = tempHome();
    seedLegacyStore(home, 2);
    const currentDir = join(home, DATA_DIR_NAME);
    mkdirSync(currentDir, { recursive: true });
    const bait = join(home, 'bait.json');
    writeFileSync(bait, '{}');
    symlinkSync(bait, join(currentDir, MIGRATION_MARKER)); // a symlink named like the marker

    assert.equal(await runMigrate({ home }), 0, 'a symlink marker must not falsely skip the migration');

    const st = lstatSync(join(currentDir, MIGRATION_MARKER));
    assert.ok(st.isFile() && !st.isSymbolicLink(), 'the marker must be normalized to a real regular file');
    assert.equal(rowCount(join(currentDir, DB_FILENAME)), 2, 'the db was actually copied');
    assert.equal(readFileSync(bait, 'utf-8'), '{}', 'the symlink target is left untouched');
  });

  it('aborts when a live daemon is serving the TARGET store, not only the legacy one', async () => {
    const home = tempHome();
    seedLegacyStore(home, 2);
    const currentDir = join(home, DATA_DIR_NAME);
    mkdirSync(currentDir, { recursive: true });
    writeFileSync(join(currentDir, FILES.PID), String(process.pid)); // live daemon on the target

    assert.equal(await runMigrate({ home }), 1, 'a live target-dir daemon must abort too');
    assert.ok(!existsSync(join(currentDir, MIGRATION_MARKER)), 'no marker when aborted on a live target daemon');
  });

  it('the quiescence guard detects a VALUE-ONLY commit — data_version changes on an in-place UPDATE (codex round-4)', () => {
    // The migration holds a readonly connection open and aborts if its data_version
    // moves. This proves the primitive catches a write that leaves row counts intact
    // (e.g. a plan step's status), which the per-table manifest alone would miss.
    const home = tempHome();
    seedLegacyStore(home, 2);
    const dbPath = join(home, LEGACY_DIR_NAME, LEGACY_DB_NAME);
    const guard = new Database(dbPath, { readonly: true });
    try {
      const before = guard.pragma('data_version', { simple: true }) as number;
      const writer = new Database(dbPath); // another connection commits a value-only change
      try { writer.prepare("UPDATE memories SET content = content || '!'").run(); }
      finally { writer.close(); }
      const after = guard.pragma('data_version', { simple: true }) as number;
      assert.notEqual(after, before, 'a value-only commit by another connection must bump data_version');
    } finally {
      guard.close();
    }
  });

  it('migrates faithfully despite PRE-EXISTING foreign-key violations (real stores accumulate them)', async () => {
    const home = tempHome();
    seedLegacyStore(home, 3);
    const legacyDb = join(home, LEGACY_DIR_NAME, LEGACY_DB_NAME);
    // SQLite does not enforce FKs by default, so a real store accumulates orphaned
    // rows (the live ~/.cairn had 7). Reproduce one: a child row with no parent.
    const seed = new Database(legacyDb);
    try {
      seed.pragma('foreign_keys = OFF');
      seed.exec('CREATE TABLE fk_parent(id INTEGER PRIMARY KEY)');
      seed.exec('CREATE TABLE fk_child(id INTEGER PRIMARY KEY, pid INTEGER REFERENCES fk_parent(id))');
      seed.prepare('INSERT INTO fk_child(pid) VALUES (?)').run(999); // orphan → 1 FK violation
    } finally { seed.close(); }
    assert.equal(fkCount(legacyDb), 1, 'the seed must carry exactly one pre-existing FK violation');

    assert.equal(await runMigrate({ home }), 0, 'a pre-existing FK violation must NOT block the migration');

    const currentDb = join(home, DATA_DIR_NAME, DB_FILENAME);
    assert.ok(existsSync(join(home, DATA_DIR_NAME, MIGRATION_MARKER)), 'the marker is written despite the pre-existing violation');
    assert.equal(fkCount(currentDb), 1, 'the copy faithfully preserves the pre-existing violation (7==7 on the real store)');
    assert.equal(rowCount(currentDb), 3, 'memories are copied');
  });

  it('leaves no temp-file litter behind on success', async () => {
    const home = tempHome();
    seedLegacyStore(home, 2);
    const legacyConfig = '{"scope":{"privateProjects":["y"]}}';
    writeFileSync(join(home, LEGACY_DIR_NAME, FILES.CONFIG), legacyConfig);

    assert.equal(await runMigrate({ home }), 0);

    const currentDir = join(home, DATA_DIR_NAME);
    assert.equal(
      readdirSync(currentDir).filter((f) => f.startsWith('.tmp-') || f === '.migrate.lock').length,
      0,
      'no temp files or lock file must remain after a successful migration',
    );
  });
});
