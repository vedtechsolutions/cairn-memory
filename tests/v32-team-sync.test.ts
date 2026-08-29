import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/db/connection.js';
import { MemoryRepository } from '../src/db/memory-repository.js';
import { migrateToV32 } from '../src/db/migrations/v32-team-sync.js';
import { moveProjectRows, migrateProjectIdentity, __resetProjectMigrationForTests } from '../src/db/project-identity-migration.js';
import { projectId, legacyProjectId, __resetProjectIdCacheForTests } from '../src/utils/project-id.js';

const cleanupDirs: string[] = [];
after(() => { for (const d of cleanupDirs) rmSync(d, { recursive: true, force: true }); });

const V32_TABLES = [
  'memory_tombstones', 'sync_entity_map', 'sync_alias_log',
  'sync_conflict_sets', 'sync_contributors', 'sync_state', 'sync_journal',
];

function tableNames(db: ReturnType<typeof openDatabase>): Set<string> {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
}

describe('v32 team-sync schema', () => {
  it('a fresh database carries the three memory columns and all v32 tables', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    try {
      const cols = new Set((db.prepare('PRAGMA table_info(memories)').all() as Array<{ name: string }>).map((c) => c.name));
      for (const c of ['author', 'updated_at', 'share_state']) assert.ok(cols.has(c), `memories.${c}`);
      const tables = tableNames(db);
      for (const t of V32_TABLES) assert.ok(tables.has(t), t);
      assert.equal((db.prepare('SELECT version FROM schema_version').get() as { version: number }).version, 32);
    } finally {
      db.close();
    }
  });

  it('share_state accepts local/team/NULL and rejects anything else', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    try {
      const repo = new MemoryRepository(db);
      const { id } = repo.create({ content: 'tri-state row', kind: 'fact', project: 'p', skipDedup: true });
      db.prepare("UPDATE memories SET share_state = 'local' WHERE id = ?").run(id);
      db.prepare("UPDATE memories SET share_state = 'team' WHERE id = ?").run(id);
      db.prepare('UPDATE memories SET share_state = NULL WHERE id = ?').run(id);
      assert.throws(() => db.prepare("UPDATE memories SET share_state = 'shared' WHERE id = ?").run(id), /CHECK/);
    } finally {
      db.close();
    }
  });

  it('new rows initialize updated_at to created_at; share_state and author stay NULL', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    try {
      const repo = new MemoryRepository(db);
      const { id } = repo.create({ content: 'fresh row', kind: 'fact', project: 'p', skipDedup: true });
      const row = db.prepare('SELECT created_at, updated_at, share_state, author FROM memories WHERE id = ?').get(id) as
        { created_at: string; updated_at: string; share_state: string | null; author: string | null };
      assert.equal(row.updated_at, row.created_at);
      assert.equal(row.share_state, null);
      assert.equal(row.author, null);
    } finally {
      db.close();
    }
  });

  it('the revision trigger maintains updated_at on semantic changes but not telemetry', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    try {
      const repo = new MemoryRepository(db);
      const { id } = repo.create({ content: 'trigger row', kind: 'fact', project: 'p', skipDedup: true });
      db.prepare('UPDATE memories SET updated_at = ? WHERE id = ?').run('2000-01-01 00:00:00', id);
      // Telemetry-only update: updated_at must NOT move.
      db.prepare('UPDATE memories SET recall_count = recall_count + 1 WHERE id = ?').run(id);
      let row = db.prepare('SELECT updated_at, revision FROM memories WHERE id = ?').get(id) as { updated_at: string; revision: number };
      assert.equal(row.updated_at, '2000-01-01 00:00:00');
      // Semantic update: trigger bumps revision AND refreshes updated_at.
      const before = row.revision;
      db.prepare("UPDATE memories SET content = 'trigger row edited' WHERE id = ?").run(id);
      row = db.prepare('SELECT updated_at, revision FROM memories WHERE id = ?').get(id) as { updated_at: string; revision: number };
      assert.equal(row.revision, before + 1);
      assert.notEqual(row.updated_at, '2000-01-01 00:00:00');
    } finally {
      db.close();
    }
  });

  it('deleteById and invalidate write tombstone log entries; rule rows and missing ids write none', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    try {
      const repo = new MemoryRepository(db);
      const a = repo.create({ content: 'to be deleted', kind: 'fact', project: 'p', skipDedup: true }).id;
      const b = repo.create({ content: 'to be invalidated', kind: 'pitfall', project: 'p', skipDedup: true }).id;

      assert.equal(repo.delete(a), true);
      assert.equal(repo.invalidate(b), true);
      assert.equal(repo.delete('no-such-id'), false);

      const logs = db.prepare('SELECT memory_id, action, content FROM memory_tombstones ORDER BY memory_id').all() as
        Array<{ memory_id: string; action: string; content: string }>;
      assert.equal(logs.length, 2);
      assert.deepEqual(new Set(logs.map((l) => `${l.action}`)), new Set(['delete', 'invalidate']));
      assert.ok(logs.find((l) => l.memory_id === a)?.content.includes('to be deleted'));
    } finally {
      db.close();
    }
  });

  it('every insert path initializes updated_at — gateway store and raw SQL, not just create()', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    try {
      const repo = new MemoryRepository(db);
      const viaGateway = repo.storeDecision({ content: 'gateway-path decision content', project: 'p' });
      const g = db.prepare('SELECT created_at, updated_at FROM memories WHERE id = ?').get(viaGateway.id) as
        { created_at: string; updated_at: string | null };
      assert.equal(g.updated_at, g.created_at);

      // Initialization is an explicit repository-site convention (an
      // insert trigger corrupted FTS under broad update triggers and was
      // reverted): raw SQL outside the repository legitimately leaves
      // NULL, which the v32 backfill and recency readers treat as
      // created_at.
      db.prepare("INSERT INTO memories (id, content, kind, project, created_at) VALUES ('raw1', 'raw path', 'fact', 'p', '2026-01-01 00:00:00')").run();
      const r = db.prepare("SELECT updated_at FROM memories WHERE id = 'raw1'").get() as { updated_at: string | null };
      assert.equal(r.updated_at, null);
    } finally {
      db.close();
    }
  });

  it('a delete/restore/delete cycle inside one second logs both deletes', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    try {
      const repo = new MemoryRepository(db);
      const { id } = repo.create({ content: 'restored then re-deleted', kind: 'fact', project: 'p', skipDedup: true });
      assert.equal(repo.delete(id), true);
      db.prepare("INSERT INTO memories (id, content, kind, project, created_at) VALUES (?, 'restored then re-deleted', 'fact', 'p', datetime('now'))").run(id);
      assert.equal(repo.delete(id), true);
      const n = (db.prepare("SELECT COUNT(*) n FROM memory_tombstones WHERE memory_id = ? AND action = 'delete'").get(id) as { n: number }).n;
      assert.equal(n, 2);
    } finally {
      db.close();
    }
  });

  it('rule rows refuse retraction and write no tombstone', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    try {
      const repo = new MemoryRepository(db);
      db.prepare("INSERT INTO memories (id, content, kind, project, created_at, source) VALUES ('rule1', 'a rule', 'rule', 'p', datetime('now'), 'user')").run();
      assert.equal(repo.delete('rule1'), false);
      assert.equal(repo.invalidate('rule1'), false);
      assert.equal((db.prepare('SELECT COUNT(*) n FROM memory_tombstones').get() as { n: number }).n, 0);
    } finally {
      db.close();
    }
  });

  it('a failed mutation rolls back its tombstone log entry', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    try {
      const repo = new MemoryRepository(db);
      const { id } = repo.create({ content: 'delete will be aborted', kind: 'fact', project: 'p', skipDedup: true });
      db.exec("CREATE TRIGGER abort_delete BEFORE DELETE ON memories BEGIN SELECT RAISE(ABORT, 'injected'); END");
      assert.throws(() => repo.delete(id), /injected/);
      db.exec('DROP TRIGGER abort_delete');
      assert.equal((db.prepare('SELECT COUNT(*) n FROM memory_tombstones').get() as { n: number }).n, 0);
      assert.equal(
        (db.prepare("SELECT COUNT(*) n FROM sync_journal WHERE op = 'tombstone'").get() as { n: number }).n, 0,
        'the late DELETE failure rolls the journal entry back with the tombstone log',
      );
      assert.equal(repo.delete(id), true);
    } finally {
      db.close();
    }
  });

  it('lazy identity migration moves a project whose only remaining rows are v32 sync state', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    const dir = mkdtempSync(join(tmpdir(), 'waykeep-v32lazy-'));
    cleanupDirs.push(dir);
    mkdirSync(join(dir, '.git'));
    writeFileSync(join(dir, '.git', 'config'),
      '[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = git@github.com:acme/v32lazy.git\n');
    try {
      __resetProjectMigrationForTests();
      __resetProjectIdCacheForTests();
      const oldId = legacyProjectId(dir);
      db.prepare("INSERT INTO memory_tombstones (memory_id, action, project, kind, content, deleted_at) VALUES ('m1', 'delete', ?, 'fact', 'last trace', datetime('now'))").run(oldId);

      migrateProjectIdentity(db, dir);

      const newId = projectId(dir);
      assert.notEqual(newId, oldId);
      assert.equal((db.prepare('SELECT COUNT(*) n FROM memory_tombstones WHERE project = ?').get(oldId) as { n: number }).n, 0);
      assert.equal((db.prepare('SELECT COUNT(*) n FROM memory_tombstones WHERE project = ?').get(newId) as { n: number }).n, 1);
    } finally {
      db.close();
    }
  });

  it('migrateToV32 is idempotent and backfills updated_at from created_at', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    try {
      const repo = new MemoryRepository(db);
      const { id } = repo.create({ content: 'backfill row', kind: 'fact', project: 'p', skipDedup: true });
      db.prepare('UPDATE memories SET updated_at = NULL WHERE id = ?').run(id);

      migrateToV32(db);
      migrateToV32(db); // second run must be a no-op, never a throw

      const row = db.prepare('SELECT created_at, updated_at FROM memories WHERE id = ?').get(id) as
        { created_at: string; updated_at: string };
      assert.equal(row.updated_at, row.created_at);
      assert.equal((db.prepare('SELECT version FROM schema_version').get() as { version: number }).version, 32);
    } finally {
      db.close();
    }
  });

  it('moveProjectRows carries the v32 project-keyed sync tables through a rename', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    try {
      const now = new Date().toISOString();
      db.prepare("INSERT INTO sync_journal (project, memory_id, op, row_revision, created_at) VALUES ('old-id', 'm1', 'upsert', 1, ?)").run(now);
      db.prepare("INSERT INTO sync_entity_map (entity_id, local_memory_id, project, state, canonical_version, canonical_hash, projection_hash, updated_at) VALUES ('e1', 'm1', 'old-id', 'bound', 1, 'ch', 'ph', ?)").run(now);
      db.prepare("INSERT INTO sync_conflict_sets (conflict_set_id, project, member_entity_ids, reason, opened_by, opened_seq) VALUES ('c1', 'old-id', '[\"e1\"]', 'divergence', 'acct', 1)").run();
      db.prepare("INSERT INTO memory_tombstones (memory_id, action, project, kind, content, deleted_at) VALUES ('m0', 'delete', 'old-id', 'fact', 'gone', ?)").run(now);

      const moved = moveProjectRows(db, 'old-id', 'new-id');
      for (const t of ['sync_journal', 'sync_entity_map', 'sync_conflict_sets', 'memory_tombstones']) {
        assert.equal(moved[t], 1, `${t} moved`);
        assert.equal((db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE project = 'old-id'`).get() as { n: number }).n, 0);
        assert.equal((db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE project = 'new-id'`).get() as { n: number }).n, 1);
      }
    } finally {
      db.close();
    }
  });
});
