import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { openDatabase } from '../src/db/connection.js';
import { MemoryRepository } from '../src/db/memory-repository.js';
import { classifyAndAdvance, reclassifyDeferred, journalConsumptionCursor } from '../src/db/sync-apply/journal-consumer.js';

/**
 * The core-owned §7 consumption handshake (M1-exit C2: the checklist
 * previously cited column READS as evidence for a write path that did
 * not exist — this is the path, with its kill tests).
 */

const PROJECT = 'jc-proj';

let db: ReturnType<typeof openDatabase>;
let repo: MemoryRepository;

beforeEach(() => {
  db = openDatabase({ dbPath: ':memory:' });
  repo = new MemoryRepository(db);
});
afterEach(() => db.close());

function seedEntries(n: number): number[] {
  for (let i = 0; i < n; i++) {
    repo.create({ content: `journal consumer row ${i}`, kind: 'fact', project: PROJECT, skipDedup: true, skipConflictDetection: true });
  }
  return (db.prepare('SELECT entry_id FROM sync_journal WHERE project = ? ORDER BY entry_id').all(PROJECT) as Array<{ entry_id: number }>).map((r) => r.entry_id);
}

describe('journal consumption handshake (§7, core-owned)', () => {
  it('classifications and the cursor advance ATOMICALLY — J1: the cursor moves only on durable classification', () => {
    const ids = seedEntries(3);
    classifyAndAdvance(db, PROJECT, ids.map((entryId) => ({ entryId, classification: 'enqueued' as const })), ids[2]);
    assert.equal(journalConsumptionCursor(db, PROJECT), ids[2]);
    const rows = db.prepare('SELECT classification FROM sync_journal WHERE project = ?').all(PROJECT) as Array<{ classification: string }>;
    assert.ok(rows.every((r) => r.classification === 'enqueued'));
  });

  it('KILL: a failure mid-batch rolls back every classification AND the cursor — no intermediate state', () => {
    const ids = seedEntries(3);
    assert.throws(() => classifyAndAdvance(db, PROJECT, [
      { entryId: ids[0], classification: 'enqueued' },
      { entryId: ids[1], classification: 'bogus' as never },
    ], ids[2]), /unknown classification/);
    assert.equal(journalConsumptionCursor(db, PROJECT), 0, 'the cursor never moved');
    const classified = (db.prepare('SELECT COUNT(*) n FROM sync_journal WHERE project = ? AND classification IS NOT NULL').get(PROJECT) as { n: number }).n;
    assert.equal(classified, 0, 'the good half rolled back with the bad');
  });

  it('a GAP in the consumed range refuses the advance — unclassified work is never skipped past', () => {
    const ids = seedEntries(3);
    assert.throws(() => classifyAndAdvance(db, PROJECT, [
      { entryId: ids[0], classification: 'enqueued' },
      { entryId: ids[2], classification: 'deferred-pending-eligibility' },
    ], ids[2]), /no classification — refusing/);
    assert.equal(journalConsumptionCursor(db, PROJECT), 0);
  });

  it('the cursor is monotonic and range-bound: regressions, out-of-range entries, and cross-project ids are refused', () => {
    const ids = seedEntries(2);
    classifyAndAdvance(db, PROJECT, ids.map((entryId) => ({ entryId, classification: 'enqueued' as const })), ids[1]);
    assert.throws(() => classifyAndAdvance(db, PROJECT, [], ids[0]), /regression refused/);
    assert.throws(() => classifyAndAdvance(db, PROJECT, [{ entryId: ids[0], classification: 'enqueued' }], ids[1] + 5), /outside the consumed range/);
    // Cross-project: an entry in another project cannot be classified here.
    repo.create({ content: 'other project row', kind: 'fact', project: 'other-proj', skipDedup: true, skipConflictDetection: true });
    const otherId = (db.prepare("SELECT entry_id FROM sync_journal WHERE project = 'other-proj'").get() as { entry_id: number }).entry_id;
    assert.throws(() => classifyAndAdvance(db, PROJECT, [{ entryId: otherId, classification: 'enqueued' }], otherId), /does not exist in project/);
  });

  it('J5: an eligibility-restored DEFERRED row behind the cursor reclassifies atomically; non-deferred rows are refused', () => {
    const ids = seedEntries(3);
    classifyAndAdvance(db, PROJECT, [
      { entryId: ids[0], classification: 'deferred-pending-eligibility' },
      { entryId: ids[1], classification: 'enqueued' },
      { entryId: ids[2], classification: 'deferred-pending-eligibility' },
    ], ids[2]);

    reclassifyDeferred(db, PROJECT, [{ entryId: ids[0], classification: 'enqueued' }]);
    const row = db.prepare('SELECT classification, classified_at FROM sync_journal WHERE entry_id = ?').get(ids[0]) as { classification: string; classified_at: string | null };
    assert.equal(row.classification, 'enqueued', 'J4 → J2 on eligibility restoration');
    assert.ok(row.classified_at, 'classified_at is stamped');

    // Reconciliation never rewrites non-deferred states.
    assert.throws(() => reclassifyDeferred(db, PROJECT, [{ entryId: ids[1], classification: 'permanently-ineligible' }]), /touches only J4/);
    // Unconsumed rows are refused (that is classifyAndAdvance's domain).
    const more = seedEntries(1).pop()!;
    assert.throws(() => reclassifyDeferred(db, PROJECT, [{ entryId: more, classification: 'enqueued' }]), /not yet consumed/);
  });

  it('KILL after a REAL write: a trigger-injected failure on the second row rolls back the first row\'s committed-in-transaction write', () => {
    const ids = seedEntries(3);
    classifyAndAdvance(db, PROJECT, ids.map((entryId) => ({ entryId, classification: 'deferred-pending-eligibility' as const })), ids[2]);
    // The fault fires AFTER the first UPDATE genuinely executed — this
    // is a mid-transaction failure between real writes, not
    // pre-transaction validation (Codex exit final #1).
    db.exec(`CREATE TRIGGER jc_fault AFTER UPDATE ON sync_journal WHEN NEW.entry_id = ${ids[1]} BEGIN SELECT RAISE(ABORT, 'injected-after-write'); END`);
    try {
      assert.throws(() => reclassifyDeferred(db, PROJECT, [
        { entryId: ids[0], classification: 'enqueued' },
        { entryId: ids[1], classification: 'enqueued' },
      ]), /injected-after-write/);
    } finally {
      db.exec('DROP TRIGGER jc_fault');
    }
    const first = db.prepare('SELECT classification FROM sync_journal WHERE entry_id = ?').get(ids[0]) as { classification: string };
    assert.equal(first.classification, 'deferred-pending-eligibility', "the first row's REAL write rolled back with the injected failure");

    // Replay: the same reconciliation succeeds cleanly afterwards.
    reclassifyDeferred(db, PROJECT, [
      { entryId: ids[0], classification: 'enqueued' },
      { entryId: ids[1], classification: 'enqueued' },
    ]);
    assert.equal((db.prepare("SELECT COUNT(*) n FROM sync_journal WHERE classification = 'enqueued'").get() as { n: number }).n, 2);
  });

  it('replay from the cursor: a crash before the advance re-reads the same entries (J1 recovery shape)', () => {
    const ids = seedEntries(4);
    classifyAndAdvance(db, PROJECT, ids.slice(0, 2).map((entryId) => ({ entryId, classification: 'enqueued' as const })), ids[1]);
    const pending = db.prepare('SELECT entry_id FROM sync_journal WHERE project = ? AND entry_id > ? ORDER BY entry_id').all(PROJECT, journalConsumptionCursor(db, PROJECT)) as Array<{ entry_id: number }>;
    assert.deepEqual(pending.map((p) => p.entry_id), ids.slice(2), 'exactly the unconsumed tail is re-readable');
    classifyAndAdvance(db, PROJECT, ids.slice(2).map((entryId) => ({ entryId, classification: 'deferred-pending-eligibility' as const })), ids[3]);
    assert.equal(journalConsumptionCursor(db, PROJECT), ids[3]);
  });
});
