import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type Database from 'better-sqlite3';
import { openDatabase } from '../src/db/connection.js';
import { MemoryRepository } from '../src/db/memory-repository.js';
import { LIMITS } from '../src/constants/index.js';

// ============================================================================
// Phase 5: Recall-precision feedback loop
//
// Covers:
//   1. applyPrecisionFeedback walks session_memories and updates confidence
//   2. led_to_success=1 memories get strengthened
//   3. led_to_success=0 memories get mildly weakened (never invalidated)
//   4. Memories not in session_memories are untouched
//   5. Invalidated memories are skipped
//   6. Idempotency — running the pass twice doesn't double-compound
//      disproportionately (confidence is capped at 1.0)
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

function insertSessionMemory(
  sessionId: string,
  memoryId: string,
  ledToSuccess: number,
) {
  db.prepare(`
    INSERT INTO session_memories (session_id, memory_id, recalled_at, led_to_success)
    VALUES (?, ?, datetime('now'), ?)
  `).run(sessionId, memoryId, ledToSuccess);
}

function getConfidence(id: string): number {
  const row = db.prepare('SELECT confidence FROM memories WHERE id = ?')
    .get(id) as { confidence: number } | undefined;
  return row?.confidence ?? 0;
}

describe('applyPrecisionFeedback', () => {
  it('strengthens memories that led to success', () => {
    const { id } = memoryRepo.create({
      content: 'Helpful decision that was used',
      kind: 'decision',
      project: 'test-proj',
      confidence: 0.6,
    });
    insertSessionMemory('sess-1', id, 1);

    const before = getConfidence(id);
    const result = memoryRepo.applyPrecisionFeedback(
      'sess-1',
      LIMITS.PRECISION_STRENGTHEN_INCREMENT,
      LIMITS.PRECISION_WEAKEN_FACTOR,
    );
    const after = getConfidence(id);

    assert.equal(result.strengthened, 1);
    assert.equal(result.weakened, 0);
    assert.ok(after > before, 'confidence should rise');
    assert.ok(
      Math.abs((after - before) - LIMITS.PRECISION_STRENGTHEN_INCREMENT) < 0.001,
      'strengthen delta should match constant',
    );
  });

  it('weakens memories that were recalled but did not lead to success', () => {
    const { id } = memoryRepo.create({
      content: 'Unused pitfall',
      kind: 'pitfall',
      project: 'test-proj',
      confidence: 0.6,
    });
    insertSessionMemory('sess-1', id, 0);

    const before = getConfidence(id);
    const result = memoryRepo.applyPrecisionFeedback(
      'sess-1',
      LIMITS.PRECISION_STRENGTHEN_INCREMENT,
      LIMITS.PRECISION_WEAKEN_FACTOR,
    );
    const after = getConfidence(id);

    assert.equal(result.strengthened, 0);
    assert.equal(result.weakened, 1);
    assert.ok(after < before, 'confidence should fall');
    // Mild weaken: 0.6 * 0.97 = 0.582
    assert.ok(
      Math.abs(after - (before * LIMITS.PRECISION_WEAKEN_FACTOR)) < 0.001,
      'weaken factor should match constant',
    );
  });

  it('does not invalidate memories — floors at DELETE_THRESHOLD + epsilon', () => {
    const { id } = memoryRepo.create({
      content: 'Very low-confidence unused memory',
      kind: 'fact',
      project: 'test-proj',
      confidence: 0.12, // just above the 0.1 delete threshold
    });
    insertSessionMemory('sess-1', id, 0);

    memoryRepo.applyPrecisionFeedback('sess-1', 0.05, 0.97);
    const after = getConfidence(id);
    assert.ok(after >= 0.11, 'floor should prevent the gentle pass from invalidating');

    // Verify the memory is still there (not invalidated)
    const mem = memoryRepo.findById(id);
    assert.ok(mem);
    assert.equal(mem!.invalidated, 0);
  });

  it('skips memories not recalled in this session', () => {
    const { id: recalled } = memoryRepo.create({
      content: 'Recalled in sess-1',
      kind: 'decision',
      project: 'test-proj',
      confidence: 0.6,
    });
    const { id: untouched } = memoryRepo.create({
      content: 'Not recalled in any session',
      kind: 'decision',
      project: 'test-proj',
      confidence: 0.6,
    });
    insertSessionMemory('sess-1', recalled, 1);

    const untouchedBefore = getConfidence(untouched);
    memoryRepo.applyPrecisionFeedback('sess-1', 0.05, 0.97);
    const untouchedAfter = getConfidence(untouched);

    assert.equal(untouchedBefore, untouchedAfter, 'untouched memory must not change');
  });

  it('skips invalidated memories even when referenced in session_memories', () => {
    const { id } = memoryRepo.create({
      content: 'Will be invalidated',
      kind: 'pitfall',
      project: 'test-proj',
      confidence: 0.6,
    });
    insertSessionMemory('sess-1', id, 1);
    db.prepare('UPDATE memories SET invalidated = 1 WHERE id = ?').run(id);

    const result = memoryRepo.applyPrecisionFeedback('sess-1', 0.05, 0.97);
    assert.equal(result.strengthened, 0, 'invalidated memory should not be strengthened');
  });

  it('processes mixed success/failure rows in a single pass', () => {
    const winner = memoryRepo.create({
      content: 'Winning decision',
      kind: 'decision',
      project: 'test-proj',
      confidence: 0.5,
    }).id;
    const loser = memoryRepo.create({
      content: 'Ignored pitfall',
      kind: 'pitfall',
      project: 'test-proj',
      confidence: 0.5,
    }).id;

    insertSessionMemory('sess-mixed', winner, 1);
    insertSessionMemory('sess-mixed', loser, 0);

    const result = memoryRepo.applyPrecisionFeedback(
      'sess-mixed',
      LIMITS.PRECISION_STRENGTHEN_INCREMENT,
      LIMITS.PRECISION_WEAKEN_FACTOR,
    );
    assert.equal(result.strengthened, 1);
    assert.equal(result.weakened, 1);
    assert.ok(getConfidence(winner) > 0.5, 'winner should rise');
    assert.ok(getConfidence(loser) < 0.5, 'loser should fall');
  });

  it('is idempotent in shape — repeated passes keep confidence within [0, 1]', () => {
    const { id } = memoryRepo.create({
      content: 'Repeatedly useful',
      kind: 'decision',
      project: 'test-proj',
      confidence: 0.9,
    });
    insertSessionMemory('sess-idempotent', id, 1);

    for (let i = 0; i < 10; i++) {
      memoryRepo.applyPrecisionFeedback('sess-idempotent', 0.05, 0.97);
    }
    assert.ok(getConfidence(id) <= 1.0, 'confidence must remain capped at 1.0');
    assert.ok(getConfidence(id) > 0.9, 'confidence should have risen');
  });
});
