import type Database from 'better-sqlite3';

import { CLIENT_CLAUDE } from '../../constants/clients.js';

const V29 = 29;

/**
 * v29 — per-memory client provenance.
 *
 * `origin_client` records WHICH agent (claude, codex, …) authored a memory —
 * distinct from `source`, which records the capture mechanism
 * (user/learned/corrected/confirmed). All pre-v29 rows were written by
 * Claude Code sessions, so the default backfills them correctly.
 *
 * Idempotent: the caller's version gate is backed by a column-existence
 * check, so a re-run (crash between ALTER and version write) is a no-op.
 */
export function migrateToV29(db: Database.Database): void {
  db.transaction(() => {
    const columns = db.prepare('PRAGMA table_info(memories)').all() as Array<{ name: string }>;
    if (!columns.some((c) => c.name === 'origin_client')) {
      db.exec(`ALTER TABLE memories ADD COLUMN origin_client TEXT NOT NULL DEFAULT '${CLIENT_CLAUDE}'`);
    }
    db.prepare('UPDATE schema_version SET version = ?').run(V29);
  })();
}
