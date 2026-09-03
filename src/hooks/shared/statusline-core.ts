/**
 * StatusLine core — the context-mode arithmetic and the status counts shared
 * by the direct-node entry point (statusline.ts) and the daemon handler
 * (handlers/statusline-handler.ts), which used to carry two copies.
 */
import type Database from 'better-sqlite3';
import {
  CONTEXT_THRESHOLDS,
  AUTOCOMPACT_BUFFER_TOKENS,
  DEFAULT_CONTEXT_WINDOW_SIZE,
  PERCENT_TOTAL,
  type ContextMode,
} from '../../constants/index.js';
import { projectId } from '../../utils/project-id.js';
import type { WaykeepState } from './state-io.js';

/** The StatusLine payload Claude Code writes to stdin. */
export interface StatusLineInput {
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

/** What the bar shows after the mode: memories in scope, active reminders,
 *  and the active plan's step progress (null without an active plan). */
export interface StatusCounts {
  memories: number;
  reminders: number;
  planStep: { done: number; total: number } | null;
}

export function contextModeFor(freeUntilCompact: number): ContextMode {
  if (freeUntilCompact > CONTEXT_THRESHOLDS.NORMAL) return 'normal';
  if (freeUntilCompact > CONTEXT_THRESHOLDS.COMPACT) return 'compact';
  if (freeUntilCompact > CONTEXT_THRESHOLDS.MINIMAL) return 'minimal';
  return 'critical';
}

/** Free space until autocompact triggers, and the mode that puts the session in. */
export function computeContextState(input: StatusLineInput): WaykeepState {
  const usedPct = Math.round(input.context_window.used_percentage ?? 0);
  const windowSize = input.context_window.context_window_size ?? DEFAULT_CONTEXT_WINDOW_SIZE;
  const bufferPct = Math.round((AUTOCOMPACT_BUFFER_TOKENS * PERCENT_TOTAL) / windowSize);
  const freeUntilCompact = Math.max(0, PERCENT_TOTAL - usedPct - bufferPct);
  return { mode: contextModeFor(freeUntilCompact), freeUntilCompact };
}

/** The three status queries — read-only, any connection. */
export function readStatusCounts(db: Database.Database, project: string): StatusCounts {
  const memRow = db.prepare(
    "SELECT COUNT(*) as c FROM memories WHERE (project = ? OR project IS NULL) AND invalidated = 0 AND kind != 'rule'",
  ).get(project) as { c: number };
  const planRow = db.prepare(
    "SELECT id FROM plans WHERE project = ? AND status = 'active' LIMIT 1",
  ).get(project) as { id: string } | undefined;
  const planStep = planRow
    ? db.prepare(
      "SELECT COUNT(*) as total, COUNT(CASE WHEN status = 'done' THEN 1 END) as done FROM plan_steps WHERE plan_id = ?",
    ).get(planRow.id) as { total: number; done: number }
    : null;
  const remRow = db.prepare(
    'SELECT COUNT(*) as c FROM reminders WHERE active = 1 AND (project = ? OR project IS NULL)',
  ).get(project) as { c: number };
  return { memories: memRow.c, reminders: remRow.c, planStep };
}

/** Counts for the cwd's project, or null when there is nothing to read or the
 *  read fails — a DB problem must never block the status bar. */
export function statusCountsFor(db: Database.Database | null, cwd: string | undefined): StatusCounts | null {
  if (!db || !cwd) return null;
  try {
    return readStatusCounts(db, projectId(cwd));
  } catch {
    return null;
  }
}

export function formatStatusLine(state: WaykeepState, counts: StatusCounts | null): string {
  let display = `Waykeep: ${state.mode} | ${state.freeUntilCompact}% free`;
  if (!counts) return display;
  if (counts.planStep) display += ` | step ${counts.planStep.done}/${counts.planStep.total}`;
  display += ` | ${counts.memories} mem`;
  if (counts.reminders > 0) display += ` ${counts.reminders} rem`;
  return display;
}
