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
    db.exec('CREATE INDEX IF NOT EXISTS idx_rollup_day ON telemetry_rollup(day, metric)');
    db.prepare('UPDATE schema_version SET version = ?').run(V30);
  })();
}
