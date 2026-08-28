import type Database from 'better-sqlite3';
import {
  CREATE_EXACT_SCOPE_INDEX,
  CREATE_FTS_TRIGGERS,
  CREATE_INDEXES,
  CREATE_MEMORIES_FTS,
  CREATE_MEMORIES_TABLE,
  CREATE_MEMORY_REVISION_TRIGGER,
} from '../../src/db/schema.js';

const MEMORY_COLUMNS = [
  'id', 'content', 'kind', 'project', 'tags', 'confidence', 'source',
  'created_at', 'last_recalled', 'recall_count', 'invalidated', 'expires_at',
  'surface_count', 'impact_count', 'fingerprint', 'context', 'embedding',
  'embedding_model', 'anchor', 'superseded_by', 'superseded_at',
  'last_decayed_at', 'revision',
].join(', ');

/** Test-only rewind: derive the exact v27 parent from current DDL by removing
 * only the v28 `rule` enum member, then remove the four governance tables. */
export function rewindToV27(db: Database.Database): void {
  if (db.inTransaction) throw new Error('rewind requires no transaction');
  db.pragma('foreign_keys = OFF');
  try {
    db.exec('BEGIN IMMEDIATE');
    db.exec('DROP TABLE governance_gate_runs');
    db.exec('DROP TABLE governance_audit');
    db.exec('DROP TABLE governance_client_state');
    db.exec('DROP TABLE governance_tool_events');
    db.exec('DROP TRIGGER memories_ai');
    db.exec('DROP TRIGGER memories_ad');
    db.exec('DROP TRIGGER memories_au');
    db.exec('DROP TRIGGER memories_revision_au');
    db.exec('DROP TABLE memories_fts');
    const v27Ddl = CREATE_MEMORIES_TABLE
      .replace('CREATE TABLE IF NOT EXISTS memories', 'CREATE TABLE memories_v27')
      .replace(",'rule'", '');
    db.exec(v27Ddl);
    db.exec(`INSERT INTO memories_v27 (${MEMORY_COLUMNS}) SELECT ${MEMORY_COLUMNS} FROM memories`);
    db.exec('DROP TABLE memories');
    db.exec('ALTER TABLE memories_v27 RENAME TO memories');
    db.exec(CREATE_MEMORIES_FTS);
    for (const ddl of CREATE_FTS_TRIGGERS) db.exec(ddl);
    db.exec(CREATE_MEMORY_REVISION_TRIGGER);
    db.exec('INSERT INTO memories_fts(rowid, content, tags) SELECT rowid, content, tags FROM memories');
    for (const ddl of CREATE_INDEXES) {
      if (ddl.includes('idx_memories_')) db.exec(ddl);
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_memories_superseded ON memories(superseded_by)');
    db.exec(CREATE_EXACT_SCOPE_INDEX);
    db.prepare('UPDATE schema_version SET version = 27').run();
    db.exec('COMMIT');
  } catch (error) {
    if (db.inTransaction) db.exec('ROLLBACK');
    throw error;
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

export function schemaSnapshot(db: Database.Database): string {
  const rows = db.prepare(`
    SELECT type, name, tbl_name, sql
    FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%'
    ORDER BY type, name
  `).all() as Array<{ type: string; name: string; tbl_name: string; sql: string | null }>;
  return JSON.stringify(rows);
}
