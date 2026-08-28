import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type Database from 'better-sqlite3';
import { openDatabase } from '../src/db/connection.js';
import { MemoryRepository } from '../src/db/memory-repository.js';

// ============================================================================
// Phase 4: Goals as first-class memories + semantic pre-flight match
//
// Covers:
//   1. Schema v22 — 'goal' kind accepted in memories
//   2. Goal memory round-trips through create + findById
//   3. recall() with kind='goal' returns matching prior goals
//   4. passesCrossProjectGuard filters cross-project leakage for goals
//   5. Tags allow 'plan-goal' marker for cairn_plan(create)-sourced goals
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

describe('Goal memory storage (Phase 4)', () => {
  it('creates and retrieves a goal memory', () => {
    const result = memoryRepo.create({
      content: 'Implement north-star goal continuity across meta turns',
      kind: 'goal',
      project: 'test-proj',
      confidence: 0.65,
      tags: ['plan-goal'],
    });
    const fetched = memoryRepo.findById(result.id);
    assert.ok(fetched);
    assert.equal(fetched!.kind, 'goal');
    assert.ok(fetched!.tags.includes('plan-goal'));
  });

  it('recalls similar goals by content match', () => {
    memoryRepo.create({
      content: 'Add sticky project goal across meta turns in the briefing',
      kind: 'goal',
      project: 'test-proj',
      confidence: 0.7,
    });
    memoryRepo.create({
      content: 'Refactor the hook socket to use named pipes',
      kind: 'goal',
      project: 'test-proj',
      confidence: 0.7,
    });

    const results = memoryRepo.recall('project goal continuity across meta turns', {
      project: 'test-proj',
      kind: 'goal',
      maxResults: 2,
      minConfidence: 0.5,
    });
    assert.ok(results.length >= 1, 'should match at least one goal');
    assert.match(results[0].memory.content, /sticky project goal/);
  });

  it('isolates goals by project when recalling', () => {
    memoryRepo.create({
      content: 'Build OAuth flow for user authentication',
      kind: 'goal',
      project: 'proj-a',
      confidence: 0.7,
    });
    memoryRepo.create({
      content: 'Build OAuth flow for user authentication',
      kind: 'goal',
      project: 'proj-b',
      confidence: 0.7,
    });

    const results = memoryRepo.recall('oauth flow user authentication', {
      project: 'proj-a',
      kind: 'goal',
      maxResults: 5,
      minConfidence: 0.5,
    });
    // Should return only the proj-a goal (plus nulls, but not proj-b explicit)
    const projects = results.map(r => r.memory.project);
    assert.ok(!projects.includes('proj-b'), 'must not leak proj-b goal into proj-a recall');
  });

  it('accepts null project for global goals', () => {
    const result = memoryRepo.create({
      content: 'Improve overall developer experience across all projects',
      kind: 'goal',
      project: null,
      confidence: 0.7,
    });
    const fetched = memoryRepo.findById(result.id);
    assert.ok(fetched);
    assert.equal(fetched!.project, null);
  });

  it('honors minConfidence gate on goal recall', () => {
    memoryRepo.create({
      content: 'Low-confidence goal that should be filtered out',
      kind: 'goal',
      project: 'test-proj',
      confidence: 0.3,
    });
    const results = memoryRepo.recall('low confidence goal', {
      project: 'test-proj',
      kind: 'goal',
      maxResults: 5,
      minConfidence: 0.5,
    });
    assert.equal(results.length, 0, 'low-confidence goal should be filtered');
  });
});
