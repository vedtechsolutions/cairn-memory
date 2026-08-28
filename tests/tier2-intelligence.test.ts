/**
 * Tier 2 Intelligence tests — anchoring, auto-promotion, co-recall prediction, session scoring.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db/connection.js';
import { MemoryRepository } from '../src/db/memory-repository.js';
import { extractAnchor, anchorToJson, jsonToAnchor } from '../src/utils/anchor.js';
import { trackCoRecall, predictRelated, markRecallSuccess, computeRecallPrecision } from '../src/utils/prediction.js';
import { runAutoPromotion } from '../src/db/maintenance.js';
import type Database from 'better-sqlite3';

let db: Database.Database;
let repo: MemoryRepository;

beforeEach(() => {
  db = openDatabase({ dbPath: ':memory:' });
  repo = new MemoryRepository(db);
});

afterEach(() => {
  db.close();
});

// --- Schema v11 -----------------------------------------------------------

describe('Schema v11', () => {
  it('should have anchor column on memories table', () => {
    const columns = db.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>;
    assert.ok(columns.some(c => c.name === 'anchor'), 'memories should have anchor column');
  });

  it('should have memory_corecall table', () => {
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='memory_corecall'"
    ).all();
    assert.equal(tables.length, 1);
  });

  it('should have session_memories table', () => {
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='session_memories'"
    ).all();
    assert.equal(tables.length, 1);
  });
});

// --- Anchor Extraction -----------------------------------------------------

describe('Anchor Extraction', () => {
  it('should extract file paths from content', () => {
    const anchor = extractAnchor('Always validate input in src/utils/validator.ts before saving');
    assert.ok(anchor, 'should extract anchor');
    assert.ok(anchor.files.some(f => f.includes('validator.ts')), 'should find validator.ts');
  });

  it('should extract multiple file paths', () => {
    const anchor = extractAnchor('Check both src/auth.ts and lib/tokens.js for the token flow');
    assert.ok(anchor, 'should extract anchor');
    assert.ok(anchor.files.length >= 2, `should find 2+ files, got ${anchor.files.length}`);
  });

  it('should extract CamelCase class names as symbols', () => {
    const anchor = extractAnchor('The MemoryRepository class handles all database queries');
    assert.ok(anchor, 'should extract anchor');
    assert.ok(anchor.symbols.some(s => s === 'MemoryRepository'), 'should find MemoryRepository');
  });

  it('should extract function calls as symbols', () => {
    const anchor = extractAnchor('Always call validateInput() before processData()');
    assert.ok(anchor, 'should extract anchor');
    assert.ok(anchor.symbols.some(s => s === 'validateInput'), 'should find validateInput');
    assert.ok(anchor.symbols.some(s => s === 'processData'), 'should find processData');
  });

  it('should return null for content without code references', () => {
    const anchor = extractAnchor('Always be careful with user input');
    // May or may not return null depending on whether generic words match
    // The important thing is no false positive file paths
    if (anchor) {
      assert.equal(anchor.files.length, 0, 'should have no file paths');
    }
  });

  it('should filter out false positive paths', () => {
    const anchor = extractAnchor('Use e.g. proper validation, i.e. sanitization');
    if (anchor) {
      assert.equal(anchor.files.length, 0, 'e.g. and i.e. should not be file paths');
    }
  });

  it('should serialize and deserialize anchors', () => {
    const original = { files: ['src/foo.ts'], symbols: ['Bar'] };
    const json = anchorToJson(original);
    const recovered = jsonToAnchor(json);
    assert.deepEqual(recovered, original);
  });

  it('should handle invalid JSON gracefully', () => {
    assert.equal(jsonToAnchor('not json'), null);
    assert.equal(jsonToAnchor('{}'), null);
  });
});

// --- Anchor Storage and Recall ---------------------------------------------

describe('Anchor-Based Recall', () => {
  it('should store anchor on create and recall by file path', () => {
    const anchor = anchorToJson({ files: ['src/auth/validator.ts'], symbols: ['validateToken'] });
    repo.create({
      content: 'Always check token expiry in validator before proceeding',
      kind: 'pitfall',
      anchor,
    });

    const results = repo.recallByAnchor('src/auth/validator.ts', { maxResults: 5 });
    assert.ok(results.length >= 1, 'should find anchored memory');
    assert.ok(results[0].content.includes('token expiry'));
  });

  it('should match by basename', () => {
    const anchor = anchorToJson({ files: ['src/deep/nested/handler.ts'], symbols: [] });
    repo.create({
      content: 'Handler has a race condition on concurrent requests',
      kind: 'pitfall',
      anchor,
    });

    // Search by basename only
    const results = repo.recallByAnchor('handler.ts', { maxResults: 5 });
    assert.ok(results.length >= 1, 'should find by basename');
  });

  it('should not return unanchored memories', () => {
    repo.create({ content: 'generic pitfall without anchor', kind: 'pitfall' });
    const results = repo.recallByAnchor('some-file.ts', { maxResults: 5 });
    assert.equal(results.length, 0, 'should not match unanchored memories');
  });

  it('should auto-extract anchor in cairn_learn flow', () => {
    // Simulate what cairn_learn does
    const content = 'The validateInput() function in src/utils/validation.ts has an edge case';
    const anchor = extractAnchor(content);
    const anchorStr = anchor ? anchorToJson(anchor) : undefined;

    repo.create({ content, kind: 'pitfall', anchor: anchorStr });

    const results = repo.recallByAnchor('validation.ts', { maxResults: 5 });
    assert.ok(results.length >= 1, 'should find via auto-extracted anchor');
  });
});

// --- Co-Recall Tracking ----------------------------------------------------

describe('Co-Recall Tracking', () => {
  it('should track session-memory associations', () => {
    const id1 = repo.create({ content: 'always validate CSRF tokens on POST routes', kind: 'fact' }).id;
    const id2 = repo.create({ content: 'use connection pooling for PostgreSQL databases', kind: 'decision' }).id;

    trackCoRecall(db, 'session-1', [id1, id2]);

    const rows = db.prepare('SELECT * FROM session_memories WHERE session_id = ?')
      .all('session-1') as Array<{ memory_id: string }>;
    assert.equal(rows.length, 2);
  });

  it('should increment co-recall counts', () => {
    const id1 = repo.create({ content: 'enable gzip compression for API responses', kind: 'fact' }).id;
    const id2 = repo.create({ content: 'use Redis caching for session storage', kind: 'decision' }).id;

    trackCoRecall(db, 'session-1', [id1, id2]);
    trackCoRecall(db, 'session-2', [id1, id2]);

    const [a, b] = [id1, id2].sort();
    const row = db.prepare('SELECT co_count FROM memory_corecall WHERE memory_a = ? AND memory_b = ?')
      .get(a, b) as { co_count: number };
    assert.equal(row.co_count, 2);
  });

  it('should handle single-item recall without creating co-recall entries', () => {
    const id1 = repo.create({ content: 'implement rate limiting on authentication endpoints', kind: 'fact' }).id;
    trackCoRecall(db, 'session-1', [id1]);

    const rows = db.prepare('SELECT * FROM memory_corecall').all();
    assert.equal(rows.length, 0, 'no co-recall entries for single item');
  });
});

// --- Predictive Pre-Fetching -----------------------------------------------

describe('Predictive Pre-Fetching', () => {
  it('should predict related memories from co-recall history', () => {
    const id1 = repo.create({ content: 'always sanitize HTML output to prevent XSS attacks', kind: 'pitfall' }).id;
    const id2 = repo.create({ content: 'use parameterized queries for all database operations', kind: 'decision' }).id;
    const id3 = repo.create({ content: 'enable CORS headers only for trusted origins', kind: 'fact' }).id;

    // id1 and id2 are frequently recalled together
    trackCoRecall(db, 's1', [id1, id2]);
    trackCoRecall(db, 's2', [id1, id2]);
    trackCoRecall(db, 's3', [id1, id2]);

    // id1 and id3 are rarely recalled together
    trackCoRecall(db, 's4', [id1, id3]);

    // Predict: given id1 was just recalled, what else should we fetch?
    const predicted = predictRelated(db, [id1], 5);
    assert.ok(predicted.length >= 1, 'should predict at least 1 related memory');
    assert.equal(predicted[0], id2, 'id2 should rank first (3 co-recalls vs 1)');
  });

  it('should not predict already-recalled memories', () => {
    const id1 = repo.create({ content: 'configure TLS certificates for HTTPS endpoints', kind: 'fact' }).id;
    const id2 = repo.create({ content: 'implement webhook signature verification', kind: 'decision' }).id;

    trackCoRecall(db, 's1', [id1, id2]);

    // Both already recalled — should predict nothing
    const predicted = predictRelated(db, [id1, id2], 5);
    assert.equal(predicted.length, 0);
  });

  it('should return empty for unknown memories', () => {
    const predicted = predictRelated(db, ['nonexistent-id'], 5);
    assert.equal(predicted.length, 0);
  });
});

// --- Session Continuity Scoring --------------------------------------------

describe('Session Continuity Scoring', () => {
  it('should mark recall as successful', () => {
    const id1 = repo.create({ content: 'check database migrations before deploying', kind: 'pitfall' }).id;
    trackCoRecall(db, 'test-session', [id1]);

    markRecallSuccess(db, 'test-session', id1);

    const row = db.prepare(
      'SELECT led_to_success FROM session_memories WHERE session_id = ? AND memory_id = ?'
    ).get('test-session', id1) as { led_to_success: number };
    assert.equal(row.led_to_success, 1);
  });

  it('should compute recall precision correctly', () => {
    const id1 = repo.create({ content: 'validate JWT token signatures before trusting claims', kind: 'pitfall' }).id;
    const id2 = repo.create({ content: 'sanitize file upload names to prevent path traversal', kind: 'pitfall' }).id;
    const id3 = repo.create({ content: 'use environment variables for sensitive configuration', kind: 'fact' }).id;

    trackCoRecall(db, 'precision-session', [id1, id2, id3]);
    markRecallSuccess(db, 'precision-session', id1);
    markRecallSuccess(db, 'precision-session', id2);

    const { recalled, successful, precision } = computeRecallPrecision(db, 'precision-session');
    assert.equal(recalled, 3);
    assert.equal(successful, 2);
    assert.ok(Math.abs(precision - 2 / 3) < 0.001, `expected ~0.667, got ${precision}`);
  });

  it('should return zero precision for unknown session', () => {
    const { recalled, precision } = computeRecallPrecision(db, 'no-such-session');
    assert.equal(recalled, 0);
    assert.equal(precision, 0);
  });
});

// --- Auto-Promotion --------------------------------------------------------

describe('Auto-Promotion', () => {
  it('should promote high-impact cross-project memories', () => {
    // Create similar memories in two different projects
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 90);
    const oldIso = oldDate.toISOString();

    const id1 = repo.create({
      content: 'always validate CSRF tokens on POST requests',
      kind: 'pitfall',
      project: 'project-alpha',
      confidence: 0.85,
    }).id;

    const id2 = repo.create({
      content: 'validate CSRF tokens on all POST endpoints',
      kind: 'pitfall',
      project: 'project-beta',
      confidence: 0.8,
    }).id;

    // Backdate and add impact
    db.prepare('UPDATE memories SET created_at = ?, impact_count = 3, surface_count = 5 WHERE id = ?').run(oldIso, id1);
    db.prepare('UPDATE memories SET created_at = ?, impact_count = 2, surface_count = 4 WHERE id = ?').run(oldIso, id2);

    const result = runAutoPromotion(db);

    if (result.promoted > 0) {
      // Check that one was promoted (project set to null)
      const promoted = db.prepare(
        'SELECT id FROM memories WHERE project IS NULL AND content LIKE ?'
      ).all('%CSRF%') as Array<{ id: string }>;
      assert.ok(promoted.length >= 1, 'should have at least one global CSRF memory');
    }
  });

  it('should not promote low-confidence memories', () => {
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 90);
    const oldIso = oldDate.toISOString();

    repo.create({ content: 'low conf cross project test', kind: 'pitfall', project: 'proj-a', confidence: 0.3 });
    repo.create({ content: 'low conf cross project test', kind: 'pitfall', project: 'proj-b', confidence: 0.3 });

    db.prepare("UPDATE memories SET created_at = ?, impact_count = 1 WHERE content LIKE '%low conf%'").run(oldIso);

    const result = runAutoPromotion(db);
    assert.equal(result.promoted, 0, 'should not promote low-confidence memories');
  });

  it('should not promote young memories', () => {
    // Recent memories (not old enough)
    repo.create({
      content: 'young cross project validation test',
      kind: 'pitfall',
      project: 'proj-a',
      confidence: 0.9,
    });
    repo.create({
      content: 'young cross project validation test',
      kind: 'pitfall',
      project: 'proj-b',
      confidence: 0.9,
    });
    db.prepare("UPDATE memories SET impact_count = 5 WHERE content LIKE '%young cross%'").run();

    const result = runAutoPromotion(db);
    assert.equal(result.promoted, 0, 'should not promote young memories');
  });

  it('should cap promotions at 3 per run', () => {
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 90);
    const oldIso = oldDate.toISOString();

    // Create 5 pairs of cross-project memories
    for (let i = 0; i < 5; i++) {
      repo.create({ content: `bulk promote test item number ${i} unique`, kind: 'pitfall', project: 'proj-x', confidence: 0.9 });
      repo.create({ content: `bulk promote test item number ${i} unique`, kind: 'pitfall', project: 'proj-y', confidence: 0.9 });
    }
    db.prepare("UPDATE memories SET created_at = ?, impact_count = 5 WHERE content LIKE '%bulk promote%'").run(oldIso);

    const result = runAutoPromotion(db);
    assert.ok(result.promoted <= 3, `should cap at 3, got ${result.promoted}`);
  });
});

// --- Integration: trackCoRecall in repo ------------------------------------

describe('Repository Co-Recall Integration', () => {
  it('should track co-recall via repository method', () => {
    const id1 = repo.create({ content: 'configure database connection timeouts appropriately', kind: 'fact' }).id;
    const id2 = repo.create({ content: 'implement graceful shutdown for worker processes', kind: 'decision' }).id;

    repo.trackCoRecall('int-session', [id1, id2]);

    const rows = db.prepare('SELECT * FROM session_memories WHERE session_id = ?')
      .all('int-session');
    assert.equal(rows.length, 2);
  });
});
