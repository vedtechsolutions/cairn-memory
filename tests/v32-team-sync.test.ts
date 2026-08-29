import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db/connection.js';
import { MemoryRepository } from '../src/db/memory-repository.js';
import { migrateToV32 } from '../src/db/migrations/v32-team-sync.js';
import { moveProjectRows } from '../src/db/project-identity-migration.js';

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
