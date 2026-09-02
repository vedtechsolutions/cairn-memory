#!/usr/bin/env node
/**
 * StatusLine script — context pressure monitoring.
 * Configured in settings.json under "statusLine" key (NOT a hook event).
 * Receives JSON via stdin with context_window data.
 * Outputs status text to stdout for CLI display.
 * Writes mode to cairn-state.json for MCP server to read.
 *
 * Uses a lightweight read-only DB connection (skips schema migration)
 * since this runs on every turn and only needs to read counts.
 */
import Database from 'better-sqlite3';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { writeState, type CairnState } from './shared/state-io.js';
import {
  CONTEXT_THRESHOLDS,
  AUTOCOMPACT_BUFFER_TOKENS,
  DEFAULT_CONTEXT_WINDOW_SIZE,
  DB,
  type ContextMode,
} from '../constants/index.js';
import { projectId } from '../utils/project-id.js';
import { ENV } from '../constants/env.js';

interface StatusLineInput {
  session_id: string;
  cwd?: string;
  context_window: {
    used_percentage: number;
    remaining_percentage: number;
    context_window_size: number;
    total_input_tokens: number;
    total_output_tokens: number;
  };
}

/** Open a lightweight read-only connection — no schema migration, no WAL pragma */
function openReadOnly(dbPath?: string): Database.Database | null {
  const resolved = dbPath ?? DB.DEFAULT_PATH.replace('~', homedir());
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
  const raw = readFileSync('/dev/stdin', 'utf-8');
  const input: StatusLineInput = JSON.parse(raw);

  const usedPct = Math.round(input.context_window.used_percentage ?? 0);
  const windowSize = input.context_window.context_window_size ?? DEFAULT_CONTEXT_WINDOW_SIZE;

  // Calculate free space until autocompact triggers
  const bufferPct = Math.round((AUTOCOMPACT_BUFFER_TOKENS * 100) / windowSize);
  let freeUntilCompact = 100 - usedPct - bufferPct;
  if (freeUntilCompact < 0) freeUntilCompact = 0;

  // Determine mode
  let mode: ContextMode;
  if (freeUntilCompact > CONTEXT_THRESHOLDS.NORMAL) {
    mode = 'normal';
  } else if (freeUntilCompact > CONTEXT_THRESHOLDS.COMPACT) {
    mode = 'compact';
  } else if (freeUntilCompact > CONTEXT_THRESHOLDS.MINIMAL) {
    mode = 'minimal';
  } else {
    mode = 'critical';
  }

  // Write mode to shared state file
  const state: CairnState = { mode, freeUntilCompact };
  writeState(state);

  // Build display string with DB metadata
  let display = `Waykeep: ${mode} | ${freeUntilCompact}% free`;

  if (input.cwd) {
    const dbPath = process.env[ENV.DB_PATH] ?? undefined;
    const db = openReadOnly(dbPath);
    if (db) {
      try {
        const project = projectId(input.cwd);

        // Memory count: project-scoped + global
        const memRow = db.prepare(
          "SELECT COUNT(*) as c FROM memories WHERE (project = ? OR project IS NULL) AND invalidated = 0 AND kind != 'rule'"
        ).get(project) as { c: number };

        // Active plan step progress
        const planRow = db.prepare(
          "SELECT id FROM plans WHERE project = ? AND status = 'active' LIMIT 1"
        ).get(project) as { id: string } | undefined;

        if (planRow) {
          const steps = db.prepare(
            "SELECT COUNT(*) as total, COUNT(CASE WHEN status = 'done' THEN 1 END) as done FROM plan_steps WHERE plan_id = ?"
          ).get(planRow.id) as { total: number; done: number };
          display += ` | step ${steps.done}/${steps.total}`;
        }

        // Reminder count (only show if > 0)
        const remRow = db.prepare(
          'SELECT COUNT(*) as c FROM reminders WHERE active = 1 AND (project = ? OR project IS NULL)'
        ).get(project) as { c: number };

        display += ` | ${memRow.c} mem`;
        if (remRow.c > 0) display += ` ${remRow.c} rem`;
      } catch {
        // DB errors don't block the status bar
      } finally {
        db.close();
      }
    }
  }

  process.stdout.write(display);
} catch {
  // Silent failure — don't break the status bar
  process.stdout.write('Waykeep: --');
}
