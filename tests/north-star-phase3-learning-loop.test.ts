import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type Database from 'better-sqlite3';
import { openDatabase } from '../src/db/connection.js';
import { MemoryRepository } from '../src/db/memory-repository.js';
import { extractWinningPattern } from '../src/hooks/shared/transcript-parser.js';

// ============================================================================
// Phase 3: Positive pattern learning + iteration-cost tracker
//
// Covers:
//   1. Schema v22 — memories.kind CHECK allows 'pattern' and 'goal'
//   2. extractWinningPattern — happy paths and noise rejection
//   3. Memory creation for pattern kind round-trips cleanly
// ============================================================================

let db: Database.Database;
let memoryRepo: MemoryRepository;

beforeEach(() => {
  db = openDatabase({ dbPath: ':memory:' });
  memoryRepo = new MemoryRepository(db);
});

afterEach(() => {
  db.close();
});

describe('Schema v22: pattern + goal memory kinds', () => {
  it('accepts pattern kind in memories table', () => {
    const result = memoryRepo.create({
      content: 'Used the RFD approach — wrote the full plan before touching code, tests passed first try.',
      kind: 'pattern',
      project: 'test-proj',
      confidence: 0.6,
    });
    assert.ok(result.id);

    const fetched = memoryRepo.findById(result.id);
    assert.ok(fetched);
    assert.equal(fetched!.kind, 'pattern');
  });

  it('accepts goal kind in memories table', () => {
    const result = memoryRepo.create({
      content: 'Implement north-star goal continuity across meta turns',
      kind: 'goal',
      project: 'test-proj',
      confidence: 0.7,
    });
    assert.ok(result.id);

    const fetched = memoryRepo.findById(result.id);
    assert.ok(fetched);
    assert.equal(fetched!.kind, 'goal');
  });

  it('rejects unknown kinds via CHECK constraint', () => {
    assert.throws(() => {
      db.prepare(`
        INSERT INTO memories (id, content, kind, created_at)
        VALUES ('bogus', 'x', 'invalid_kind', '2025-01-01')
      `).run();
    });
  });
});

describe('extractWinningPattern', () => {
  it('extracts a pattern when approach + success are both present', () => {
    const text = 'We used the two-step refactor approach — rename first, then extract the interface. ' +
                 'Tests pass and the build is clean on the first try.';
    const result = extractWinningPattern(text);
    assert.ok(result, 'should extract a pattern');
    assert.match(result!, /two-step refactor/);
  });

  it('returns null when only approach signal is present (no success)', () => {
    const text = 'We used the two-step refactor approach — rename first, then extract the interface.';
    assert.equal(extractWinningPattern(text), null);
  });

  it('returns null when only success signal is present (no approach)', () => {
    const text = 'All tests pass cleanly after the change was landed.';
    assert.equal(extractWinningPattern(text), null);
  });

  it('returns null for markdown header reports', () => {
    const text = '## Summary\n\nWe used the refactor approach and tests pass on first try.';
    assert.equal(extractWinningPattern(text), null);
  });

  it('returns null for heavy bullet lists (recap-style text)', () => {
    const text = 'Summary:\n- Used approach X\n- Applied pattern Y\n- Tests pass first try';
    assert.equal(extractWinningPattern(text), null);
  });

  it('returns null for conversational openers', () => {
    const text = 'Great question! We used the refactor approach and all tests pass on first try.';
    assert.equal(extractWinningPattern(text), null);
  });

  it('returns null for short text', () => {
    assert.equal(extractWinningPattern('Used X — tests pass.'), null);
  });

  it('returns null for very long recap text', () => {
    const text = 'We used the refactor approach and tests pass on first try. ' + 'More detail. '.repeat(50);
    assert.equal(extractWinningPattern(text), null);
  });

  it('rejects generic "all tests pass" line on its own', () => {
    assert.equal(extractWinningPattern('All tests pass.'), null);
  });

  it('accepts a pattern mentioning clean build + adopted strategy', () => {
    const text = 'I adopted the stateless-helper pattern for the branch-goal synthesizer: ' +
                 'pure function, no side effects, easy to test. Clean build and zero regressions.';
    const result = extractWinningPattern(text);
    assert.ok(result, 'should extract a pattern');
    assert.match(result!, /stateless-helper/);
  });
});
