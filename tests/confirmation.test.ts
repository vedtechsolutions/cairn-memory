import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { isPositiveConfirmation } from '../src/utils/intent-classifier.js';
import { openDatabase } from '../src/db/connection.js';
import { MemoryRepository } from '../src/db/memory-repository.js';
import type Database from 'better-sqlite3';

// ============================================================================
// Positive Confirmation Detection
// ============================================================================

describe('isPositiveConfirmation', () => {
  it('should detect "perfect"', () => {
    assert.ok(isPositiveConfirmation('perfect'));
  });

  it('should detect "perfect!"', () => {
    assert.ok(isPositiveConfirmation('perfect!'));
  });

  it('should detect "exactly"', () => {
    assert.ok(isPositiveConfirmation('exactly'));
  });

  it('should detect "that\'s right"', () => {
    assert.ok(isPositiveConfirmation("that's right"));
  });

  it('should detect "thats right"', () => {
    assert.ok(isPositiveConfirmation('thats right'));
  });

  it('should detect "yes that works"', () => {
    assert.ok(isPositiveConfirmation('yes that works'));
  });

  it('should detect "good call"', () => {
    assert.ok(isPositiveConfirmation('good call'));
  });

  it('should detect "keep doing that"', () => {
    assert.ok(isPositiveConfirmation('keep doing that'));
  });

  it('should detect "yes"', () => {
    assert.ok(isPositiveConfirmation('yes'));
  });

  it('should detect "yep"', () => {
    assert.ok(isPositiveConfirmation('yep'));
  });

  it('should detect "correct"', () => {
    assert.ok(isPositiveConfirmation('correct'));
  });

  it('should detect "nailed it"', () => {
    assert.ok(isPositiveConfirmation('nailed it'));
  });

  it('should detect "spot on"', () => {
    assert.ok(isPositiveConfirmation('spot on'));
  });

  // Anti-patterns
  it('should NOT detect "perfect, but also fix the header"', () => {
    assert.ok(!isPositiveConfirmation('perfect, but also fix the header'));
  });

  it('should NOT detect "yes but change the color"', () => {
    assert.ok(!isPositiveConfirmation('yes but change the color'));
  });

  it('should NOT detect "yes, can you also update the tests"', () => {
    assert.ok(!isPositiveConfirmation('yes, can you also update the tests'));
  });

  it('should NOT detect "perfect, however we need to fix the layout"', () => {
    assert.ok(!isPositiveConfirmation('perfect, however we need to fix the layout'));
  });

  it('should NOT detect "yes, also fix the bug"', () => {
    assert.ok(!isPositiveConfirmation('yes, also fix the bug'));
  });

  it('should NOT detect messages with "change"', () => {
    assert.ok(!isPositiveConfirmation('yes, change the font size'));
  });

  it('should NOT detect messages with "update"', () => {
    assert.ok(!isPositiveConfirmation('correct, update the config too'));
  });

  // Length guard
  it('should NOT detect long messages even with confirmation words', () => {
    const long = 'perfect ' + 'x'.repeat(80);
    assert.ok(!isPositiveConfirmation(long));
  });

  it('should handle empty strings', () => {
    assert.ok(!isPositiveConfirmation(''));
  });

  it('should handle whitespace-only strings', () => {
    assert.ok(!isPositiveConfirmation('   '));
  });
});

// ============================================================================
// Confirmed Decision Integration
// ============================================================================

describe('Confirmed Decision Storage', () => {
  let db: Database.Database;
  let repo: MemoryRepository;

  beforeEach(() => {
    db = openDatabase({ dbPath: ':memory:' });
    repo = new MemoryRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  it('should store a decision with source=confirmed and correct confidence', () => {
    const result = repo.create({
      content: 'User confirmed approach: Edit on schema.ts (verified)',
      kind: 'decision',
      project: 'test-proj',
      source: 'confirmed',
      confidence: 0.7,
    });
    assert.ok(!result.deduplicated);

    const memory = repo.findById(result.id);
    assert.ok(memory);
    assert.equal(memory.source, 'confirmed');
    assert.equal(memory.confidence, 0.7);
    assert.equal(memory.kind, 'decision');
  });

  it('should store user_profile with global scope and correct confidence', () => {
    const result = repo.create({
      content: 'Senior TypeScript developer focused on backend systems',
      kind: 'user_profile',
      project: null,
    });

    const memory = repo.findById(result.id);
    assert.ok(memory);
    assert.equal(memory.kind, 'user_profile');
    assert.equal(memory.project, null);
    assert.equal(memory.confidence, 0.75);
  });

  it('should store reference with correct confidence', () => {
    const result = repo.create({
      content: 'Pipeline bugs tracked in Linear project INGEST',
      kind: 'reference',
      tags: ['ref:linear'],
      project: 'test-proj',
    });

    const memory = repo.findById(result.id);
    assert.ok(memory);
    assert.equal(memory.kind, 'reference');
    assert.equal(memory.confidence, 0.75);
    assert.deepEqual(memory.tags, ['ref:linear']);
  });

  it('should store and retrieve structured context', () => {
    const result = repo.create({
      content: 'Always use parameterized queries',
      kind: 'pitfall',
      project: 'test-proj',
      context: { why: 'Prevents SQL injection', how_to_apply: 'Use ? placeholders in all queries' },
    });

    const memory = repo.findById(result.id);
    assert.ok(memory);
    assert.ok(memory.context);
    assert.equal(memory.context.why, 'Prevents SQL injection');
    assert.equal(memory.context.how_to_apply, 'Use ? placeholders in all queries');
  });

  it('should handle null context gracefully', () => {
    const result = repo.create({
      content: 'A simple fact without context',
      kind: 'fact',
      project: 'test-proj',
    });

    const memory = repo.findById(result.id);
    assert.ok(memory);
    assert.equal(memory.context, null);
  });

  it('should retrieve user profiles via topUserProfiles', () => {
    repo.create({ content: 'Senior dev', kind: 'user_profile', project: null });
    repo.create({ content: 'Prefers TypeScript', kind: 'user_profile', project: null });
    repo.create({ content: 'New to React', kind: 'user_profile', project: null });
    repo.create({ content: 'Fourth profile', kind: 'user_profile', project: null });

    const profiles = repo.topUserProfiles(3);
    assert.equal(profiles.length, 3);
    assert.ok(profiles.every(p => p.kind === 'user_profile'));
  });

  it('should only return global user profiles (not project-scoped)', () => {
    repo.create({ content: 'Global profile', kind: 'user_profile', project: null });
    // Manually insert a project-scoped one (normally prevented by cairn_learn)
    repo.create({ content: 'Scoped profile', kind: 'user_profile', project: 'some-proj' });

    const profiles = repo.topUserProfiles(10);
    assert.equal(profiles.length, 1);
    assert.equal(profiles[0].content, 'Global profile');
  });
});
