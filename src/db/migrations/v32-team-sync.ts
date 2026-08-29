import type Database from 'better-sqlite3';

import {
  CREATE_MEMORY_TOMBSTONES_TABLE,
  CREATE_MEMORY_TOMBSTONES_INDEX,
  CREATE_SYNC_ENTITY_MAP_TABLE,
  CREATE_SYNC_ALIAS_LOG_TABLE,
  CREATE_SYNC_CONFLICT_SETS_TABLE,
  CREATE_SYNC_CONTRIBUTORS_TABLE,
  CREATE_SYNC_STATE_TABLE,
  CREATE_SYNC_JOURNAL_TABLE,
  CREATE_SYNC_JOURNAL_INDEX,
  CREATE_MEMORY_REVISION_TRIGGER,
} from '../schema.js';

const V32 = 32;

/**
 * v32 — Phase 2 team-sync foundations (the gate-passed brief's frozen
 * schema): `author`/`updated_at`/`share_state` on memories, the tombstone
 * log, and the neutral replica tables. `share_state` backfills to NULL by
 * construction (ADD COLUMN default) — history never silently becomes
 * upload-eligible; `updated_at` backfills to `created_at` so recency
 * semantics are sane from day one; the revision trigger is recreated to
 * also maintain `updated_at` (the inner UPDATE's SET columns appear in no
 * trigger's UPDATE OF list, so it still cannot recurse).
 *
 * Idempotent: column-existence checks back the caller's version gate, all
 * table DDL is IF NOT EXISTS, the trigger swap is DROP IF EXISTS +
 * recreate, and the backfill only touches NULL rows.
 */
export function migrateToV32(db: Database.Database): void {
  db.transaction(() => {
    const columns = db.prepare('PRAGMA table_info(memories)').all() as Array<{ name: string }>;
    const has = (name: string): boolean => columns.some((c) => c.name === name);

    if (!has('author')) {
      db.exec('ALTER TABLE memories ADD COLUMN author TEXT DEFAULT NULL');
    }
    if (!has('updated_at')) {
      db.exec('ALTER TABLE memories ADD COLUMN updated_at TEXT DEFAULT NULL');
    }
    if (!has('share_state')) {
      db.exec("ALTER TABLE memories ADD COLUMN share_state TEXT DEFAULT NULL CHECK (share_state IN ('local','team') OR share_state IS NULL)");
    }

    db.exec('UPDATE memories SET updated_at = created_at WHERE updated_at IS NULL');

    db.exec('DROP TRIGGER IF EXISTS memories_revision_au');
    db.exec(CREATE_MEMORY_REVISION_TRIGGER);

    // Heal: a pre-release v32 iteration briefly shipped an AFTER INSERT
    // updated_at trigger that corrupted external-content FTS under broad
    // update triggers (see schema.ts note). Initialization is explicit at
    // the repository insert sites now.
    db.exec('DROP TRIGGER IF EXISTS memories_updated_at_ai');

    // Pre-release v32 shape heal: the tombstone log briefly shipped with a
    // composite (memory_id, action, deleted_at) PK whose second-resolution
    // key silently suppressed a delete/restore/delete cycle's second entry
    // (review). Rebuild any such table to the rowid form, preserving rows.
    const tombCols = db.prepare('PRAGMA table_info(memory_tombstones)').all() as Array<{ name: string }>;
    if (tombCols.length > 0 && !tombCols.some((c) => c.name === 'id')) {
      db.exec('ALTER TABLE memory_tombstones RENAME TO memory_tombstones_v32a');
      db.exec(CREATE_MEMORY_TOMBSTONES_TABLE);
      db.exec(`INSERT INTO memory_tombstones (memory_id, action, project, kind, content, deleted_at)
               SELECT memory_id, action, project, kind, content, deleted_at FROM memory_tombstones_v32a`);
      db.exec('DROP TABLE memory_tombstones_v32a');
    }

    for (const ddl of [
      CREATE_MEMORY_TOMBSTONES_TABLE,
      CREATE_MEMORY_TOMBSTONES_INDEX,
      CREATE_SYNC_ENTITY_MAP_TABLE,
      CREATE_SYNC_ALIAS_LOG_TABLE,
      CREATE_SYNC_CONFLICT_SETS_TABLE,
      CREATE_SYNC_CONTRIBUTORS_TABLE,
      CREATE_SYNC_STATE_TABLE,
      CREATE_SYNC_JOURNAL_TABLE,
      CREATE_SYNC_JOURNAL_INDEX,
    ]) {
      db.exec(ddl);
    }

    db.prepare('UPDATE schema_version SET version = ?').run(V32);
  })();
}
