import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type Database from 'better-sqlite3';
import { openDatabase } from '../src/db/connection.js';
import { ReminderRepository } from '../src/db/reminder-repository.js';

let db: Database.Database;
let repo: ReminderRepository;

beforeEach(() => {
  db = openDatabase({ dbPath: ':memory:' });
  repo = new ReminderRepository(db);
});

afterEach(() => {
  db.close();
});

describe('Reminder List', () => {
  it('should list active reminders', () => {
    repo.create({ trigger: 'deployment', action: 'check staging first', project: 'proj-a' });
    repo.create({ trigger: 'database migration', action: 'backup before migrate', project: 'proj-a' });

    const list = repo.listActive('proj-a');
    assert.equal(list.length, 2);
    assert.ok(list.some(r => r.trigger_pattern.includes('deployment')));
    assert.ok(list.some(r => r.trigger_pattern.includes('database migration')));
  });

  it('should return empty list when no reminders exist', () => {
    const list = repo.listActive('proj-a');
    assert.equal(list.length, 0);
  });

  it('should include global reminders in project list', () => {
    repo.create({ trigger: 'security review', action: 'check OWASP top 10', project: null });
    repo.create({ trigger: 'code review', action: 'check style', project: 'proj-a' });

    const list = repo.listActive('proj-a');
    assert.equal(list.length, 2);
  });

  it('should not list deactivated reminders', () => {
    const result = repo.create({ trigger: 'test trigger', action: 'test action', project: 'proj-a' });
    assert.ok(!('error' in result));
    repo.deactivate(result.id);

    const list = repo.listActive('proj-a');
    assert.equal(list.length, 0);
  });
});

describe('Reminder Delete', () => {
  it('should deactivate a reminder', () => {
    const result = repo.create({ trigger: 'deploy', action: 'check logs', project: 'proj-a' });
    assert.ok(!('error' in result));

    const ok = repo.deactivate(result.id);
    assert.equal(ok, true);

    // Should not appear in active list
    const list = repo.listActive('proj-a');
    assert.equal(list.length, 0);
  });

  it('should permanently delete a reminder', () => {
    const result = repo.create({ trigger: 'deploy', action: 'check logs', project: 'proj-a' });
    assert.ok(!('error' in result));

    const ok = repo.delete(result.id);
    assert.equal(ok, true);

    // Should be gone entirely
    const list = repo.listActive('proj-a');
    assert.equal(list.length, 0);
  });

  it('should return false for non-existent ID on deactivate', () => {
    const ok = repo.deactivate('nonexistent-id');
    assert.equal(ok, false);
  });

  it('should return false for non-existent ID on delete', () => {
    const ok = repo.delete('nonexistent-id');
    assert.equal(ok, false);
  });
});
