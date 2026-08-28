/**
 * Tier 3 Platform tests — rich reminders, new hooks, MCP enhancements, agent teams.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db/connection.js';
import { SCHEMA_VERSION } from '../src/db/schema.js';
import { ReminderRepository } from '../src/db/reminder-repository.js';
import { PlanRepository } from '../src/db/plan-repository.js';
import { extractAssistantDecision } from '../src/hooks/shared/transcript-parser.js';
import type Database from 'better-sqlite3';

let db: Database.Database;
let reminderRepo: ReminderRepository;
let planRepo: PlanRepository;
beforeEach(() => {
  db = openDatabase({ dbPath: ':memory:' });
  reminderRepo = new ReminderRepository(db);
  planRepo = new PlanRepository(db);
});

afterEach(() => {
  db.close();
});

// --- Schema v12 -----------------------------------------------------------

describe('Schema v12', () => {
  it('should have trigger_type column on reminders', () => {
    const columns = db.prepare("PRAGMA table_info(reminders)").all() as Array<{ name: string }>;
    assert.ok(columns.some(c => c.name === 'trigger_type'), 'should have trigger_type');
  });

  it('should have trigger_config column on reminders', () => {
    const columns = db.prepare("PRAGMA table_info(reminders)").all() as Array<{ name: string }>;
    assert.ok(columns.some(c => c.name === 'trigger_config'), 'should have trigger_config');
  });

  it('should store current schema version', () => {
    const row = db.prepare('SELECT version FROM schema_version').get() as { version: number };
    assert.equal(row.version, SCHEMA_VERSION);
  });
});

// --- Rich Reminders -------------------------------------------------------

describe('Rich Reminders — Prompt Type (Backward Compat)', () => {
  it('should create prompt-type reminders by default', () => {
    const result = reminderRepo.create({ trigger: 'authentication', action: 'check token expiry' });
    assert.ok('id' in result);

    const reminders = reminderRepo.listActive(null);
    assert.equal(reminders.length, 1);
    assert.equal(reminders[0].trigger_type, 'prompt');
    assert.equal(reminders[0].trigger_config, null);
  });

  it('should fire prompt reminders via FTS match', () => {
    reminderRepo.create({ trigger: 'database migration', action: 'run migration check first' });

    const fired = reminderRepo.checkAndFire('need to do a database migration', null);
    assert.equal(fired.length, 1);
    assert.ok(fired[0].action.includes('migration check'));
  });
});

describe('Rich Reminders — File Triggers', () => {
  it('should create file-triggered reminders', () => {
    const result = reminderRepo.create({
      trigger: 'auth handler',
      action: 'check token expiry edge case',
      trigger_type: 'file',
      trigger_config: { filePaths: ['src/auth/handler.ts'] },
    });
    assert.ok('id' in result);

    const reminders = reminderRepo.listActive(null);
    assert.equal(reminders[0].trigger_type, 'file');
    assert.deepEqual(reminders[0].trigger_config?.filePaths, ['src/auth/handler.ts']);
  });

  it('should fire file reminders when matching file path', () => {
    reminderRepo.create({
      trigger: 'auth handler',
      action: 'check token refresh logic',
      trigger_type: 'file',
      trigger_config: { filePaths: ['src/auth/handler.ts'] },
    });

    const fired = reminderRepo.checkFileReminders('src/auth/handler.ts', null);
    assert.equal(fired.length, 1);
    assert.ok(fired[0].action.includes('token refresh'));
  });

  it('should match file reminders by basename', () => {
    reminderRepo.create({
      trigger: 'handler check',
      action: 'review error handling paths',
      trigger_type: 'file',
      trigger_config: { filePaths: ['src/deep/handler.ts'] },
    });

    const fired = reminderRepo.checkFileReminders('handler.ts', null);
    assert.equal(fired.length, 1);
  });

  it('should not fire file reminders for unmatched paths', () => {
    reminderRepo.create({
      trigger: 'specific file',
      action: 'do something specific',
      trigger_type: 'file',
      trigger_config: { filePaths: ['src/auth/handler.ts'] },
    });

    const fired = reminderRepo.checkFileReminders('src/utils/helper.ts', null);
    assert.equal(fired.length, 0);
  });

  it('should increment fire count and deactivate at max', () => {
    reminderRepo.create({
      trigger: 'one-shot file',
      action: 'remind once only',
      trigger_type: 'file',
      trigger_config: { filePaths: ['target.ts'] },
      max_fires: 1,
    });

    const first = reminderRepo.checkFileReminders('target.ts', null);
    assert.equal(first.length, 1);

    const second = reminderRepo.checkFileReminders('target.ts', null);
    assert.equal(second.length, 0, 'should be deactivated after max fires');
  });
});

describe('Rich Reminders — Time Triggers', () => {
  it('should create time-triggered reminders', () => {
    const futureDate = new Date(Date.now() + 86400000).toISOString();
    const result = reminderRepo.create({
      trigger: 'weekly review',
      action: 'check CI results',
      trigger_type: 'time',
      trigger_config: { nextDue: futureDate },
    });
    assert.ok('id' in result);
  });

  it('should fire time reminders when due', () => {
    const pastDate = new Date(Date.now() - 3600000).toISOString(); // 1 hour ago
    reminderRepo.create({
      trigger: 'overdue task',
      action: 'complete the deployment verification',
      trigger_type: 'time',
      trigger_config: { nextDue: pastDate },
    });

    const fired = reminderRepo.checkTimeReminders(null);
    assert.equal(fired.length, 1);
    assert.ok(fired[0].action.includes('deployment'));
  });

  it('should not fire time reminders before due date', () => {
    const futureDate = new Date(Date.now() + 86400000).toISOString(); // tomorrow
    reminderRepo.create({
      trigger: 'future task',
      action: 'not yet due',
      trigger_type: 'time',
      trigger_config: { nextDue: futureDate },
    });

    const fired = reminderRepo.checkTimeReminders(null);
    assert.equal(fired.length, 0);
  });
});

// --- Stop Hook Decision Mining (Unit) --------------------------------------

describe('Stop Hook — Decision Extraction', () => {
  it('should extract decisions from assistant text', () => {
    const text = "I'll use parameterized queries because they prevent SQL injection and are the standard approach.";
    const decision = extractAssistantDecision(text);
    assert.ok(decision, 'should extract a decision');
    assert.ok(decision.toLowerCase().includes('parameterized'), 'should contain the choice');
  });

  it('should return null for non-decision text', () => {
    const text = 'Here is the file content you requested. The function looks correct.';
    const decision = extractAssistantDecision(text);
    assert.equal(decision, null, 'should not find decisions in informational text');
  });
});

// --- Optimistic Plan Step Locking ------------------------------------------

describe('Optimistic Plan Step Locking', () => {
  let planId: string;

  beforeEach(() => {
    const result = planRepo.create({
      project: 'test-project',
      name: 'Test Plan',
      steps: [
        { description: 'Step 1' },
        { description: 'Step 2' },
        { description: 'Step 3' },
      ],
    });
    planId = result.plan.id;
  });

  it('should claim a pending step successfully', () => {
    const result = planRepo.updateStep(planId, { step_id: 1, status: 'in_progress' });
    assert.ok(result.ok, 'should successfully claim pending step');
  });

  it('should reject claiming an already in-progress step', () => {
    // First claim succeeds
    planRepo.updateStep(planId, { step_id: 1, status: 'in_progress' });

    // Second claim should fail (optimistic lock)
    const result = planRepo.updateStep(planId, { step_id: 1, status: 'in_progress' });
    assert.ok(!result.ok, 'should reject second claim');
    assert.ok(result.warnings.some(w => w.includes('already claimed')), 'should warn about claim conflict');
  });

  it('should allow transitioning in_progress to done', () => {
    planRepo.updateStep(planId, { step_id: 1, status: 'in_progress' });
    const result = planRepo.updateStep(planId, { step_id: 1, status: 'done' });
    assert.ok(result.ok, 'should allow done transition');
  });

  it('should allow transitioning in_progress to blocked', () => {
    planRepo.updateStep(planId, { step_id: 1, status: 'in_progress' });
    const result = planRepo.updateStep(planId, { step_id: 1, status: 'blocked', blockers: 'waiting on review' });
    assert.ok(result.ok, 'should allow blocked transition');
  });
});

// --- Per-Session Edit Tracker -----------------------------------------------

describe('Per-Session Edit Tracker', () => {
  it('should support sessionId parameter in load/save', async () => {
    // Just verify the functions accept the parameter without error
    const { loadTracker } = await import('../src/hooks/shared/edit-tracker.js');
    const tracker = loadTracker('test-session-abc-123');
    assert.ok(tracker, 'should load default tracker for session');
    assert.equal(tracker.lastEditPath, null);
    // Don't actually save to disk in tests — just verify the API accepts it
  });

  it('should isolate tracker paths by sessionId', async () => {
    const { getTrackerPath } = await import('../src/hooks/shared/edit-tracker.js');
    const path1 = getTrackerPath('session-aaa');
    const path2 = getTrackerPath('session-bbb');
    const pathDefault = getTrackerPath();
    assert.notEqual(path1, path2, 'different sessions should have different paths');
    assert.notEqual(path1, pathDefault, 'session path should differ from default');
    assert.ok(path1.includes('session-aaa'), 'path should contain session_id');
  });
});
