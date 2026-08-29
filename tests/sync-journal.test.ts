import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db/connection.js';
import { MemoryRepository } from '../src/db/memory-repository.js';
import { moveProjectRows } from '../src/db/project-identity-migration.js';
import { forgetProject } from '../src/db/maintenance.js';
import { deleteByIds } from '../src/db/memory-repository/stats.js';
import { expireTtlMemories } from '../src/db/decay.js';

interface JournalRow { project: string; memory_id: string; op: string; row_revision: number }

function journalRows(db: ReturnType<typeof openDatabase>, memoryId?: string): JournalRow[] {
  const sql = memoryId
    ? 'SELECT project, memory_id, op, row_revision FROM sync_journal WHERE memory_id = ? ORDER BY entry_id'
    : 'SELECT project, memory_id, op, row_revision FROM sync_journal ORDER BY entry_id';
  return (memoryId ? db.prepare(sql).all(memoryId) : db.prepare(sql).all()) as JournalRow[];
}

describe('semantic-change journal', () => {
  it('admission is row-local: shareable kind + non-null project journals; corrections and globals never do', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    try {
      const repo = new MemoryRepository(db);
      const a = repo.create({ content: 'shareable pitfall in a project', kind: 'pitfall', project: 'p', skipDedup: true }).id;
      const b = repo.create({ content: 'a correction never journals', kind: 'correction', project: 'p', skipDedup: true }).id;
      const c = repo.create({ content: 'a global fact never journals', kind: 'fact', project: null, skipDedup: true }).id;

      assert.deepEqual(journalRows(db, a), [{ project: 'p', memory_id: a, op: 'upsert', row_revision: 1 }]);
      assert.equal(journalRows(db, b).length, 0);
      assert.equal(journalRows(db, c).length, 0);
    } finally {
      db.close();
    }
  });

  it('a dedup merge journals an upsert at the bumped revision, in the same transaction', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    try {
      const repo = new MemoryRepository(db);
      const first = repo.create({ content: 'merge target lesson content', kind: 'fact', project: 'p' });
      const second = repo.create({ content: 'merge target lesson content', kind: 'fact', project: 'p' });
      assert.equal(second.id, first.id);
      const rows = journalRows(db, first.id);
      assert.equal(rows.length, 2);
      assert.ok(rows[1].row_revision > rows[0].row_revision, 'merge journals the post-trigger revision');
    } finally {
      db.close();
    }
  });

  it('the D13 suppression option journals nothing (replicated applications)', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    try {
      const repo = new MemoryRepository(db);
      const id = repo.create({ content: 'a replicated row must not echo', kind: 'fact', project: 'p', skipDedup: true, journal: { suppressed: true } }).id;
      assert.equal(journalRows(db, id).length, 0);
    } finally {
      db.close();
    }
  });

  it('corrections to a row, retractions, and promote journal their ops', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    try {
      const repo = new MemoryRepository(db);
      const id = repo.create({ content: 'row with a lifecycle', kind: 'decision', project: 'p', skipDedup: true }).id;
      repo.update(id, 'row with a corrected lifecycle');
      repo.invalidate(id);
      const ops = journalRows(db, id).map((r) => r.op);
      assert.deepEqual(ops, ['upsert', 'upsert', 'tombstone']);

      const promoted = repo.create({ content: 'promoted row departs the project scope', kind: 'fact', project: 'p', skipDedup: true }).id;
      repo.promote(promoted);
      const promoteOps = journalRows(db, promoted).map((r) => r.op);
      assert.deepEqual(promoteOps, ['upsert', 'tombstone']);
      // The tombstone was journaled under the OLD project.
      assert.ok(journalRows(db, promoted).every((r) => r.project === 'p'));
    } finally {
      db.close();
    }
  });

  it('supersession journals an upsert for the retired row — never a tombstone', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    try {
      const repo = new MemoryRepository(db);
      const oldRes = repo.create({ content: 'the app runtime is node 18.1', kind: 'fact', project: 'p' });
      const newRes = repo.create({ content: 'the app runtime is node 20.3', kind: 'fact', project: 'p' });
      assert.equal(newRes.supersededId, oldRes.id, 'fixture: supersession occurred');
      const loserRows = journalRows(db, oldRes.id);
      assert.equal(loserRows.length, 2, 'create + supersession state change');
      assert.deepEqual(loserRows.map((r) => r.op), ['upsert', 'upsert']);
    } finally {
      db.close();
    }
  });

  it('explicit bulk deletion tombstone-logs every row and journals only admissible ones', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    try {
      const repo = new MemoryRepository(db);
      const a = repo.create({ content: 'bulk delete shareable', kind: 'pattern', project: 'p', skipDedup: true }).id;
      const b = repo.create({ content: 'bulk delete correction', kind: 'correction', project: 'p', skipDedup: true }).id;
      db.prepare('DELETE FROM sync_journal').run();

      assert.equal(deleteByIds(db, [a, b]), 2);
      assert.equal((db.prepare('SELECT COUNT(*) n FROM memory_tombstones').get() as { n: number }).n, 2, 'audit log covers both');
      const j = journalRows(db);
      assert.equal(j.length, 1, 'only the shareable row journals');
      assert.deepEqual(j[0], { project: 'p', memory_id: a, op: 'tombstone', row_revision: 1 });
    } finally {
      db.close();
    }
  });

  it('forgetProject retracts with tombstone log + journal ops', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    try {
      const repo = new MemoryRepository(db);
      const a = repo.create({ content: 'project row one for forgetting', kind: 'fact', project: 'gone', skipDedup: true }).id;
      repo.create({ content: 'correction for forgetting', kind: 'correction', project: 'gone', skipDedup: true });
      db.prepare('DELETE FROM sync_journal').run();

      assert.equal(forgetProject(db, 'gone'), 2);
      assert.equal((db.prepare("SELECT COUNT(*) n FROM memory_tombstones WHERE project = 'gone'").get() as { n: number }).n, 2);
      const j = journalRows(db);
      assert.equal(j.length, 1);
      assert.equal(j[0].memory_id, a);
    } finally {
      db.close();
    }
  });

  it('administrative rescope (moveProjectRows) journals nothing', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    try {
      const repo = new MemoryRepository(db);
      repo.create({ content: 'rescoped row must not journal an edit', kind: 'fact', project: 'old-p', skipDedup: true });
      db.prepare('DELETE FROM sync_journal').run();

      moveProjectRows(db, 'old-p', 'new-p');
      assert.equal(journalRows(db).length, 0, 'a rescope is never a semantic edit');
    } finally {
      db.close();
    }
  });

  it('autonomous TTL expiry never deletes sync-bound rows and journals nothing', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    try {
      const repo = new MemoryRepository(db);
      const bound = repo.create({ content: 'bound row protected from hygiene', kind: 'fact', project: 'p', skipDedup: true }).id;
      const unbound = repo.create({ content: 'unbound row prunes normally', kind: 'fact', project: 'p', skipDedup: true }).id;
      const past = new Date(Date.now() - 60_000).toISOString();
      db.prepare('UPDATE memories SET expires_at = ? WHERE id IN (?, ?)').run(past, bound, unbound);
      db.prepare(`
        INSERT INTO sync_entity_map (entity_id, local_memory_id, project, state, canonical_version, canonical_hash, projection_hash, updated_at)
        VALUES ('e-bound', ?, 'p', 'bound', 1, 'ch', 'ph', datetime('now'))
      `).run(bound);
      db.prepare('DELETE FROM sync_journal').run();

      assert.equal(expireTtlMemories(db), 1, 'only the unbound row expires');
      assert.ok(db.prepare('SELECT 1 FROM memories WHERE id = ?').get(bound), 'bound row survives');
      assert.equal(db.prepare('SELECT 1 FROM memories WHERE id = ?').get(unbound), undefined);
      assert.equal(journalRows(db).length, 0, 'hygiene has no retraction authority');
    } finally {
      db.close();
    }
  });
});
