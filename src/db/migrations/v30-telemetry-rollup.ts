import type Database from 'better-sqlite3';

import { CREATE_TELEMETRY_ROLLUP_TABLE } from '../schema.js';

const V30 = 30;

/**
 * v30 — durable tokens-saved aggregates (`telemetry_rollup`).
 *
 * hook_telemetry rows are pruned at 7 days; the tokens-saved report needs
 * a longer horizon, so per-(session, surface) aggregates persist in their
 * own table with their own retention. A NEW table (never a column add)
 * keeps migrated and fresh databases structurally identical.
 *
 * Idempotent: CREATE IF NOT EXISTS + the caller's version gate — a re-run
 * after a crash between DDL and version write is a no-op.
 */
export function migrateToV30(db: Database.Database): void {
  db.transaction(() => {
    db.exec(CREATE_TELEMETRY_ROLLUP_TABLE);
    // COLUMN-AWARE, and dispatched at `currentVersion <= 30`: the events
    // column was added to the v30 DDL while v30 was unreleased, so a
    // database created by the earlier v30 shape is already AT version 30
    // with a six-column table — a version-gated CREATE IF NOT EXISTS
    // alone would leave recording silently dead there forever (review).
    const columns = db.prepare('PRAGMA table_info(telemetry_rollup)').all() as Array<{ name: string }>;
    if (!columns.some((c) => c.name === 'events')) {
      db.exec('ALTER TABLE telemetry_rollup ADD COLUMN events INTEGER NOT NULL DEFAULT 1');
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_rollup_day ON telemetry_rollup(day, metric)');
    db.prepare('UPDATE schema_version SET version = ?').run(V30);
  })();
}
