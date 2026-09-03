#!/usr/bin/env node
/**
 * StatusLine script — context pressure monitoring.
 * Configured in settings.json under "statusLine" key (NOT a hook event).
 * Receives JSON via stdin with context_window data, outputs status text to
 * stdout, and writes the mode to waykeep-state.json for the MCP server.
 *
 * Owns only stdin/stdout and a lightweight read-only DB connection (no
 * schema migration — this runs on every turn); the arithmetic and the
 * queries live in shared/statusline-core.ts, shared with the daemon handler.
 */
import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { readStdinJson } from './shared/hook-io.js';
import { writeState } from './shared/state-io.js';
import {
  computeContextState,
  formatStatusLine,
  statusCountsFor,
  type StatusLineInput,
} from './shared/statusline-core.js';
import { DB } from '../constants/index.js';
import { defaultDbPath } from '../constants/paths.js';
import { ENV } from '../constants/env.js';
import { log } from '../utils/log.js';

/** Open a lightweight read-only connection — no schema migration, no WAL pragma */
function openReadOnly(dbPath?: string): Database.Database | null {
  const resolved = dbPath ?? defaultDbPath(); // coherent state root (Phase B)
  if (resolved === ':memory:' || !existsSync(resolved)) return null;
  try {
    const db = new Database(resolved, { readonly: true });
    db.pragma(`busy_timeout = ${DB.BUSY_TIMEOUT_MS}`);
    return db;
  } catch {
    return null;
  }
}

try {
  const input = readStdinJson<StatusLineInput>();
  const state = computeContextState(input);
  writeState(state);

  const db = input.cwd ? openReadOnly(process.env[ENV.DB_PATH] ?? undefined) : null;
  try {
    process.stdout.write(formatStatusLine(state, statusCountsFor(db, input.cwd)));
  } finally {
    db?.close();
  }
} catch (err) {
  // Never break the status bar; the cause is visible at debug level only.
  log.debug('statusline failed:', err);
  process.stdout.write('Waykeep: --');
}
