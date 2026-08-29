/**
 * StatusLine handler — context pressure monitoring.
 * Pure business logic: no stdin/stdout/process.exit.
 * Uses the daemon's shared DB connection (read-only queries only).
 */
import type { HookDbClient } from '../shared/db-client.js';
import { writeState, type CairnState } from '../shared/state-io.js';
import { projectId } from '../../utils/project-id.js';
import {
  CONTEXT_THRESHOLDS,
  AUTOCOMPACT_BUFFER_TOKENS,
  DEFAULT_CONTEXT_WINDOW_SIZE,
  type ContextMode,
} from '../../constants/index.js';

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

export interface StatusLineResult {
  display: string;
}

export function handleStatusLine(input: StatusLineInput, client: HookDbClient): StatusLineResult {
  const usedPct = Math.round(input.context_window.used_percentage ?? 0);
  const windowSize = input.context_window.context_window_size ?? DEFAULT_CONTEXT_WINDOW_SIZE;

  const bufferPct = Math.round((AUTOCOMPACT_BUFFER_TOKENS * 100) / windowSize);
  let freeUntilCompact = 100 - usedPct - bufferPct;
  if (freeUntilCompact < 0) freeUntilCompact = 0;

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

  writeState({ mode, freeUntilCompact } as CairnState);

  let display = `Waykeep: ${mode} | ${freeUntilCompact}% free`;

  if (input.cwd) {
    try {
      const project = projectId(input.cwd);

      const memRow = client.db.prepare(
        "SELECT COUNT(*) as c FROM memories WHERE (project = ? OR project IS NULL) AND invalidated = 0 AND kind != 'rule'"
      ).get(project) as { c: number };

      const planRow = client.db.prepare(
        "SELECT id FROM plans WHERE project = ? AND status = 'active' LIMIT 1"
      ).get(project) as { id: string } | undefined;

      if (planRow) {
        const steps = client.db.prepare(
          "SELECT COUNT(*) as total, COUNT(CASE WHEN status = 'done' THEN 1 END) as done FROM plan_steps WHERE plan_id = ?"
        ).get(planRow.id) as { total: number; done: number };
        display += ` | step ${steps.done}/${steps.total}`;
      }

      const remRow = client.db.prepare(
        'SELECT COUNT(*) as c FROM reminders WHERE active = 1 AND (project = ? OR project IS NULL)'
      ).get(project) as { c: number };

      display += ` | ${memRow.c} mem`;
      if (remRow.c > 0) display += ` ${remRow.c} rem`;
    } catch {
      // DB errors don't block status bar
    }
  }

  return { display };
}
