import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db/connection.js';
import { MemoryRepository } from '../src/db/memory-repository.js';
import { moveProjectRows } from '../src/db/project-identity-migration.js';
import { forgetProject, runConsolidation, runAutoPromotion, updateAnchorsForRenames } from '../src/db/maintenance.js';
import { deleteByIds, deleteByFilter } from '../src/db/memory-repository/stats.js';
import { expireTtlMemories, applyConfidenceDecay } from '../src/db/decay.js';
import { restoreRecord } from '../src/db/memory-repository/portability.js';
import { MemoryCommandHandlers } from '../src/memory-tool/command-handlers.js';
import { PlanRepository } from '../src/db/plan-repository.js';
import { encodeProjectSegment } from '../src/memory-tool/path-router.js';
import { applyRecordUpdate } from '../src/memory-tool/record-updater.js';
import { restoreDocument } from '../src/db/memory-repository/portability.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface JournalRow { project: string; memory_id: string; op: string; row_revision: number; cause: string | null }

function journalRows(db: ReturnType<typeof openDatabase>, memoryId?: string): JournalRow[] {
  const sql = memoryId
    ? 'SELECT project, memory_id, op, row_revision, cause FROM sync_journal WHERE memory_id = ? ORDER BY entry_id'
    : 'SELECT project, memory_id, op, row_revision, cause FROM sync_journal ORDER BY entry_id';
  return (memoryId ? db.prepare(sql).all(memoryId) : db.prepare(sql).all()) as JournalRow[];
}

function bindRow(db: ReturnType<typeof openDatabase>, id: string, state: 'bound' | 'shadow-assoc' = 'bound'): void {
  db.prepare(`
    INSERT INTO sync_entity_map (entity_id, local_memory_id, project, state, canonical_version, canonical_hash, projection_hash, updated_at)
    VALUES (?, ?, 'p', ?, 1, 'ch', 'ph', datetime('now'))
  `).run(`e-${id}`, id, state);
}

describe('semantic-change journal', () => {
  it('admission is row-local: shareable kind + non-null project journals; corrections and globals never do', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    try {
      const repo = new MemoryRepository(db);
      const a = repo.create({ content: 'shareable pitfall in a project', kind: 'pitfall', project: 'p', skipDedup: true }).id;
      const b = repo.create({ content: 'a correction never journals', kind: 'correction', project: 'p', skipDedup: true }).id;
      const c = repo.create({ content: 'a global fact never journals', kind: 'fact', project: null, skipDedup: true }).id;

      assert.deepEqual(journalRows(db, a), [{ project: 'p', memory_id: a, op: 'upsert', row_revision: 1, cause: null }]);
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

  it('supersession journals a caused tombstone at the pre-update revision — distinct from an ordinary deletion', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    try {
      const repo = new MemoryRepository(db);
      const oldRes = repo.create({ content: 'the app runtime is node 18.1', kind: 'fact', project: 'p' });
      const newRes = repo.create({ content: 'the app runtime is node 20.3', kind: 'fact', project: 'p' });
      assert.equal(newRes.supersededId, oldRes.id, 'fixture: supersession occurred');
      const loserRows = journalRows(db, oldRes.id);
      assert.equal(loserRows.length, 2, 'create + retirement');
      assert.equal(loserRows[1].op, 'tombstone');
      assert.equal(loserRows[1].cause, `superseded-by:${newRes.id}`, 'successor identity travels in cause');
      assert.equal(loserRows[1].row_revision, 1, 'last shareable revision — read before the trigger bump');
      const live = db.prepare('SELECT revision FROM memories WHERE id = ?').get(oldRes.id) as { revision: number };
      assert.ok(live.revision > 1, 'the surviving row was bumped after the journal read');
    } finally {
      db.close();
    }
  });

  it('a suppressed create that triggers supersession journals nothing (D13 through conflict detection)', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    try {
      const repo = new MemoryRepository(db);
      const oldRes = repo.create({ content: 'the api gateway runs terraform 1.5.1', kind: 'fact', project: 'p', journal: { suppressed: true } });
      const newRes = repo.create({ content: 'the api gateway runs terraform 1.7.2', kind: 'fact', project: 'p', journal: { suppressed: true } });
      assert.equal(newRes.supersededId, oldRes.id, 'fixture: supersession occurred');
      assert.equal(journalRows(db).length, 0, 'no path of a replicated apply may echo');
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
      assert.deepEqual(j[0], { project: 'p', memory_id: a, op: 'tombstone', row_revision: 1, cause: null });
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

  it('a journal write failure rolls back the memory mutation with it', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    try {
      const repo = new MemoryRepository(db);
      db.exec('ALTER TABLE sync_journal RENAME TO sync_journal_broken');
      assert.throws(() => repo.create({ content: 'row whose journal write fails', kind: 'fact', project: 'p', skipDedup: true }));
      assert.equal((db.prepare('SELECT COUNT(*) n FROM memories').get() as { n: number }).n, 0, 'no memory row without its journal entry');
      db.exec('ALTER TABLE sync_journal_broken RENAME TO sync_journal');
    } finally {
      db.close();
    }
  });

  it("an outer caller's rollback swallows the nested create AND its journal entry (savepoint case)", () => {
    const db = openDatabase({ dbPath: ':memory:' });
    try {
      const repo = new MemoryRepository(db);
      assert.throws(() => db.transaction(() => {
        repo.create({ content: 'importer row that must vanish on abort', kind: 'pitfall', project: 'p', skipDedup: true });
        throw new Error('importer aborts after the nested write');
      })());
      assert.equal((db.prepare('SELECT COUNT(*) n FROM memories').get() as { n: number }).n, 0);
      assert.equal(journalRows(db).length, 0, 'the savepoint took the journal entry with it');
    } finally {
      db.close();
    }
  });

  it('explicit trust changes journal upserts; a terminal weaken retracts with tombstone log + journal tombstone', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    try {
      const repo = new MemoryRepository(db);
      const id = repo.create({ content: 'row receiving explicit trust feedback', kind: 'fact', project: 'p', skipDedup: true }).id;
      db.prepare('DELETE FROM sync_journal').run();

      repo.strengthenConfidence(id);
      repo.weakenConfidence(id);
      assert.deepEqual(journalRows(db, id).map((r) => r.op), ['upsert', 'upsert'], 'confidence is a portable field');

      db.prepare('UPDATE memories SET confidence = 0.05 WHERE id = ?').run(id);
      db.prepare('DELETE FROM sync_journal').run();
      const result = repo.weakenConfidence(id);
      assert.equal(result.invalidated, true);
      assert.deepEqual(journalRows(db, id).map((r) => r.op), ['tombstone']);
      assert.ok(db.prepare('SELECT 1 FROM memory_tombstones WHERE memory_id = ?').get(id), 'audit log covers the retraction');
    } finally {
      db.close();
    }
  });

  it('autonomous terminal weaken clamps a sync-bound row instead of invalidating, and journals nothing', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    try {
      const repo = new MemoryRepository(db);
      const id = repo.create({ content: 'bound row under autonomous negative feedback', kind: 'fact', project: 'p', skipDedup: true }).id;
      bindRow(db, id);
      db.prepare('UPDATE memories SET confidence = 0.05 WHERE id = ?').run(id);
      db.prepare('DELETE FROM sync_journal').run();

      const result = repo.weakenConfidence(id, { autonomous: true });
      assert.equal(result.invalidated, false, 'autonomous code cannot retract team data');
      const row = db.prepare('SELECT invalidated FROM memories WHERE id = ?').get(id) as { invalidated: number };
      assert.equal(row.invalidated, 0);
      assert.equal(journalRows(db).length, 0);
    } finally {
      db.close();
    }
  });

  it('deleteByFilter (cairn_cleanup) retracts through the journaled bulk path', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    try {
      const repo = new MemoryRepository(db);
      const id = repo.create({ content: 'low-confidence row cleaned by filter', kind: 'fact', project: 'p', skipDedup: true }).id;
      db.prepare('UPDATE memories SET confidence = 0.1 WHERE id = ?').run(id);
      db.prepare('DELETE FROM sync_journal').run();

      assert.equal(deleteByFilter(db, { project: 'p', maxConfidence: 0.2 }), 1);
      assert.deepEqual(journalRows(db, id).map((r) => r.op), ['tombstone']);
    } finally {
      db.close();
    }
  });

  it('a shadow-assoc row is NOT protected from hygiene — only bound rows are', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    try {
      const repo = new MemoryRepository(db);
      const id = repo.create({ content: 'opted-out row with a shadow assoc', kind: 'fact', project: 'p', skipDedup: true }).id;
      bindRow(db, id, 'shadow-assoc');
      db.prepare('UPDATE memories SET expires_at = ? WHERE id = ?').run(new Date(Date.now() - 60_000).toISOString(), id);

      assert.equal(expireTtlMemories(db), 1, 'a purely local row prunes normally');
      assert.equal(db.prepare('SELECT 1 FROM memories WHERE id = ?').get(id), undefined);
    } finally {
      db.close();
    }
  });

  it('every autonomous decay deletion path excludes bound rows (below-threshold, dead-tail, invalidated-30d)', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    try {
      const repo = new MemoryRepository(db);
      const old = new Date(Date.now() - 200 * 86_400_000).toISOString();
      // below-threshold delete candidate
      const a = repo.create({ content: 'bound floored row survives threshold delete', kind: 'fact', project: 'p', skipDedup: true, createdAt: old }).id;
      // dead-tail candidate (at the floor, never recalled, old)
      const b = repo.create({ content: 'bound dead-tail row survives pruning', kind: 'fact', project: 'p', skipDedup: true, createdAt: old }).id;
      // invalidated-30d candidate
      const c = repo.create({ content: 'bound invalidated row survives the 30d purge', kind: 'fact', project: 'p', skipDedup: true, createdAt: old }).id;
      // Unbound CONTROL twins prove each deletion path actually fires.
      const a2 = repo.create({ content: 'unbound floored row is deleted by threshold', kind: 'fact', project: 'p', skipDedup: true, skipConflictDetection: true, createdAt: old }).id;
      const b2 = repo.create({ content: 'unbound dead-tail row is pruned', kind: 'fact', project: 'p', skipDedup: true, skipConflictDetection: true, createdAt: old }).id;
      const c2 = repo.create({ content: 'unbound invalidated row is purged', kind: 'fact', project: 'p', skipDedup: true, skipConflictDetection: true, createdAt: old }).id;
      db.prepare('UPDATE memories SET confidence = 0.01, last_decayed_at = ? WHERE id IN (?, ?)').run(old, a, a2);
      db.prepare('UPDATE memories SET confidence = 0.15, recall_count = 0 WHERE id IN (?, ?)').run(b, b2);
      db.prepare("UPDATE memories SET invalidated = 1, updated_at = ? WHERE id IN (?, ?)").run(old, c, c2);
      for (const id of [a, b, c]) bindRow(db, id);
      db.prepare('DELETE FROM sync_journal').run();

      applyConfidenceDecay(db);
      for (const id of [a, b, c]) {
        assert.ok(db.prepare('SELECT 1 FROM memories WHERE id = ?').get(id), `bound row ${id} survives`);
      }
      for (const id of [a2, b2, c2]) {
        assert.equal(db.prepare('SELECT 1 FROM memories WHERE id = ?').get(id), undefined, `unbound control ${id} was actually deleted — the path fires`);
      }
      assert.equal(journalRows(db).length, 0, 'hygiene journals nothing');
    } finally {
      db.close();
    }
  });

  it('consolidation skips clusters containing bound rows; unbound members retire with tombstone + journal and the representative journals an upsert', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    try {
      const repo = new MemoryRepository(db);
      const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
      const mk = (content: string) =>
        repo.create({ content, kind: 'fact', project: 'p', skipDedup: true, skipConflictDetection: true, createdAt: old }).id;
      // Two near-identical unbound rows -> should consolidate
      const rep = mk('the build pipeline caches node modules between runs for speed');
      const member = mk('the build pipeline caches node modules between runs for speed always');
      // Near-identical pair where one is bound -> cluster must be skipped
      const boundRep = mk('the staging database resets every sunday night at midnight');
      const boundMember = mk('the staging database resets every sunday night at midnight exactly');
      bindRow(db, boundMember);
      db.prepare('DELETE FROM sync_journal').run();

      runConsolidation(db);

      const boundRow = db.prepare('SELECT invalidated FROM memories WHERE id = ?').get(boundMember) as { invalidated: number };
      assert.equal(boundRow.invalidated, 0, 'bound cluster untouched');
      assert.ok(db.prepare('SELECT 1 FROM memories WHERE id = ? AND invalidated = 0').get(boundRep), 'bound-cluster representative untouched');

      // Representative selection between an equal-confidence pair is not
      // deterministic — assert the CLUSTER consolidated, whichever side won.
      const states = [rep, member].map((id) =>
        (db.prepare('SELECT invalidated FROM memories WHERE id = ?').get(id) as { invalidated: number }).invalidated);
      assert.deepEqual([...states].sort(), [0, 1], 'fixture: exactly one of the unbound pair was retired');
      const loser = states[0] === 1 ? rep : member;
      const winner = loser === rep ? member : rep;
      assert.ok(db.prepare('SELECT 1 FROM memory_tombstones WHERE memory_id = ?').get(loser), 'member retirement is tombstone-logged');
      assert.deepEqual(journalRows(db, loser).map((r) => r.op), ['tombstone']);
      assert.deepEqual(journalRows(db, winner).map((r) => r.op), ['upsert'], 'representative rewrite journals');
    } finally {
      db.close();
    }
  });

  it('auto-promotion is barred for bound rows and journals through promote() for unbound ones', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    try {
      const repo = new MemoryRepository(db);
      const old = new Date(Date.now() - 90 * 86_400_000).toISOString();
      const content = 'always pin exact dependency versions in the lockfile';
      const a = repo.create({ content, kind: 'fact', project: 'p', skipDedup: true, skipConflictDetection: true, createdAt: old }).id;
      repo.create({ content, kind: 'fact', project: 'q', skipDedup: true, skipConflictDetection: true, createdAt: old });
      db.prepare('UPDATE memories SET confidence = 0.9, impact_count = 3 WHERE id = ?').run(a);
      bindRow(db, a);
      db.prepare('DELETE FROM sync_journal').run();

      runAutoPromotion(db);
      const boundRow = db.prepare('SELECT project FROM memories WHERE id = ?').get(a) as { project: string | null };
      assert.equal(boundRow.project, 'p', 'bound row keeps its scope');

      db.prepare('DELETE FROM sync_entity_map').run();
      runAutoPromotion(db);
      const freed = db.prepare('SELECT project FROM memories WHERE id = ?').get(a) as { project: string | null };
      assert.equal(freed.project, null, 'fixture: the unbound candidate promoted');
      assert.deepEqual(journalRows(db, a).map((r) => r.op), ['tombstone'], 'scope departure journals under the old project');
      assert.equal(journalRows(db, a)[0].project, 'p');
    } finally {
      db.close();
    }
  });

  it('a portable restore journals an upsert — including the deliberate resurrection of a retracted row', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    try {
      const repo = new MemoryRepository(db);
      const id = repo.create({ content: 'row that is deleted then restored from backup', kind: 'decision', project: 'p', skipDedup: true }).id;
      const record = db.prepare('SELECT content, kind, project, tags, confidence, source, created_at FROM memories WHERE id = ?').get(id) as {
        content: string; kind: 'decision'; project: string; tags: string; confidence: number; source: 'learned'; created_at: string;
      };
      repo.invalidate(id);
      db.prepare('DELETE FROM sync_journal').run();

      restoreRecord(db, {
        id, content: record.content, kind: record.kind, project: record.project,
        tags: JSON.parse(record.tags), confidence: record.confidence, source: record.source,
        created_at: record.created_at, expires_at: null, fingerprint: null, context: null, anchor: null,
      });
      const row = db.prepare('SELECT invalidated FROM memories WHERE id = ?').get(id) as { invalidated: number };
      assert.equal(row.invalidated, 0, 'restore resurrects');
      assert.deepEqual(journalRows(db, id).map((r) => r.op), ['upsert'], 'the resurrection travels');
    } finally {
      db.close();
    }
  });

  it('Memory Tool deletion retires with tombstone log + journal; rename journals the scope move', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    try {
      const repo = new MemoryRepository(db);
      const planRepo = new PlanRepository(db);
      const h = new MemoryCommandHandlers({ db, planRepo, log: () => {} });
      const proj = 'vfs-proj';
      const dir = `/memories/${encodeProjectSegment(proj)}`;

      const id = repo.create({ content: 'vfs-owned fact row for deletion', kind: 'fact', project: proj, skipDedup: true }).id;
      db.prepare('DELETE FROM sync_journal').run();
      h.delete(`${dir}/facts.md`);
      assert.deepEqual(journalRows(db, id).map((r) => r.op), ['tombstone']);
      assert.ok(db.prepare('SELECT 1 FROM memory_tombstones WHERE memory_id = ?').get(id), 'VFS deletion is tombstone-logged');

      // Rename: project -> project scope move journals tombstone(old) + upsert(new)
      const proj2 = 'vfs-proj-two';
      const moved = repo.create({ content: 'vfs-owned decision row for renaming', kind: 'decision', project: proj, skipDedup: true }).id;
      db.prepare('DELETE FROM sync_journal').run();
      h.rename(`${dir}/decisions.md`, `/memories/${encodeProjectSegment(proj2)}/decisions.md`);
      const moveOps = journalRows(db, moved);
      assert.deepEqual(moveOps.map((r) => r.op), ['tombstone', 'upsert']);
      assert.equal(moveOps[0].project, proj, 'tombstone under the departing scope');
      assert.equal(moveOps[1].project, proj2, 'upsert under the arriving scope');
      assert.ok(moveOps[1].row_revision > moveOps[0].row_revision, 'upsert carries the post-move revision');
    } finally {
      db.close();
    }
  });

  it('anchor repair mutates locally and journals nothing — the fix rides the next semantic upsert', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    try {
      const repo = new MemoryRepository(db);
      const id = repo.create({ content: 'pitfall anchored to a renamed file', kind: 'pitfall', project: 'p', skipDedup: true }).id;
      db.prepare('UPDATE memories SET anchor = ? WHERE id = ?').run(JSON.stringify({ files: ['src/old-name.ts'] }), id);
      db.prepare('DELETE FROM sync_journal').run();

      const updated = updateAnchorsForRenames(db, 'p', [{ oldPath: 'src/old-name.ts', newPath: 'src/new-name.ts' }]);
      assert.equal(updated, 1, 'fixture: the anchor was repaired');
      assert.equal(journalRows(db).length, 0, 'local-git-driven repair never journals');
    } finally {
      db.close();
    }
  });

  it('a Memory Tool record edit journals ONE entry at the transaction-final revision — both halves landed', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    try {
      const repo = new MemoryRepository(db);
      const id = repo.create({ content: 'original content for a mixed edit', kind: 'fact', project: 'p', skipDedup: true }).id;
      db.prepare('DELETE FROM sync_journal').run();

      db.transaction(() => {
        applyRecordUpdate(db, id, 'original content for a mixed edit', {
          content: 'corrected content for a mixed edit', tags: ['edited'], raw: [],
        });
      })();

      const live = db.prepare('SELECT revision, content, tags FROM memories WHERE id = ?').get(id) as { revision: number; content: string; tags: string };
      assert.equal(live.content, 'corrected content for a mixed edit');
      assert.deepEqual(JSON.parse(live.tags), ['edited'], 'the metadata half landed too');
      const rows = journalRows(db, id);
      assert.equal(rows.length, 1, 'ONE entry for a mixed content+metadata edit');
      assert.equal(rows[0].op, 'upsert');
      assert.equal(rows[0].row_revision, live.revision, 'journaled at the FINAL revision, not the intermediate one');
    } finally {
      db.close();
    }
  });

  it('a journal write failure rolls back update() and restoreRecord() with their mutations', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    try {
      const repo = new MemoryRepository(db);
      const id = repo.create({ content: 'row whose correction must roll back', kind: 'fact', project: 'p', skipDedup: true }).id;
      db.exec('ALTER TABLE sync_journal RENAME TO sync_journal_broken');

      assert.throws(() => repo.update(id, 'corrected content that must vanish'));
      const after = db.prepare('SELECT content FROM memories WHERE id = ?').get(id) as { content: string };
      assert.equal(after.content, 'row whose correction must roll back');

      assert.throws(() => restoreRecord(db, {
        id: '11111111-2222-4333-8444-555555555555', content: 'restored row that must vanish', kind: 'fact', project: 'p',
        tags: [], confidence: 0.5, source: 'learned', created_at: new Date().toISOString(),
        expires_at: null, fingerprint: null, context: null, anchor: null,
      }));
      assert.equal(db.prepare("SELECT 1 FROM memories WHERE id = '11111111-2222-4333-8444-555555555555'").get(), undefined,
        'the single-record restore path owns a transaction');
      db.exec('ALTER TABLE sync_journal_broken RENAME TO sync_journal');
    } finally {
      db.close();
    }
  });

  it('a mid-document restore abort rolls back already-applied records AND their journal entries (savepoint path)', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    try {
      const good = {
        id: '21111111-2222-4333-8444-555555555555', content: 'first record applies fine', kind: 'fact' as const, project: 'p',
        tags: [], confidence: 0.5, source: 'learned' as const, created_at: new Date().toISOString(),
        expires_at: null, fingerprint: null, context: null, anchor: null,
      };
      const bad = { ...good, id: '31111111-2222-4333-8444-555555555555', kind: 'rule' as const };
      assert.throws(() => restoreDocument(db, [good, bad as never], []), /not portable/);
      assert.equal((db.prepare('SELECT COUNT(*) n FROM memories').get() as { n: number }).n, 0, 'all-or-nothing held');
      assert.equal(journalRows(db).length, 0, 'the aborted document left no journal entries');
    } finally {
      db.close();
    }
  });

  it('D13 suppression is honored at every public facade route', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    try {
      const repo = new MemoryRepository(db);
      const sup = { suppressed: true } as const;
      const a = repo.create({ content: 'facade row a for suppression', kind: 'fact', project: 'p', skipDedup: true, journal: sup }).id;
      const b = repo.create({ content: 'facade row b for suppression', kind: 'fact', project: 'p', skipDedup: true, journal: sup }).id;
      const c = repo.create({ content: 'facade row c for suppression', kind: 'fact', project: 'p', skipDedup: true, journal: sup }).id;
      const d = repo.create({ content: 'facade row d for suppression', kind: 'fact', project: 'p', skipDedup: true, journal: sup }).id;

      repo.update(a, 'facade row a corrected silently', sup);
      repo.invalidate(a, sup);
      repo.delete(b, sup);
      repo.promote(c, sup);
      repo.deleteByIds([d], sup);
      repo.restore({
        id: '41111111-2222-4333-8444-555555555555', content: 'replicated restore must not echo', kind: 'fact', project: 'p',
        tags: [], confidence: 0.5, source: 'learned', created_at: new Date().toISOString(),
        expires_at: null, fingerprint: null, context: null, anchor: null,
      }, { journal: sup });

      assert.equal(journalRows(db).length, 0, 'no facade route may echo a replicated apply');
    } finally {
      db.close();
    }
  });

  it('concurrent opens of a pre-cause v32 database all heal without SQLITE_BUSY failures', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'waykeep-heal-race-'));
    const dbPath = join(dir, 'aged.db');
    try {
      const db = openDatabase({ dbPath });
      db.exec('ALTER TABLE sync_journal DROP COLUMN cause');
      db.close();

      const run = promisify(execFile);
      const script = `import { openDatabase } from '${new URL('../src/db/connection.js', import.meta.url).href}'; const db = openDatabase({ dbPath: process.argv[1] }); db.prepare('SELECT 1').get(); db.close();`;
      await Promise.all(Array.from({ length: 6 }, () =>
        run(process.execPath, ['--input-type=module', '-e', script, dbPath], { timeout: 30_000 })));

      const check = openDatabase({ dbPath });
      const cols = check.prepare('PRAGMA table_info(sync_journal)').all() as Array<{ name: string }>;
      assert.ok(cols.some((c) => c.name === 'cause'), 'the heal landed');
      check.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
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
