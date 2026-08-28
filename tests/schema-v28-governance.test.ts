import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import type Database from 'better-sqlite3';
import { openDatabase } from '../src/db/connection.js';
import { migrateToV28, type V28FaultPoint } from '../src/db/migrations/v28-governance.js';
import { SCHEMA_VERSION } from '../src/db/schema.js';
import { rewindToV27, schemaSnapshot } from './helpers/schema-v28.js';

const GOVERNANCE_TABLES = [
  'governance_tool_events', 'governance_gate_runs',
  'governance_audit', 'governance_client_state',
] as const;
const CHILD_TABLES = ['memory_edges', 'memory_corecall', 'session_memories', 'memory_versions'] as const;
let tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

function tempPath(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `cairn-v28-${label}-`));
  tempDirs.push(dir);
  return join(dir, 'store.db');
}

function version(db: Database.Database): number {
  return (db.prepare('SELECT version FROM schema_version').get() as { version: number }).version;
}

function foreignKeys(db: Database.Database): number {
  return Number(db.pragma('foreign_keys', { simple: true }));
}

function names(db: Database.Database, type: 'table' | 'index' | 'trigger'): string[] {
  return (db.prepare(
    'SELECT name FROM sqlite_master WHERE type = ? AND name NOT LIKE ? ORDER BY name',
  ).all(type, 'sqlite_%') as Array<{ name: string }>).map(row => row.name);
}

function tableInfo(db: Database.Database, table: string): unknown[] {
  return db.pragma(`table_info(${table})`) as unknown[];
}

function seedV27(path: string): void {
  const db = openDatabase({ dbPath: path });
  const insert = db.prepare(`
    INSERT INTO memories (
      id, content, kind, project, tags, confidence, source, created_at,
      last_recalled, recall_count, invalidated, expires_at, surface_count,
      impact_count, fingerprint, context, embedding, embedding_model, anchor,
      superseded_by, superseded_at, last_decayed_at, revision
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insert.run(
    'm-old', 'v28 aardwolf migration source', 'fact', 'proj', '["migration"]',
    0.73, 'confirmed', '2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z',
    4, 0, null, 3, 2, '{"lang":["ts"],"framework":[],"module":["db"]}',
    '{"why":"preserve all fields"}', Buffer.from([1, 2, 3, 4]), 'minilm-l6',
    '{"files":["src/db.ts"]}', null, null, '2026-02-02T00:00:00.000Z', 7,
  );
  insert.run(
    'm-new', 'v28 quokka migration target', 'decision', 'proj', '[]', 0.8,
    'user', '2026-01-02T00:00:00.000Z', null, 0, 0, null, 0, 0, null,
    null, null, null, null, null, null, '2026-01-02T00:00:00.000Z', 1,
  );
  db.prepare(`
    INSERT INTO memory_edges (source_id, target_id, relation) VALUES ('m-old','m-new','informs')
  `).run();
  db.prepare(`
    INSERT INTO memory_corecall (memory_a, memory_b, co_count) VALUES ('m-old','m-new',3)
  `).run();
  db.prepare(`
    INSERT INTO session_memories (session_id, memory_id, led_to_success) VALUES ('s1','m-old',1)
  `).run();
  db.prepare(`
    INSERT INTO memory_versions (memory_id, old_content, new_content) VALUES ('m-old','before','after')
  `).run();
  rewindToV27(db);
  db.close();
}

function childCounts(db: Database.Database): Record<string, number> {
  return Object.fromEntries(CHILD_TABLES.map(table => [
    table,
    (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n,
  ]));
}

interface ForeignKeyViolation {
  table: string;
  rowid: number | string | null;
  parent: string;
  fkid: number;
}

function foreignKeyViolations(db: Database.Database): ForeignKeyViolation[] {
  return (db.pragma('foreign_key_check') as ForeignKeyViolation[])
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function seedOrphan(path: string, sql: string): ForeignKeyViolation[] {
  const db = new BetterSqlite3(path);
  db.pragma('foreign_keys = OFF');
  try {
    db.exec(sql);
    return foreignKeyViolations(db);
  } finally {
    db.close();
  }
}

describe('schema v28 governance migration', () => {
  it('fresh schema is v28 and behaviorally matches a migrated v27 store', () => {
    const migratedPath = tempPath('parity');
    seedV27(migratedPath);
    const migrated = openDatabase({ dbPath: migratedPath });
    const fresh = openDatabase({ dbPath: ':memory:' });
    try {
      assert.equal(version(fresh), SCHEMA_VERSION);
      assert.equal(version(migrated), SCHEMA_VERSION);
      assert.deepEqual(tableInfo(migrated, 'memories'), tableInfo(fresh, 'memories'));
      for (const table of GOVERNANCE_TABLES) {
        assert.deepEqual(tableInfo(migrated, table), tableInfo(fresh, table), `${table} parity`);
      }
      assert.deepEqual(names(migrated, 'trigger'), names(fresh, 'trigger'));
      assert.deepEqual(names(migrated, 'index'), names(fresh, 'index'));
      assert.equal(foreignKeys(migrated), 1);
      assert.deepEqual(migrated.pragma('foreign_key_check'), []);
      assert.doesNotThrow(() => migrated.prepare(`
        INSERT INTO memories (id, content, kind, created_at) VALUES ('policy','rule','rule','2026-01-01')
      `).run());
      assert.throws(() => migrated.prepare(`
        INSERT INTO memories (id, content, kind, created_at) VALUES ('bad','bad','unknown','2026-01-01')
      `).run(), /CHECK|constraint/i);
    } finally {
      fresh.close();
      migrated.close();
    }
  });

  it('upgrades v27 field-for-field with FTS, indexes, triggers, and child foreign keys intact', () => {
    const path = tempPath('upgrade');
    seedV27(path);
    const db = openDatabase({ dbPath: path });
    try {
      assert.equal(version(db), 28);
      const row = db.prepare('SELECT * FROM memories WHERE id = ?').get('m-old') as Record<string, unknown>;
      assert.equal(row.content, 'v28 aardwolf migration source');
      assert.equal(row.revision, 7);
      assert.deepEqual(row.embedding, Buffer.from([1, 2, 3, 4]));
      assert.deepEqual(childCounts(db), {
        memory_edges: 1, memory_corecall: 1, session_memories: 1, memory_versions: 1,
      });
      for (const table of CHILD_TABLES) {
        const targets = (db.pragma(`foreign_key_list(${table})`) as Array<{ table: string }>).map(fk => fk.table);
        assert.ok(targets.includes('memories'), `${table} still references memories`);
      }
      const hit = db.prepare("SELECT COUNT(*) AS n FROM memories_fts WHERE memories_fts MATCH 'aardwolf'").get() as { n: number };
      assert.equal(hit.n, 1);
      db.prepare("UPDATE memories SET content = 'capybara replacement' WHERE id = 'm-old'").run();
      const updated = db.prepare("SELECT revision FROM memories WHERE id = 'm-old'").get() as { revision: number };
      assert.equal(updated.revision, 8, 'revision trigger recreated');
      assert.deepEqual(db.pragma('foreign_key_check'), []);
      assert.equal(foreignKeys(db), 1);
    } finally {
      db.close();
    }
  });

  it('carries a pre-existing orphaned plan_steps row through migration unchanged', () => {
    const path = tempPath('orphan-plan-step');
    seedV27(path);
    const before = seedOrphan(path, `
      INSERT INTO plan_steps (plan_id, step_id, description)
      VALUES ('missing-plan', 7, 'pre-existing orphan')
    `);
    assert.deepEqual(before.map(row => row.table), ['plan_steps']);

    const db = openDatabase({ dbPath: path });
    try {
      assert.equal(version(db), 28);
      assert.deepEqual(foreignKeyViolations(db), before);
      const orphan = db.prepare(`
        SELECT plan_id, step_id, description FROM plan_steps
        WHERE plan_id = 'missing-plan' AND step_id = 7
      `).get();
      assert.deepEqual(orphan, {
        plan_id: 'missing-plan', step_id: 7, description: 'pre-existing orphan',
      });
      assert.equal(foreignKeys(db), 1);
    } finally {
      db.close();
    }
  });

  it('carries a pre-existing memories-child orphan through migration unchanged', () => {
    const path = tempPath('orphan-memory-child');
    seedV27(path);
    const before = seedOrphan(path, `
      INSERT INTO session_memories (session_id, memory_id, led_to_success)
      VALUES ('legacy-session', 'missing-memory', 1)
    `);
    assert.deepEqual(before.map(row => row.table), ['session_memories']);

    const db = openDatabase({ dbPath: path });
    try {
      assert.equal(version(db), 28);
      assert.deepEqual(foreignKeyViolations(db), before);
      const orphan = db.prepare(`
        SELECT session_id, memory_id, led_to_success FROM session_memories
        WHERE session_id = 'legacy-session' AND memory_id = 'missing-memory'
      `).get();
      assert.deepEqual(orphan, {
        session_id: 'legacy-session', memory_id: 'missing-memory', led_to_success: 1,
      });
      assert.deepEqual(childCounts(db), {
        memory_edges: 1, memory_corecall: 1, session_memories: 2, memory_versions: 1,
      });
      assert.equal(foreignKeys(db), 1);
    } finally {
      db.close();
    }
  });

  for (const fault of ['after-parent-swap', 'after-governance-ddl'] as const) {
    it(`rolls back a failure ${fault} to byte-observable v27 state and restores foreign keys`, () => {
      const path = tempPath(fault);
      seedV27(path);
      const db = new BetterSqlite3(path);
      db.pragma('foreign_keys = ON');
      const beforeSchema = schemaSnapshot(db);
      const beforeChildren = childCounts(db);
      try {
        assert.throws(() => migrateToV28(db, fault as V28FaultPoint), new RegExp(fault));
        assert.equal(version(db), 27);
        assert.equal(schemaSnapshot(db), beforeSchema);
        assert.deepEqual(childCounts(db), beforeChildren);
        assert.deepEqual(db.pragma('foreign_key_check'), []);
        assert.equal(foreignKeys(db), 1, 'failure path restores foreign_keys=ON');
        for (const table of GOVERNANCE_TABLES) {
          assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table), undefined);
        }
      } finally {
        db.close();
      }
    });
  }
});
