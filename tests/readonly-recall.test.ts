/**
 * Read-only retrieval option (roadmap W1 slice 1) — benchmark harnesses must
 * be able to query without perturbing recall stats, or evaluation results
 * become order-dependent. Default behavior (mutating) must be unchanged.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type Database from 'better-sqlite3';
import { openDatabase } from '../src/db/connection.js';
import { MemoryRepository } from '../src/db/memory-repository.js';

let db: Database.Database;
let repo: MemoryRepository;

function statsOf(id: string): { last_recalled: string | null; recall_count: number } {
  return db.prepare('SELECT last_recalled, recall_count FROM memories WHERE id = ?')
    .get(id) as { last_recalled: string | null; recall_count: number };
}

beforeEach(() => {
  db = openDatabase({ dbPath: ':memory:' });
  repo = new MemoryRepository(db);
});

afterEach(() => { db.close(); });

describe('readOnly recall option', () => {
  it('recall(readOnly) returns results without touching last_recalled or recall_count', () => {
    const created = repo.create({
      content: 'authentication tokens refresh through the oauth handler',
      kind: 'fact', project: 'proj',
    });

    const results = repo.recall('oauth authentication tokens', { project: 'proj', readOnly: true });
    assert.equal(results.length, 1, 'read-only recall must still return the match');

    const stats = statsOf(created.id);
    assert.equal(stats.last_recalled, null, 'last_recalled must remain unset');
    assert.equal(stats.recall_count, 0, 'recall_count must remain zero');
  });

  it('recall without the flag mutates stats (default behavior unchanged)', () => {
    const created = repo.create({
      content: 'authentication tokens refresh through the oauth handler',
      kind: 'fact', project: 'proj',
    });

    repo.recall('oauth authentication tokens', { project: 'proj' });

    const stats = statsOf(created.id);
    assert.ok(stats.last_recalled, 'default recall must set last_recalled');
    assert.equal(stats.recall_count, 1, 'default recall must increment recall_count');
  });

  it('recallHybrid(readOnly) leaves stats untouched; default mutates', () => {
    const created = repo.create({
      content: 'database migrations run through the schema version table',
      kind: 'fact', project: 'proj',
    });

    // No embedding — hybrid degrades to FTS-backed RRF, same stat-update path
    const ro = repo.recallHybrid('database schema migrations', null, { project: 'proj', readOnly: true });
    assert.equal(ro.length, 1);
    let stats = statsOf(created.id);
    assert.equal(stats.last_recalled, null);
    assert.equal(stats.recall_count, 0);

    repo.recallHybrid('database schema migrations', null, { project: 'proj' });
    stats = statsOf(created.id);
    assert.ok(stats.last_recalled);
    assert.equal(stats.recall_count, 1);
  });

  it('repeated read-only queries are order-independent (identical results)', () => {
    repo.create({ content: 'first fact about widget rendering pipeline', kind: 'fact', project: 'proj' });
    repo.create({ content: 'second fact about widget event handling', kind: 'fact', project: 'proj' });
    repo.create({ content: 'third fact about widget state updates', kind: 'fact', project: 'proj' });

    const q = 'widget rendering events';
    const first = repo.recall(q, { project: 'proj', readOnly: true }).map(r => r.memory.id);
    for (let i = 0; i < 5; i++) {
      const again = repo.recall(q, { project: 'proj', readOnly: true }).map(r => r.memory.id);
      assert.deepEqual(again, first, 'read-only recall must not drift across repetitions');
    }
  });
});
