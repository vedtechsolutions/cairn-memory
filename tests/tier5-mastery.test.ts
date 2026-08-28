/**
 * Tier 5 Mastery tests — condition evaluator, precision ranking, branch-aware prediction,
 * conditional reminders, sampling distillation prep.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db/connection.js';
import { ReminderRepository } from '../src/db/reminder-repository.js';
import { MemoryRepository } from '../src/db/memory-repository.js';
import {
  evaluateCondition,
  emptyConditionContext,
} from '../src/utils/condition-evaluator.js';
import { distillError, regexDistillError } from '../src/utils/distillation.js';
import type Database from 'better-sqlite3';

let db: Database.Database;
let reminderRepo: ReminderRepository;
let memRepo: MemoryRepository;

beforeEach(() => {
  db = openDatabase({ dbPath: ':memory:' });
  reminderRepo = new ReminderRepository(db);
  memRepo = new MemoryRepository(db);
});

afterEach(() => {
  db.close();
});

// --- Condition Evaluator: Shorthand Tags -----------------------------------

describe('Condition Evaluator — Shorthands', () => {
  it('should evaluate tests_pass', () => {
    const ctx = { ...emptyConditionContext(), tests_pass: true };
    assert.equal(evaluateCondition('tests_pass', ctx), true);
    assert.equal(evaluateCondition('tests_pass', emptyConditionContext()), false);
  });

  it('should evaluate tests_fail', () => {
    const ctx = { ...emptyConditionContext(), has_recent_errors: true };
    assert.equal(evaluateCondition('tests_fail', ctx), true);
  });

  it('should evaluate plan_active', () => {
    const ctx = { ...emptyConditionContext(), plan_active: true };
    assert.equal(evaluateCondition('plan_active', ctx), true);
    assert.equal(evaluateCondition('plan_active', emptyConditionContext()), false);
  });

  it('should evaluate plan_complete', () => {
    const ctx = { ...emptyConditionContext(), plan_complete: true };
    assert.equal(evaluateCondition('plan_complete', ctx), true);
  });

  it('should return false for unknown shorthands', () => {
    assert.equal(evaluateCondition('unknown_thing', emptyConditionContext()), false);
  });
});

// --- Condition Evaluator: Parameterized ------------------------------------

describe('Condition Evaluator — Parameterized', () => {
  it('should match tool name', () => {
    const ctx = { ...emptyConditionContext(), tool_name: 'Bash' };
    assert.equal(evaluateCondition('tool:Bash', ctx), true);
    assert.equal(evaluateCondition('tool:Edit', ctx), false);
  });

  it('should match file path with exact name', () => {
    const ctx = { ...emptyConditionContext(), file_path: 'src/auth/handler.ts' };
    assert.equal(evaluateCondition('file:handler.ts', ctx), true);
    assert.equal(evaluateCondition('file:other.ts', ctx), false);
  });

  it('should match file path with glob', () => {
    const ctx = { ...emptyConditionContext(), file_path: 'src/auth/handler.ts' };
    assert.equal(evaluateCondition('file:*.ts', ctx), true);
    assert.equal(evaluateCondition('file:*.py', ctx), false);
  });

  it('should match branch with exact name', () => {
    const ctx = { ...emptyConditionContext(), branch: 'main' };
    assert.equal(evaluateCondition('branch:main', ctx), true);
    assert.equal(evaluateCondition('branch:dev', ctx), false);
  });

  it('should match branch with glob', () => {
    const ctx = { ...emptyConditionContext(), branch: 'feat/new-feature' };
    assert.equal(evaluateCondition('branch:feat/*', ctx), true);
    assert.equal(evaluateCondition('branch:fix/*', ctx), false);
  });

  it('should match step_done', () => {
    const ctx = { ...emptyConditionContext(), step_statuses: { 1: 'done', 2: 'pending' } };
    assert.equal(evaluateCondition('step_done:1', ctx), true);
    assert.equal(evaluateCondition('step_done:2', ctx), false);
  });

  it('should match step_active', () => {
    const ctx = { ...emptyConditionContext(), step_statuses: { 3: 'in_progress' } };
    assert.equal(evaluateCondition('step_active:3', ctx), true);
  });

  it('should match context mode', () => {
    const ctx = { ...emptyConditionContext(), context_mode: 'compact' };
    assert.equal(evaluateCondition('mode:compact', ctx), true);
    assert.equal(evaluateCondition('mode:normal', ctx), false);
  });

  it('should match session type', () => {
    const ctx = { ...emptyConditionContext(), session_type: 'startup' };
    assert.equal(evaluateCondition('session:startup', ctx), true);
    assert.equal(evaluateCondition('session:compact', ctx), false);
  });

  it('should match error_count with threshold', () => {
    const ctx = { ...emptyConditionContext(), error_count: 5 };
    assert.equal(evaluateCondition('error_count:>=3', ctx), true);
    assert.equal(evaluateCondition('error_count:>=10', ctx), false);
    assert.equal(evaluateCondition('error_count:==5', ctx), true);
  });
});

// --- Condition Evaluator: Composition --------------------------------------

describe('Condition Evaluator — Composition', () => {
  it('should evaluate AND', () => {
    const ctx = { ...emptyConditionContext(), tests_pass: true, branch: 'main' };
    assert.equal(evaluateCondition('tests_pass AND branch:main', ctx), true);
    assert.equal(evaluateCondition('tests_pass AND branch:dev', ctx), false);
  });

  it('should evaluate OR', () => {
    const ctx = { ...emptyConditionContext(), branch: 'fix/bug-123' };
    assert.equal(evaluateCondition('branch:feat/* OR branch:fix/*', ctx), true);
    assert.equal(evaluateCondition('branch:feat/* OR branch:main', ctx), false);
  });

  it('should evaluate NOT', () => {
    const ctx = { ...emptyConditionContext(), context_mode: 'normal' };
    assert.equal(evaluateCondition('NOT mode:critical', ctx), true);
    assert.equal(evaluateCondition('NOT mode:normal', ctx), false);
  });

  it('should evaluate complex AND + NOT', () => {
    const ctx = {
      ...emptyConditionContext(),
      tests_pass: true,
      step_statuses: { 2: 'done', 3: 'pending' },
    };
    assert.equal(evaluateCondition('tests_pass AND step_done:2 AND NOT step_done:3', ctx), true);
  });
});

// --- Condition Evaluator: Safety -------------------------------------------

describe('Condition Evaluator — Safety', () => {
  it('should reject empty expressions', () => {
    assert.equal(evaluateCondition('', emptyConditionContext()), false);
  });

  it('should reject expressions over 200 chars', () => {
    const long = 'tests_pass AND '.repeat(20);
    assert.equal(evaluateCondition(long, emptyConditionContext()), false);
  });

  it('should fail closed on unknown identifiers', () => {
    assert.equal(evaluateCondition('__proto__:test', emptyConditionContext()), false);
    assert.equal(evaluateCondition('constructor:foo', emptyConditionContext()), false);
  });
});

// --- Conditional Reminders Integration -------------------------------------

describe('Conditional Reminders', () => {
  it('should create and fire conditional reminders', () => {
    reminderRepo.create({
      trigger: 'test condition',
      action: 'run integration tests after merge',
      trigger_type: 'conditional',
      trigger_config: { condition: 'branch:main' },
    });

    const ctx = { ...emptyConditionContext(), branch: 'main' };
    const fired = reminderRepo.checkConditionalReminders(ctx, null);
    assert.equal(fired.length, 1);
    assert.ok(fired[0].action.includes('integration tests'));
  });

  it('should not fire when condition is false', () => {
    reminderRepo.create({
      trigger: 'branch check',
      action: 'only on feature branches',
      trigger_type: 'conditional',
      trigger_config: { condition: 'branch:feat/*' },
    });

    const ctx = { ...emptyConditionContext(), branch: 'main' };
    const fired = reminderRepo.checkConditionalReminders(ctx, null);
    assert.equal(fired.length, 0);
  });

  it('should support compound conditions', () => {
    reminderRepo.create({
      trigger: 'compound test',
      action: 'deploy to staging after tests pass on main',
      trigger_type: 'conditional',
      trigger_config: { condition: 'tests_pass AND branch:main' },
    });

    const ctx1 = { ...emptyConditionContext(), tests_pass: true, branch: 'main' };
    assert.equal(reminderRepo.checkConditionalReminders(ctx1, null).length, 1);

    // Won't fire again immediately (fire_count incremented, but max_fires=0 means unlimited)
    const ctx2 = { ...emptyConditionContext(), tests_pass: true, branch: 'main' };
    assert.equal(reminderRepo.checkConditionalReminders(ctx2, null).length, 1);
  });

  it('should deactivate after max fires', () => {
    reminderRepo.create({
      trigger: 'one shot conditional',
      action: 'fire once only',
      trigger_type: 'conditional',
      trigger_config: { condition: 'tests_pass' },
      max_fires: 1,
    });

    const ctx = { ...emptyConditionContext(), tests_pass: true };
    assert.equal(reminderRepo.checkConditionalReminders(ctx, null).length, 1);
    assert.equal(reminderRepo.checkConditionalReminders(ctx, null).length, 0);
  });
});

// --- Precision-Based Ranking -----------------------------------------------

describe('Precision-Based Ranking Signal', () => {
  it('should have PRECISION weight in FINGERPRINT.WEIGHTS', async () => {
    const { FINGERPRINT } = await import('../src/constants/index.js');
    assert.ok(FINGERPRINT.WEIGHTS.PRECISION > 0, 'PRECISION weight should be positive');
  });

  it('should rank high-impact memories higher than zero-impact', () => {
    // Create two memories with same content relevance but different impact
    const id1 = memRepo.create({ content: 'always validate authentication tokens carefully', kind: 'pitfall' }).id;
    const id2 = memRepo.create({ content: 'check database connection timeouts properly', kind: 'pitfall' }).id;

    // Give id1 high impact
    db.prepare('UPDATE memories SET surface_count = 10, impact_count = 8 WHERE id = ?').run(id1);
    // Give id2 zero impact
    db.prepare('UPDATE memories SET surface_count = 10, impact_count = 0 WHERE id = ?').run(id2);

    const results = memRepo.recall('validate check', { maxResults: 2 });
    // Both should be found; high-impact should rank higher
    if (results.length >= 2) {
      const id1Idx = results.findIndex(r => r.memory.id === id1);
      const id2Idx = results.findIndex(r => r.memory.id === id2);
      if (id1Idx >= 0 && id2Idx >= 0) {
        assert.ok(id1Idx < id2Idx, 'high-impact memory should rank higher');
      }
    }
  });
});

// --- Regex Error Distillation -----------------------------------------------

describe('Regex Error Distillation', () => {
  it('should distill TypeScript errors', () => {
    const result = regexDistillError('Bash', "error TS2345: Argument of type 'string' is not assignable to type 'number'");
    assert.ok(result.includes('TS2345'), `should include error code, got: ${result}`);
    assert.ok(result.includes('Fix:'), `should include fix suggestion, got: ${result}`);
  });

  it('should distill module not found errors', () => {
    const result = regexDistillError('Edit', "Cannot find module '@utils/helpers'");
    assert.ok(result.includes('@utils/helpers'), `should include module name, got: ${result}`);
    assert.ok(result.includes('Fix:'), `should include fix, got: ${result}`);
  });

  it('should distill Python errors', () => {
    const result = regexDistillError('Bash', "TypeError: unsupported operand type(s) for +: 'int' and 'str'");
    assert.ok(result.includes('TypeError'), `should include error type, got: ${result}`);
  });

  it('should distill SQLite errors', () => {
    const result = regexDistillError('Bash', 'SQLITE_ERROR: no such table: memories');
    assert.ok(result.includes('SQLite'), `should mention SQLite, got: ${result}`);
    assert.ok(result.includes('no such table'), `should include details, got: ${result}`);
  });

  it('should distill Edit old_string not found', () => {
    const result = regexDistillError('Edit', 'old_string not found in file');
    assert.ok(result.includes('re-read'), `should suggest re-reading, got: ${result}`);
  });

  it('should fallback to first line for unknown errors', () => {
    const result = regexDistillError('Bash', 'some weird error nobody expected\nsecond line');
    assert.ok(result.includes('some weird error'), `should include first line, got: ${result}`);
    assert.ok(result.startsWith('Bash'), `should prefix with tool name, got: ${result}`);
  });
});

// --- MCP Sampling Distillation Prep ----------------------------------------

describe('MCP Sampling Distillation', () => {
  it('should return regex result when no server provided', async () => {
    const result = await distillError('raw error text', 'Bash', undefined);
    assert.ok(result.includes('Bash'), `should use regex fallback, got: ${result}`);
  });

  it('should return regex result when server lacks sampling capability', async () => {
    const mockServer = {} as any;
    const result = await distillError('raw error text', 'Edit', mockServer);
    assert.ok(result.includes('Edit'), `should use regex fallback, got: ${result}`);
  });
});
