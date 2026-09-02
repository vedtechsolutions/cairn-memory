import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type Database from 'better-sqlite3';
import { openDatabase } from '../src/db/connection.js';
import { MemoryRepository } from '../src/db/memory-repository.js';
import { ReminderRepository } from '../src/db/reminder-repository.js';
import { CONFIDENCE } from '../src/constants/index.js';

let db: Database.Database;
let memRepo: MemoryRepository;
let reminderRepo: ReminderRepository;

beforeEach(() => {
  db = openDatabase({ dbPath: ':memory:' });
  memRepo = new MemoryRepository(db);
  reminderRepo = new ReminderRepository(db);
});

afterEach(() => {
  db.close();
});

// =============================================================================
// 6.2 Strengthen / Weaken
// =============================================================================

describe('Strengthen Confidence', () => {
  it('should increase confidence by STRENGTHEN_INCREMENT (pitfalls floor at DELIBERATE)', () => {
    // Step-3 review fold: strengthen is explicit validation, so a pitfall
    // never lands below (or ON) the injection gate — 0.5 + 0.1 would be
    // 0.6, but pitfalls floor at CONFIDENCE.DELIBERATE (0.7).
    const { id } = memRepo.create({ content: 'Test pitfall for strengthening', kind: 'pitfall', confidence: 0.5 });
    const ok = memRepo.strengthenConfidence(id);
    assert.equal(ok, true);
    const mem = memRepo.findById(id)!;
    assert.ok(Math.abs(mem.confidence - 0.7) < 0.001, `pitfall floors at DELIBERATE, got ${mem.confidence}`);

    // The plain increment still governs non-pitfall kinds.
    const fact = memRepo.create({ content: 'Test fact for strengthening', kind: 'fact', confidence: 0.5 });
    memRepo.strengthenConfidence(fact.id);
    assert.ok(Math.abs(memRepo.findById(fact.id)!.confidence - 0.6) < 0.001);
  });

  it('should cap at 1.0', () => {
    const { id } = memRepo.create({ content: 'Already high confidence memory', kind: 'pitfall', confidence: 0.95 });
    memRepo.strengthenConfidence(id);
    const mem = memRepo.findById(id)!;
    assert.ok(mem.confidence <= 1.0);
  });

  it('should return false for non-existent ID', () => {
    const ok = memRepo.strengthenConfidence('nonexistent-id');
    assert.equal(ok, false);
  });

  it('should return false for invalidated memory', () => {
    const { id } = memRepo.create({ content: 'Will be invalidated', kind: 'pitfall' });
    memRepo.invalidate(id);
    const ok = memRepo.strengthenConfidence(id);
    assert.equal(ok, false);
  });
});

describe('Weaken Confidence', () => {
  it('should reduce confidence by WEAKEN_FACTOR (0.85)', () => {
    const { id } = memRepo.create({ content: 'Test pitfall for weakening', kind: 'pitfall', confidence: 0.6 });
    const result = memRepo.weakenConfidence(id);
    assert.equal(result.weakened, true);
    assert.equal(result.invalidated, false);

    const mem = memRepo.findById(id)!;
    assert.ok(Math.abs(mem.confidence - (0.6 * CONFIDENCE.WEAKEN_FACTOR)) < 0.001);
  });

  it('should auto-invalidate when confidence drops below DELETE_THRESHOLD', () => {
    // Start at 0.11, weaken: 0.11 * 0.85 = 0.0935 < 0.1 threshold
    const { id } = memRepo.create({ content: 'Very low confidence memory', kind: 'pitfall', confidence: 0.11 });
    const result = memRepo.weakenConfidence(id);
    assert.equal(result.weakened, true);
    assert.equal(result.invalidated, true);

    const mem = memRepo.findById(id)!;
    assert.equal(mem.invalidated, 1);
  });

  it('should return weakened=false for non-existent ID', () => {
    const result = memRepo.weakenConfidence('nonexistent-id');
    assert.equal(result.weakened, false);
    assert.equal(result.invalidated, false);
  });

  it('should return weakened=false for invalidated memory', () => {
    const { id } = memRepo.create({ content: 'Already invalidated', kind: 'pitfall' });
    memRepo.invalidate(id);
    const result = memRepo.weakenConfidence(id);
    assert.equal(result.weakened, false);
  });

  it('should kill a pitfall after repeated weakening', () => {
    // Start at 0.6, weaken repeatedly: 0.6 * 0.85^N
    // After 12: 0.6 * 0.85^12 ≈ 0.085 < 0.1 → invalidated
    const { id } = memRepo.create({ content: 'Will die from weakening', kind: 'pitfall', confidence: 0.6 });

    let invalidated = false;
    for (let i = 0; i < 20; i++) {
      const result = memRepo.weakenConfidence(id);
      if (result.invalidated) {
        invalidated = true;
        break;
      }
      if (!result.weakened) break; // Already invalidated on previous call
    }

    assert.equal(invalidated, true);
    const mem = memRepo.findById(id)!;
    assert.equal(mem.invalidated, 1);
  });
});

// =============================================================================
// 6.3 Prospective Memory (Reminders)
// =============================================================================

describe('Reminder Repository — Create', () => {
  it('should create a reminder and return its ID', () => {
    const result = reminderRepo.create({
      trigger: 'payment module stripe webhook',
      action: 'Check API version — v2 endpoint changed',
      project: 'test-proj',
    });
    assert.ok(!('error' in result));
    assert.ok('id' in result && result.id);
  });

  it('should reject empty trigger', () => {
    const result = reminderRepo.create({ trigger: '', action: 'test' });
    assert.ok('error' in result);
  });

  it('should reject empty action', () => {
    const result = reminderRepo.create({ trigger: 'test', action: '' });
    assert.ok('error' in result);
  });

  it('should enforce 20 active reminder limit', () => {
    for (let i = 0; i < 20; i++) {
      const r = reminderRepo.create({ trigger: `trigger ${i} unique words here`, action: `action ${i}` });
      assert.ok(!('error' in r), `Failed to create reminder ${i}`);
    }

    const result = reminderRepo.create({ trigger: 'one more trigger', action: 'one more action' });
    assert.ok('error' in result);
    assert.ok(result.error.includes('limit'));
  });

  it('should default max_fires to 0 (unlimited)', () => {
    const result = reminderRepo.create({ trigger: 'test trigger words', action: 'test action' });
    assert.ok(!('error' in result));

    const list = reminderRepo.listActive();
    const reminder = list.find(r => r.id === result.id);
    assert.ok(reminder);
    assert.equal(reminder.max_fires, 0);
  });
});

describe('Reminder Repository — Check and Fire', () => {
  it('should fire when prompt matches trigger keywords', () => {
    reminderRepo.create({
      trigger: 'payment stripe webhook',
      action: 'Check API version v2',
      project: 'test-proj',
    });

    const fired = reminderRepo.checkAndFire('working on the payment stripe webhook handler', 'test-proj');
    assert.ok(fired.length > 0);
    assert.ok(fired[0].action.includes('Check API version'));
  });

  it('should not fire for non-matching prompt', () => {
    reminderRepo.create({
      trigger: 'payment stripe webhook',
      action: 'Check API version v2',
      project: 'test-proj',
    });

    const fired = reminderRepo.checkAndFire('fix the database migration script', 'test-proj');
    assert.equal(fired.length, 0);
  });

  it('should increment fire_count on match', () => {
    const result = reminderRepo.create({
      trigger: 'deployment kubernetes cluster',
      action: 'Remember to update ConfigMap',
      project: 'test-proj',
    });
    assert.ok(!('error' in result));

    reminderRepo.checkAndFire('deploy to kubernetes cluster now', 'test-proj');

    const list = reminderRepo.listActive();
    const reminder = list.find(r => r.id === result.id);
    assert.ok(reminder);
    assert.equal(reminder.fire_count, 1);
  });

  it('should deactivate when fire_count reaches max_fires', () => {
    const result = reminderRepo.create({
      trigger: 'temporary migration script',
      action: 'Remove after migration completes',
      project: 'test-proj',
      max_fires: 2,
    });
    assert.ok(!('error' in result));

    reminderRepo.checkAndFire('run the temporary migration script', 'test-proj');
    reminderRepo.checkAndFire('check the temporary migration script output', 'test-proj');

    // Should now be deactivated
    const list = reminderRepo.listActive();
    const reminder = list.find(r => r.id === result.id);
    assert.ok(!reminder, 'Should be deactivated after max_fires');
  });

  it('should not fire inactive reminders', () => {
    const result = reminderRepo.create({
      trigger: 'inactive test trigger words',
      action: 'Should not fire',
      project: 'test-proj',
    });
    assert.ok(!('error' in result));

    reminderRepo.deactivate(result.id);

    const fired = reminderRepo.checkAndFire('inactive test trigger words prompt', 'test-proj');
    assert.equal(fired.length, 0);
  });

  it('should respect project scoping', () => {
    reminderRepo.create({
      trigger: 'scoped test trigger keywords',
      action: 'Project-scoped reminder',
      project: 'proj-a',
    });

    // Should fire for matching project
    const firedA = reminderRepo.checkAndFire('scoped test trigger keywords here', 'proj-a');
    assert.ok(firedA.length > 0);

    // Should not fire for different project
    const firedB = reminderRepo.checkAndFire('scoped test trigger keywords here', 'proj-b');
    assert.equal(firedB.length, 0);
  });

  it('should fire global reminders for any project', () => {
    reminderRepo.create({
      trigger: 'global reminder test keywords',
      action: 'Global scope reminder',
      project: null,
    });

    const fired = reminderRepo.checkAndFire('global reminder test keywords prompt', 'any-project');
    assert.ok(fired.length > 0);
  });

  it('max_fires 0 should never auto-deactivate', () => {
    const result = reminderRepo.create({
      trigger: 'unlimited fires test trigger',
      action: 'Unlimited reminder',
      max_fires: 0,
    });
    assert.ok(!('error' in result));

    for (let i = 0; i < 10; i++) {
      reminderRepo.checkAndFire('unlimited fires test trigger prompt', null);
    }

    const list = reminderRepo.listActive();
    const reminder = list.find(r => r.id === result.id);
    assert.ok(reminder, 'Should still be active after 10 fires');
    assert.equal(reminder.fire_count, 10);
  });
});

describe('Reminder Repository — Deactivate & Delete', () => {
  it('should deactivate a reminder', () => {
    const result = reminderRepo.create({ trigger: 'deactivate test words', action: 'test' });
    assert.ok(!('error' in result));

    const ok = reminderRepo.deactivate(result.id);
    assert.equal(ok, true);

    const list = reminderRepo.listActive();
    assert.ok(!list.find(r => r.id === result.id));
  });

  it('should delete a reminder', () => {
    const result = reminderRepo.create({ trigger: 'delete test words', action: 'test' });
    assert.ok(!('error' in result));

    const ok = reminderRepo.delete(result.id);
    assert.equal(ok, true);
  });

  it('should return false for non-existent deactivate', () => {
    assert.equal(reminderRepo.deactivate('nonexistent'), false);
  });
});
