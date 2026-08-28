/**
 * Regression tests for the resilience batch:
 *  M5 — FTS drift is detected and rebuilt at startup (kill mid-migration
 *       previously left memories_fts empty forever, silently killing recall)
 *  M6 — findByIds batch lookup used by consolidation (one query, ordered)
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type Database from 'better-sqlite3';

import { openDatabase } from '../src/db/connection.js';
import { MemoryRepository } from '../src/db/memory-repository.js';

describe('M5 — FTS integrity check at startup', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cairn-fts-integrity-'));
    dbPath = join(dir, 'test.db');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('rebuilds an emptied FTS index on reopen', () => {
    let db = openDatabase({ dbPath });
    const repo = new MemoryRepository(db);
    repo.create({ content: 'webhook signatures must be validated before dispatch', kind: 'pitfall', project: 'proj-a' });
    repo.create({ content: 'connection pooling exhausts under concurrent migrations', kind: 'pitfall', project: 'proj-a' });

    // Simulate the mid-migration kill: index wiped, memories intact.
    // Indexed-row truth lives in the docsize shadow table — COUNT(*) on an
    // external-content FTS5 table reads through to memories and hides drift.
    db.exec("INSERT INTO memories_fts(memories_fts) VALUES ('delete-all')");
    const drifted = (db.prepare('SELECT COUNT(*) AS n FROM memories_fts_docsize').get() as { n: number }).n;
    assert.equal(drifted, 0, 'precondition: FTS index emptied');
    db.close();

    db = openDatabase({ dbPath });
    const ftsCount = (db.prepare('SELECT COUNT(*) AS n FROM memories_fts_docsize').get() as { n: number }).n;
    const memCount = (db.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number }).n;
    assert.equal(ftsCount, memCount, 'startup must rebuild the FTS index to match memories');

    const hits = db.prepare(
      "SELECT m.id FROM memories_fts fts JOIN memories m ON m.rowid = fts.rowid WHERE memories_fts MATCH 'webhook'"
    ).all();
    assert.equal(hits.length, 1, 'keyword recall must work again after rebuild');
    db.close();
  });

  it('leaves a consistent index untouched', () => {
    let db = openDatabase({ dbPath });
    new MemoryRepository(db).create({ content: 'stable content row', kind: 'fact', project: null });
    db.close();

    db = openDatabase({ dbPath });
    const ftsCount = (db.prepare('SELECT COUNT(*) AS n FROM memories_fts_docsize').get() as { n: number }).n;
    assert.equal(ftsCount, 1);
    db.close();
  });
});

describe('M6 — findByIds batch lookup', () => {
  let db: Database.Database;
  let repo: MemoryRepository;

  beforeEach(() => {
    db = openDatabase({ dbPath: ':memory:' });
    repo = new MemoryRepository(db);
  });
  afterEach(() => db.close());

  it('returns all requested memories ordered by confidence DESC', () => {
    const low = repo.create({ content: 'low confidence entry about caching', kind: 'fact', project: null, confidence: 0.3 });
    const high = repo.create({ content: 'high confidence entry about indexing', kind: 'fact', project: null, confidence: 0.9 });
    const mid = repo.create({ content: 'mid confidence entry about sharding', kind: 'fact', project: null, confidence: 0.6 });

    const result = repo.findByIds([low.id, high.id, mid.id]);
    assert.deepEqual(result.map(m => m.id), [high.id, mid.id, low.id]);
  });

  it('returns empty array for empty input without querying', () => {
    assert.deepEqual(repo.findByIds([]), []);
  });
});
