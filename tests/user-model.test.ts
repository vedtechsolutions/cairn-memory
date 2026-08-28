import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db/connection.js';
import { UserModelRepository } from '../src/db/user-model-repository.js';
import { detectUserProfile } from '../src/utils/intent-classifier.js';
import { compileBriefing, type BriefingContext } from '../src/hooks/shared/briefing-compiler.js';
import { MemoryRepository } from '../src/db/memory-repository.js';
import { PlanRepository } from '../src/db/plan-repository.js';

describe('UserModelRepository', () => {
  it('should upsert a new entry', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    const repo = new UserModelRepository(db);

    const entry = repo.upsert('role', 'developer', 'senior');
    assert.equal(entry.dimension, 'role');
    assert.equal(entry.key, 'developer');
    assert.equal(entry.value, 'senior');
    assert.equal(entry.evidence_count, 1);
    assert.equal(entry.confidence, 0.5);
    db.close();
  });

  it('should boost confidence on repeat observation', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    const repo = new UserModelRepository(db);

    repo.upsert('role', 'developer', 'senior');
    const updated = repo.upsert('role', 'developer', 'senior');
    assert.equal(updated.evidence_count, 2);
    assert.ok(updated.confidence > 0.5, 'confidence should increase');
    db.close();
  });

  it('should cap confidence at 0.95', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    const repo = new UserModelRepository(db);

    // Upsert many times to hit cap
    for (let i = 0; i < 20; i++) {
      repo.upsert('role', 'developer', 'senior');
    }
    const entry = repo.getByDimension('role')[0];
    assert.ok(entry.confidence <= 0.95, `confidence ${entry.confidence} should be <= 0.95`);
    db.close();
  });

  it('should return entries by dimension', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    const repo = new UserModelRepository(db);

    repo.upsert('expertise', 'typescript', 'expert');
    repo.upsert('expertise', 'python', 'familiar');
    repo.upsert('role', 'developer', 'senior');

    const expertise = repo.getByDimension('expertise');
    assert.equal(expertise.length, 2);
    assert.ok(expertise.some(e => e.key === 'typescript'));
    assert.ok(expertise.some(e => e.key === 'python'));

    const roles = repo.getByDimension('role');
    assert.equal(roles.length, 1);
    db.close();
  });

  it('should return full structured profile', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    const repo = new UserModelRepository(db);

    repo.upsert('role', 'developer', 'senior');
    repo.upsert('expertise', 'typescript', 'expert');
    repo.upsert('preference', 'quality_over_speed', 'true');

    const profile = repo.getProfile();
    assert.equal(profile.role.length, 1);
    assert.equal(profile.expertise.length, 1);
    assert.equal(profile.preference.length, 1);
    assert.equal(profile.team.length, 0);
    assert.equal(profile.style.length, 0);
    db.close();
  });

  it('should render compact one-line summary', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    const repo = new UserModelRepository(db);

    repo.upsert('role', 'developer', 'senior');
    repo.upsert('expertise', 'typescript', 'expert');
    repo.upsert('preference', 'quality_over_speed', 'true');

    const compact = repo.renderCompact();
    assert.ok(compact, 'should return a string');
    assert.ok(compact!.includes('senior developer'), 'should include role');
    assert.ok(compact!.includes('typescript'), 'should include expertise');
    assert.ok(compact!.includes('quality_over_speed'), 'should include preference');
    db.close();
  });

  it('should return null for empty model', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    const repo = new UserModelRepository(db);

    assert.equal(repo.renderCompact(), null);
    assert.equal(repo.hasEntries(), false);
    db.close();
  });

  it('should detect hasEntries correctly', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    const repo = new UserModelRepository(db);

    assert.equal(repo.hasEntries(), false);
    repo.upsert('role', 'developer', 'senior');
    assert.equal(repo.hasEntries(), true);
    db.close();
  });
});

describe('Structured Profile Detection', () => {
  it('should extract role from "I\'m a senior developer"', () => {
    const signal = detectUserProfile("I'm a senior TypeScript developer");
    assert.ok(signal, 'should detect profile');
    assert.ok(signal!.dimensions, 'should have dimensions');
    assert.ok(signal!.dimensions!.some(d => d.dimension === 'role' && d.key.includes('developer')));
    assert.ok(signal!.dimensions!.some(d => d.dimension === 'expertise' && d.key === 'typescript'));
  });

  it('should extract expertise from tech mentions', () => {
    const signal = detectUserProfile("I'm a Python and React developer");
    assert.ok(signal);
    assert.ok(signal!.dimensions);
    const expertiseDims = signal!.dimensions!.filter(d => d.dimension === 'expertise');
    assert.ok(expertiseDims.some(d => d.key === 'python'));
    assert.ok(expertiseDims.some(d => d.key === 'react'));
  });

  it('should extract "new to" as beginner expertise', () => {
    const signal = detectUserProfile("I'm new to Rust programming and systems design");
    assert.ok(signal);
    assert.ok(signal!.dimensions);
    assert.ok(signal!.dimensions!.some(d => d.dimension === 'expertise' && d.value === 'beginner'));
  });

  it('should still return content for backward compat', () => {
    const signal = detectUserProfile("I'm a senior developer at a startup");
    assert.ok(signal);
    assert.ok(signal!.content.length > 0, 'should have free-text content');
  });

  it('should return no dimensions for task-oriented messages', () => {
    const signal = detectUserProfile("I'm getting an error with the build");
    assert.equal(signal, null);
  });
});

describe('Briefing: Structured User Model Rendering', () => {
  it('should render structured profile as one-line when available', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    const memRepo = new MemoryRepository(db);
    const planRepo = new PlanRepository(db);

    const ctx: BriefingContext = {
      project: 'tp',
      sessionType: 'startup',
      interrupted: false,
      structuredUserProfile: 'senior developer, typescript (expert), quality_over_speed',
    };
    const result = compileBriefing(memRepo, planRepo, ctx);
    assert.ok(result.text.includes('User: senior developer'), 'should render structured profile');
    assert.ok(!result.text.includes('  - '), 'should not use list format for structured');
    db.close();
  });

  it('should fall back to free-text when no structured profile', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    const memRepo = new MemoryRepository(db);
    const planRepo = new PlanRepository(db);

    // Create a free-text user_profile memory
    memRepo.create({ content: 'Prefers detailed explanations', kind: 'user_profile', project: null });

    const ctx: BriefingContext = {
      project: 'tp',
      sessionType: 'startup',
      interrupted: false,
      // No structuredUserProfile
    };
    const result = compileBriefing(memRepo, planRepo, ctx);
    assert.ok(result.text.includes('Prefers detailed explanations'), 'should fall back to free-text');
    db.close();
  });

  it('should prefer structured profile over free-text when both exist', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    const memRepo = new MemoryRepository(db);
    const planRepo = new PlanRepository(db);

    memRepo.create({ content: 'Old free-text profile entry', kind: 'user_profile', project: null });

    const ctx: BriefingContext = {
      project: 'tp',
      sessionType: 'startup',
      interrupted: false,
      structuredUserProfile: 'senior developer, typescript expert',
    };
    const result = compileBriefing(memRepo, planRepo, ctx);
    assert.ok(result.text.includes('User: senior developer'), 'should use structured');
    assert.ok(!result.text.includes('Old free-text'), 'should not show free-text when structured exists');
    db.close();
  });
});
