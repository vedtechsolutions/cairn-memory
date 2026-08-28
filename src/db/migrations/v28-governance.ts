import type Database from 'better-sqlite3';
import {
  CREATE_EXACT_SCOPE_INDEX,
  CREATE_FTS_TRIGGERS,
  CREATE_INDEXES,
  CREATE_MEMORIES_FTS,
  CREATE_MEMORY_REVISION_TRIGGER,
} from '../schema.js';
import { GOVERNANCE_DDL } from '../governance-schema.js';

const V28 = 28;
const REPLACEMENT = 'memories_v28';
const MEMORY_COLUMNS = [
  'id', 'content', 'kind', 'project', 'tags', 'confidence', 'source',
  'created_at', 'last_recalled', 'recall_count', 'invalidated', 'expires_at',
  'surface_count', 'impact_count', 'fingerprint', 'context', 'embedding',
  'embedding_model', 'anchor', 'superseded_by', 'superseded_at',
  'last_decayed_at', 'revision',
] as const;
const CHILD_TABLES = [
  'memory_edges', 'memory_corecall', 'session_memories', 'memory_versions',
] as const;

interface ForeignKeyViolation {
  table: string;
  rowid: number | string | null;
  parent: string;
  fkid: number;
}

const CREATE_REPLACEMENT = `
CREATE TABLE ${REPLACEMENT} (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('pitfall','decision','correction','fact','task_state','user_profile','reference','pattern','goal','rule')),
  project TEXT,
  tags TEXT,
  confidence REAL DEFAULT 0.5,
  source TEXT DEFAULT 'learned' CHECK (source IN ('user','learned','corrected','confirmed')),
  created_at TEXT NOT NULL,
  last_recalled TEXT,
  recall_count INTEGER DEFAULT 0,
  invalidated INTEGER DEFAULT 0,
  expires_at TEXT DEFAULT NULL,
  surface_count INTEGER DEFAULT 0,
  impact_count INTEGER DEFAULT 0,
  fingerprint TEXT DEFAULT NULL,
  context TEXT DEFAULT NULL,
  embedding BLOB DEFAULT NULL,
  embedding_model TEXT DEFAULT NULL,
  anchor TEXT DEFAULT NULL,
  superseded_by TEXT DEFAULT NULL,
  superseded_at TEXT DEFAULT NULL,
  last_decayed_at TEXT DEFAULT NULL,
  revision INTEGER NOT NULL DEFAULT 1
)`;

export type V28FaultPoint = 'after-parent-swap' | 'after-governance-ddl';

function scalar(db: Database.Database, sql: string): number {
  return (db.prepare(sql).get() as { value: number }).value;
}

function foreignKeys(db: Database.Database): number {
  return Number(db.pragma('foreign_keys', { simple: true }));
}

function assertEqual(actual: number, expected: number, label: string): void {
  if (actual !== expected) {
    throw new Error(`v28 migration ${label}: expected ${expected}, got ${actual}`);
  }
}

function childCounts(db: Database.Database): Map<string, number> {
  return new Map(CHILD_TABLES.map(table => [
    table,
    scalar(db, `SELECT COUNT(*) AS value FROM ${table}`),
  ]));
}

function foreignKeyViolations(db: Database.Database): ForeignKeyViolation[] {
  return db.pragma('foreign_key_check') as ForeignKeyViolation[];
}

function violationKey(violation: ForeignKeyViolation): string {
  return JSON.stringify([
    violation.table, violation.rowid, violation.parent, violation.fkid,
  ]);
}

function assertForeignKeyViolationsPreserved(
  before: readonly ForeignKeyViolation[],
  after: readonly ForeignKeyViolation[],
): void {
  const baseline = new Map<string, number>();
  for (const violation of before) {
    const key = violationKey(violation);
    baseline.set(key, (baseline.get(key) ?? 0) + 1);
  }

  const introduced: ForeignKeyViolation[] = [];
  for (const violation of after) {
    const key = violationKey(violation);
    const remaining = baseline.get(key) ?? 0;
    if (remaining === 0) introduced.push(violation);
    else baseline.set(key, remaining - 1);
  }
  if (introduced.length > 0) {
    throw new Error(
      `v28 migration foreign_key_check found ${introduced.length} new violation(s) ` +
      `(baseline ${before.length}, after ${after.length})`,
    );
  }
  const missing = [...baseline.values()].reduce((total, count) => total + count, 0);
  if (missing > 0) {
    throw new Error(
      `v28 migration changed or repaired ${missing} pre-existing foreign-key violation(s)`,
    );
  }
}

function verifyChildren(
  db: Database.Database,
  beforeCounts: Map<string, number>,
  beforeViolations: readonly ForeignKeyViolation[],
): void {
  for (const table of CHILD_TABLES) {
    assertEqual(
      scalar(db, `SELECT COUNT(*) AS value FROM ${table}`),
      beforeCounts.get(table) ?? -1,
      `${table} child count`,
    );
  }
  assertForeignKeyViolationsPreserved(beforeViolations, foreignKeyViolations(db));
}

function injectFault(point: V28FaultPoint, requested?: V28FaultPoint): void {
  if (point === requested) throw new Error(`injected v28 migration fault: ${point}`);
}

/** Atomic v27→v28 parent rebuild. Foreign keys must be disabled before the
 * transaction because SQLite ignores foreign_keys changes inside one. The
 * BEGIN IMMEDIATE is the connection's migration/write lock and precedes all
 * schema mutation. The finally block is an invariant: callers never regain a
 * usable connection with foreign-key enforcement disabled. */
export function migrateToV28(db: Database.Database, fault?: V28FaultPoint): void {
  if (db.inTransaction) throw new Error('v28 migration requires no active transaction');
  const version = scalar(db, 'SELECT version AS value FROM schema_version LIMIT 1');
  if (version !== 27) throw new Error(`v28 migration requires schema 27, got ${version}`);
  const beforeMemories = scalar(db, 'SELECT COUNT(*) AS value FROM memories');
  const beforeChildren = childCounts(db);
  // A legacy store may already contain unrelated orphans. Preserve that
  // baseline exactly as data; this rebuild is responsible only for proving
  // that it introduces no additional foreign-key violations.
  const beforeViolations = foreignKeyViolations(db);
  let failure: unknown;

  db.pragma('foreign_keys = OFF');
  try {
    if (foreignKeys(db) !== 0) {
      throw new Error('v28 migration could not disable foreign keys');
    }
    db.exec('BEGIN IMMEDIATE');
    db.exec(CREATE_REPLACEMENT);
    const columns = MEMORY_COLUMNS.join(', ');
    db.exec(`INSERT INTO ${REPLACEMENT} (${columns}) SELECT ${columns} FROM memories`);
    assertEqual(
      scalar(db, `SELECT COUNT(*) AS value FROM ${REPLACEMENT}`),
      beforeMemories,
      'memory copy count',
    );

    db.exec('DROP TRIGGER IF EXISTS memories_ai');
    db.exec('DROP TRIGGER IF EXISTS memories_ad');
    db.exec('DROP TRIGGER IF EXISTS memories_au');
    db.exec('DROP TRIGGER IF EXISTS memories_revision_au');
    db.exec('DROP TABLE memories_fts');
    db.exec('DROP TABLE memories');
    db.exec(`ALTER TABLE ${REPLACEMENT} RENAME TO memories`);
    injectFault('after-parent-swap', fault);

    db.exec(CREATE_MEMORIES_FTS);
    for (const ddl of CREATE_FTS_TRIGGERS) db.exec(ddl);
    db.exec(CREATE_MEMORY_REVISION_TRIGGER);
    db.exec('INSERT INTO memories_fts(rowid, content, tags) SELECT rowid, content, tags FROM memories');
    for (const ddl of CREATE_INDEXES) {
      if (ddl.includes('idx_memories_')) db.exec(ddl);
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_memories_superseded ON memories(superseded_by)');
    db.exec(CREATE_EXACT_SCOPE_INDEX);

    for (const ddl of GOVERNANCE_DDL) db.exec(ddl);
    injectFault('after-governance-ddl', fault);
    verifyChildren(db, beforeChildren, beforeViolations);
    db.prepare('UPDATE schema_version SET version = ?').run(V28);
    db.exec('COMMIT');
  } catch (error) {
    failure = error;
    if (db.inTransaction) {
      try { db.exec('ROLLBACK'); } catch (rollbackError) { failure = rollbackError; }
    }
  } finally {
    db.pragma('foreign_keys = ON');
  }

  if (foreignKeys(db) !== 1) {
    throw new Error('v28 migration failed to restore foreign keys');
  }
  if (failure) throw failure;
}
