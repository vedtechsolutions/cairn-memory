/**
 * Regression tests for the 2026-07-08 audit correctness batch:
 *  H3 — JS vector fallback is capped (source guardrail, mirrors snr-guardrails idiom)
 *  H4 — dedup never merges across project/global scope
 *  H5 — recallByAnchor escapes LIKE wildcards (underscores in file names)
 *  H6 — tracker saves are atomic (temp+rename, no leftover temp files)
 *  H7 — auto-promotion creates no self-referential edge
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, mkdtempSync, mkdirSync, rmSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type Database from 'better-sqlite3';

import { openDatabase } from '../src/db/connection.js';
import { MemoryRepository } from '../src/db/memory-repository.js';
import { runAutoPromotion } from '../src/db/maintenance.js';
import { saveTracker, loadTracker, updateTracker, deleteTracker, getTrackerPath } from '../src/hooks/shared/edit-tracker.js';
import { escapeLikePattern } from '../src/utils/validation.js';
import { ENV } from '../src/constants/env.js';

describe('H3 — JS vector fallback scan is capped', () => {
  it('fallback query orders by confidence and applies the scan-limit constant', () => {
    const source = readFileSync(join(process.cwd(), 'src/db/memory-repository/vector-search.ts'), 'utf-8');
    const fallbackStart = source.indexOf('// JS fallback');
    assert.ok(fallbackStart > 0, 'JS fallback block must exist');
    const fallbackBlock = source.slice(fallbackStart, fallbackStart + 1600); // window covers the step-6 decision comment + the SQL
    assert.match(fallbackBlock, /ORDER BY confidence DESC/, 'fallback must rank before capping');
    assert.match(fallbackBlock, /LIMIT \?/, 'fallback must be LIMIT-bounded');
    assert.match(fallbackBlock, /VECTOR_FALLBACK_SCAN_LIMIT/, 'cap must come from constants');
  });
});

describe('H4 — dedup is scope-exact', () => {
  let db: Database.Database;
  let repo: MemoryRepository;
  const CONTENT = 'always validate webhook signatures before trusting payment provider callbacks';

  beforeEach(() => {
    db = openDatabase({ dbPath: ':memory:' });
    repo = new MemoryRepository(db);
  });
  afterEach(() => db.close());

  it('does not merge a project memory into an identical global memory', () => {
    const globalResult = repo.create({ content: CONTENT, kind: 'pitfall', project: null });
    const projectResult = repo.create({ content: CONTENT, kind: 'pitfall', project: 'proj-a' });

    assert.equal(globalResult.deduplicated, false);
    assert.equal(projectResult.deduplicated, false, 'different scope must create a new row, not merge');
    assert.notEqual(projectResult.id, globalResult.id);

    const globalRow = db.prepare('SELECT project FROM memories WHERE id = ?').get(globalResult.id) as { project: string | null };
    assert.equal(globalRow.project, null, 'global memory must keep global scope');
  });

  it('still dedups within the same project scope', () => {
    const first = repo.create({ content: CONTENT, kind: 'pitfall', project: 'proj-a' });
    const second = repo.create({ content: CONTENT, kind: 'pitfall', project: 'proj-a' });
    assert.equal(second.deduplicated, true);
    assert.equal(second.id, first.id);
  });

  it('still dedups within global scope', () => {
    const first = repo.create({ content: CONTENT, kind: 'pitfall', project: null });
    const second = repo.create({ content: CONTENT, kind: 'pitfall', project: null });
    assert.equal(second.deduplicated, true);
    assert.equal(second.id, first.id);
  });
});

describe('H5 — recallByAnchor escapes LIKE wildcards', () => {
  let db: Database.Database;
  let repo: MemoryRepository;

  beforeEach(() => {
    db = openDatabase({ dbPath: ':memory:' });
    repo = new MemoryRepository(db);
  });
  afterEach(() => db.close());

  function createAnchored(content: string, file: string): string {
    const result = repo.create({ content, kind: 'pitfall', project: 'proj-a', confidence: 0.9 });
    db.prepare('UPDATE memories SET anchor = ? WHERE id = ?').run(JSON.stringify({ file }), result.id);
    return result.id;
  }

  it('underscore in the query path no longer acts as a single-char wildcard', () => {
    createAnchored('pitfall about a similarly named file', 'src/fooXbar.ts');
    const hits = repo.recallByAnchor('src/foo_bar.ts', { project: 'proj-a' });
    assert.equal(hits.length, 0, 'foo_bar must not LIKE-match fooXbar');
  });

  it('exact underscore paths still match', () => {
    const id = createAnchored('pitfall about the real file', 'src/foo_bar.ts');
    const hits = repo.recallByAnchor('src/foo_bar.ts', { project: 'proj-a' });
    assert.equal(hits.length, 1);
    assert.equal(hits[0].id, id);
  });

  it('escapeLikePattern escapes %, _ and backslash', () => {
    assert.equal(escapeLikePattern('100%_cover\\age'), '100\\%\\_cover\\\\age');
    assert.equal(escapeLikePattern('plain.ts'), 'plain.ts');
  });
});

describe('H6 — tracker saves are atomic (torn-write fix)', () => {
  const SESSION = `audit-h6-test-${process.pid}`;
  let tmpCairnDir: string;
  let prevCairnDir: string | undefined;

  beforeEach(() => {
    // Hermetic: point the tracker at a temp dir instead of the real ~/.cairn
    prevCairnDir = process.env[ENV.DIR];
    tmpCairnDir = mkdtempSync(join(tmpdir(), 'cairn-h6-'));
    process.env[ENV.DIR] = tmpCairnDir;
  });
  afterEach(() => {
    deleteTracker(SESSION);
    if (prevCairnDir === undefined) delete process.env[ENV.DIR];
    else process.env[ENV.DIR] = prevCairnDir;
    rmSync(tmpCairnDir, { recursive: true, force: true });
  });

  it('getTrackerPath honors the CAIRN_DIR override', () => {
    assert.ok(
      getTrackerPath(SESSION).startsWith(tmpCairnDir),
      'tracker path must resolve inside CAIRN_DIR when set',
    );
  });

  it('round-trips through temp+rename without leaving temp files', () => {
    const tracker = loadTracker(SESSION);
    tracker.lastEditPath = '/tmp/some-file.ts';
    tracker.editCountsByFile = { '/tmp/some-file.ts': 3 };
    saveTracker(tracker, SESSION);

    const reloaded = loadTracker(SESSION);
    assert.equal(reloaded.lastEditPath, '/tmp/some-file.ts');
    assert.equal(reloaded.editCountsByFile['/tmp/some-file.ts'], 3);

    const trackerBase = getTrackerPath(SESSION).split('/').pop() as string;
    const leftovers = existsSync(tmpCairnDir)
      ? readdirSync(tmpCairnDir).filter(f => f.startsWith(trackerBase) && f.endsWith('.tmp'))
      : [];
    assert.deepEqual(leftovers, [], 'no temp files may survive a successful save');
  });

  it('updateTracker persists mutations and releases its lock', () => {
    updateTracker(SESSION, t => { t.lastEditPath = '/a.ts'; });
    // Second update sees the first one (no lost update) and can acquire the lock
    const result = updateTracker(SESSION, t => {
      assert.equal(t.lastEditPath, '/a.ts', 'second update must see the first mutation');
      t.editCountsByFile = { '/a.ts': 1 };
    });
    assert.equal(result.editCountsByFile['/a.ts'], 1);
    assert.ok(!existsSync(`${getTrackerPath(SESSION)}.lock`), 'lock must be released');
  });

  it('updateTracker steals a stale lock instead of hanging', () => {
    const lockPath = `${getTrackerPath(SESSION)}.lock`;
    mkdirSync(lockPath, { recursive: true });
    const staleTime = new Date(Date.now() - 60_000);
    utimesSync(lockPath, staleTime, staleTime);

    const before = Date.now();
    updateTracker(SESSION, t => { t.lastEditPath = '/stale.ts'; });
    assert.ok(Date.now() - before < 1_000, 'stale lock must be stolen promptly');
    assert.equal(loadTracker(SESSION).lastEditPath, '/stale.ts');
  });

  it('updateTracker fails open when a fresh lock never releases', () => {
    const lockPath = `${getTrackerPath(SESSION)}.lock`;
    mkdirSync(lockPath, { recursive: true }); // fresh mtime — held by a "live" process

    const before = Date.now();
    updateTracker(SESSION, t => { t.lastEditPath = '/failopen.ts'; });
    const elapsed = Date.now() - before;
    assert.ok(elapsed < 2_000, 'must not hang on a held lock (hooks cannot block Claude Code)');
    assert.equal(loadTracker(SESSION).lastEditPath, '/failopen.ts', 'mutation still applied fail-open');
    rmSync(lockPath, { recursive: true, force: true });
  });
});

describe('H7 — auto-promotion creates no self-edge', () => {
  let db: Database.Database;
  let repo: MemoryRepository;

  beforeEach(() => {
    db = openDatabase({ dbPath: ':memory:' });
    repo = new MemoryRepository(db);
  });
  afterEach(() => db.close());

  it('promotes a cross-project memory without a self-referential generalizes edge', () => {
    const content = 'always validate webhook signatures before processing payment events';
    const a = repo.create({ content, kind: 'pitfall', project: 'proj-a', confidence: 0.9 });
    const b = repo.create({ content, kind: 'pitfall', project: 'proj-b', confidence: 0.9 });

    const backdated = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare('UPDATE memories SET created_at = ?, impact_count = 2 WHERE id IN (?, ?)').run(backdated, a.id, b.id);

    const { promoted } = runAutoPromotion(db);
    assert.ok(promoted >= 1, 'candidate meeting all criteria must promote');

    const selfEdges = db.prepare('SELECT COUNT(*) as n FROM memory_edges WHERE source_id = target_id').get() as { n: number };
    assert.equal(selfEdges.n, 0, 'promotion must not create self-referential edges');

    const promotedRow = db.prepare('SELECT project FROM memories WHERE id = ?').get(a.id) as { project: string | null };
    assert.equal(promotedRow.project, null, 'promoted memory must become global');
  });
});
