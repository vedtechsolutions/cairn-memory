import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type Database from 'better-sqlite3';
import { openDatabase } from '../src/db/connection.js';
import { SCHEMA_VERSION } from '../src/db/schema.js';

let db: Database.Database;

beforeEach(() => {
  db = openDatabase({ dbPath: ':memory:' });
});

afterEach(() => {
  db.close();
});

describe('Database Schema', () => {
  it('should create all required tables', () => {
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all() as Array<{ name: string }>;

    const tableNames = tables.map(t => t.name).filter(n => !n.startsWith('memories_fts') && !n.startsWith('reminders_fts'));
    assert.ok(tableNames.includes('memories'), 'memories table exists');
    assert.ok(tableNames.includes('sessions'), 'sessions table exists');
    assert.ok(tableNames.includes('plans'), 'plans table exists');
    assert.ok(tableNames.includes('plan_steps'), 'plan_steps table exists');
    assert.ok(tableNames.includes('plan_decisions'), 'plan_decisions table exists');
    assert.ok(tableNames.includes('compaction_snapshots'), 'compaction_snapshots table exists');
    assert.ok(tableNames.includes('reminders'), 'reminders table exists');
    assert.ok(tableNames.includes('schema_version'), 'schema_version table exists');
  });

  it('should create FTS5 virtual table', () => {
    const fts = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='memories_fts'"
    ).get() as { name: string } | undefined;
    assert.ok(fts, 'memories_fts virtual table exists');
  });

  it('should set WAL journal mode (memory DB stays memory)', () => {
    // In-memory DBs cannot use WAL — they report 'memory'.
    // The pragma is issued but SQLite silently keeps memory mode.
    const result = db.pragma('journal_mode') as Array<{ journal_mode: string }>;
    assert.ok(['wal', 'memory'].includes(result[0].journal_mode));
  });

  it('should have foreign keys enabled', () => {
    const result = db.pragma('foreign_keys') as Array<{ foreign_keys: number }>;
    assert.equal(result[0].foreign_keys, 1);
  });

  it('should have schema version 1', () => {
    const row = db.prepare('SELECT version FROM schema_version LIMIT 1').get() as { version: number };
    assert.equal(row.version, SCHEMA_VERSION);
  });

  it('should create all required indexes', () => {
    const indexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'"
    ).all() as Array<{ name: string }>;
    const indexNames = indexes.map(i => i.name);

    assert.ok(indexNames.includes('idx_memories_project'));
    assert.ok(indexNames.includes('idx_memories_kind'));
    assert.ok(indexNames.includes('idx_memories_confidence'));
    assert.ok(indexNames.includes('idx_sessions_project'));
    assert.ok(indexNames.includes('idx_plans_project'));
    assert.ok(indexNames.includes('idx_snapshots_session'));
  });

  it('should enforce memory kind constraint', () => {
    assert.throws(() => {
      db.prepare(
        "INSERT INTO memories (id, content, kind, created_at) VALUES ('t1', 'test', 'invalid_kind', '2024-01-01')"
      ).run();
    });
  });

  it('should enforce memory source constraint', () => {
    assert.throws(() => {
      db.prepare(
        "INSERT INTO memories (id, content, kind, source, created_at) VALUES ('t1', 'test', 'pitfall', 'invalid_source', '2024-01-01')"
      ).run();
    });
  });

  it('should enforce plan status constraint', () => {
    assert.throws(() => {
      db.prepare(
        "INSERT INTO plans (id, project, name, status, created_at, updated_at) VALUES ('p1', 'proj', 'test', 'invalid', '2024-01-01', '2024-01-01')"
      ).run();
    });
  });

  it('should enforce step status constraint', () => {
    // First create a valid plan
    db.prepare(
      "INSERT INTO plans (id, project, name, status, created_at, updated_at) VALUES ('p1', 'proj', 'test', 'active', '2024-01-01', '2024-01-01')"
    ).run();

    assert.throws(() => {
      db.prepare(
        "INSERT INTO plan_steps (plan_id, step_id, description, status) VALUES ('p1', 1, 'test', 'invalid')"
      ).run();
    });
  });

  it('should be idempotent — opening twice does not error', () => {
    // The DB is already open from beforeEach. Opening again on same :memory: won't work,
    // but opening a second in-memory DB should work fine.
    const db2 = openDatabase({ dbPath: ':memory:' });
    const row = db2.prepare('SELECT version FROM schema_version LIMIT 1').get() as { version: number };
    assert.equal(row.version, SCHEMA_VERSION);
    db2.close();
  });
});
