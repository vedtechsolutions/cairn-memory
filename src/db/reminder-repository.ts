import type Database from 'better-sqlite3';
import { generateId, now, buildFtsQuery } from '../utils/index.js';
import { resolveProjectParam } from './project-resolver.js';
import { sanitize } from '../utils/validation.js';
import { LIMITS, REMINDERS } from '../constants/index.js';
import { evaluateCondition, type ConditionContext } from '../utils/condition-evaluator.js';

// --- Types ------------------------------------------------------------------

export type ReminderTriggerType = 'prompt' | 'file' | 'time' | 'conditional';

export interface ReminderTriggerConfig {
  /** File paths for 'file' trigger type */
  filePaths?: string[];
  /** ISO date string for 'time' trigger type (next due) */
  nextDue?: string;
  /** Condition expression for 'conditional' type */
  condition?: string;
}

export interface Reminder {
  id: string;
  trigger_pattern: string;
  action: string;
  project: string | null;
  fire_count: number;
  max_fires: number;
  active: number;
  created_at: string;
  trigger_type: ReminderTriggerType;
  trigger_config: ReminderTriggerConfig | null;
}

export interface CreateReminderInput {
  trigger: string;
  action: string;
  project?: string | null;
  max_fires?: number;
  trigger_type?: ReminderTriggerType;
  trigger_config?: ReminderTriggerConfig;
}

interface ReminderRow {
  id: string;
  trigger_pattern: string;
  action: string;
  project: string | null;
  fire_count: number;
  max_fires: number;
  active: number;
  created_at: string;
  trigger_type: string;
  trigger_config: string | null;
}

// --- Constants (from centralized config) ------------------------------------

const MAX_FIRED_PER_PROMPT = LIMITS.REMINDERS_MAX_FIRE_PER_PROMPT;

// --- Repository -------------------------------------------------------------

export class ReminderRepository {
  constructor(private db: Database.Database) {}

  /** Resolve a user/agent-typed project param — a bare name resolves to the
   *  full id when unambiguous, else passes through unchanged (fail closed). */
  resolveProject(raw: string | null | undefined): string | null | undefined {
    return resolveProjectParam(this.db, raw);
  }

  create(input: CreateReminderInput): { id: string } | { error: string } {
    const trigger = sanitize(input.trigger).slice(0, REMINDERS.MAX_TRIGGER_CHARS);
    const action = sanitize(input.action).slice(0, REMINDERS.MAX_ACTION_CHARS);
    const project = input.project ?? null;
    const maxFires = input.max_fires ?? 0;

    if (!trigger.trim()) return { error: 'trigger is empty' };
    if (!action.trim()) return { error: 'action is empty' };

    // Enforce active limit
    const count = this.activeCount(project);
    if (count >= REMINDERS.MAX_ACTIVE) {
      return { error: `limit reached: ${REMINDERS.MAX_ACTIVE} active reminders` };
    }

    const id = generateId();
    const triggerType = input.trigger_type ?? 'prompt';
    const triggerConfig = input.trigger_config ? JSON.stringify(input.trigger_config) : null;

    this.db.prepare(`
      INSERT INTO reminders (id, trigger_pattern, action, project, fire_count, max_fires, active, created_at, trigger_type, trigger_config)
      VALUES (?, ?, ?, ?, 0, ?, 1, ?, ?, ?)
    `).run(id, trigger, action, project, maxFires, now(), triggerType, triggerConfig);

    return { id };
  }

  /** Check prompt against active reminders, return matches and increment fire counts */
  checkAndFire(prompt: string, project: string | null): Reminder[] {
    const ftsQuery = this.buildFtsQuery(prompt);
    if (!ftsQuery) return [];

    let rows: ReminderRow[];
    try {
      rows = this.db.prepare(`
        SELECT r.*
        FROM reminders_fts fts
        JOIN reminders r ON r.rowid = fts.rowid
        WHERE reminders_fts MATCH ?
          AND r.active = 1
          AND (r.project = ? OR r.project IS NULL)
        LIMIT ?
      `).all(ftsQuery, project, MAX_FIRED_PER_PROMPT) as ReminderRow[];
    } catch {
      return [];
    }

    if (rows.length === 0) return [];

    // Increment fire counts and deactivate if needed
    const updateStmt = this.db.prepare(
      'UPDATE reminders SET fire_count = fire_count + 1 WHERE id = ?'
    );
    const deactivateStmt = this.db.prepare(
      'UPDATE reminders SET active = 0 WHERE id = ?'
    );

    this.db.transaction(() => {
      for (const row of rows) {
        updateStmt.run(row.id);
        // Mirror the DB update into the returned row — callers render
        // fire_count/active, and pre-increment values are stale.
        row.fire_count += 1;
        if (row.max_fires > 0 && row.fire_count >= row.max_fires) {
          deactivateStmt.run(row.id);
          row.active = 0;
        }
      }
    })();

    return rows.map(r => this.rowToReminder(r));
  }

  /** Check file path against file-triggered reminders */
  checkFileReminders(filePath: string, project: string | null): Reminder[] {
    const basename = filePath.split('/').pop() ?? filePath;
    const rows = this.db.prepare(`
      SELECT * FROM reminders
      WHERE active = 1
        AND trigger_type = 'file'
        AND (project = ? OR project IS NULL)
        AND (trigger_config LIKE ? OR trigger_config LIKE ?)
      LIMIT ?
    `).all(project, `%${basename}%`, `%${filePath}%`, MAX_FIRED_PER_PROMPT) as ReminderRow[];

    if (rows.length === 0) return [];

    const updateStmt = this.db.prepare('UPDATE reminders SET fire_count = fire_count + 1 WHERE id = ?');
    const deactivateStmt = this.db.prepare('UPDATE reminders SET active = 0 WHERE id = ?');

    this.db.transaction(() => {
      for (const row of rows) {
        updateStmt.run(row.id);
        // Mirror the DB update into the returned row — callers render
        // fire_count/active, and pre-increment values are stale.
        row.fire_count += 1;
        if (row.max_fires > 0 && row.fire_count >= row.max_fires) {
          deactivateStmt.run(row.id);
          row.active = 0;
        }
      }
    })();

    return rows.map(r => this.rowToReminder(r));
  }

  /** Check for due time-based reminders */
  checkTimeReminders(project: string | null): Reminder[] {
    const rows = this.db.prepare(`
      SELECT * FROM reminders
      WHERE active = 1
        AND trigger_type = 'time'
        AND trigger_config IS NOT NULL
        AND (project = ? OR project IS NULL)
      LIMIT ?
    `).all(project, MAX_FIRED_PER_PROMPT) as ReminderRow[];

    // Filter by nextDue <= now
    const nowIso = new Date().toISOString();
    const due = rows.filter(r => {
      try {
        const config = JSON.parse(r.trigger_config ?? '{}');
        return config.nextDue && config.nextDue <= nowIso;
      } catch { return false; }
    });

    if (due.length === 0) return [];

    const updateStmt = this.db.prepare('UPDATE reminders SET fire_count = fire_count + 1 WHERE id = ?');
    const deactivateStmt = this.db.prepare('UPDATE reminders SET active = 0 WHERE id = ?');

    this.db.transaction(() => {
      for (const row of due) {
        updateStmt.run(row.id);
        // Mirror the DB update into the returned row — callers render
        // fire_count/active, and pre-increment values are stale.
        row.fire_count += 1;
        if (row.max_fires > 0 && row.fire_count >= row.max_fires) {
          deactivateStmt.run(row.id);
          row.active = 0;
        }
      }
    })();

    return due.map(r => this.rowToReminder(r));
  }

  /** List active reminders */
  listActive(project?: string | null): Reminder[] {
    const rows = this.db.prepare(`
      SELECT * FROM reminders
      WHERE active = 1
        ${project !== undefined ? 'AND (project = ? OR project IS NULL)' : ''}
      ORDER BY created_at DESC
    `).all(...(project !== undefined ? [project] : [])) as ReminderRow[];
    return rows.map(r => this.rowToReminder(r));
  }

  /** Deactivate a reminder */
  deactivate(id: string): boolean {
    const result = this.db.prepare(
      'UPDATE reminders SET active = 0 WHERE id = ? AND active = 1'
    ).run(id);
    return result.changes > 0;
  }

  /** Delete a reminder */
  delete(id: string): boolean {
    const result = this.db.prepare('DELETE FROM reminders WHERE id = ?').run(id);
    return result.changes > 0;
  }

  /** Count active reminders for a project scope */
  private activeCount(project: string | null): number {
    const row = this.db.prepare(
      'SELECT COUNT(*) as cnt FROM reminders WHERE active = 1 AND (project = ? OR project IS NULL)'
    ).get(project) as { cnt: number };
    return row.cnt;
  }

  /** Check conditional reminders against runtime context */
  checkConditionalReminders(ctx: ConditionContext, project: string | null): Reminder[] {
    const rows = this.db.prepare(`
      SELECT * FROM reminders
      WHERE active = 1
        AND trigger_type = 'conditional'
        AND trigger_config IS NOT NULL
        AND (project = ? OR project IS NULL)
      LIMIT ?
    `).all(project, MAX_FIRED_PER_PROMPT) as ReminderRow[];

    const matched = rows.filter(r => {
      try {
        const config = JSON.parse(r.trigger_config ?? '{}');
        return config.condition && evaluateCondition(config.condition, ctx);
      } catch { return false; }
    });

    if (matched.length === 0) return [];

    const updateStmt = this.db.prepare('UPDATE reminders SET fire_count = fire_count + 1 WHERE id = ?');
    const deactivateStmt = this.db.prepare('UPDATE reminders SET active = 0 WHERE id = ?');

    this.db.transaction(() => {
      for (const row of matched) {
        updateStmt.run(row.id);
        if (row.max_fires > 0 && row.fire_count + 1 >= row.max_fires) {
          deactivateStmt.run(row.id);
        }
      }
    })();

    return matched.map(r => this.rowToReminder(r));
  }

  /** Convert row to Reminder with parsed trigger_config */
  private rowToReminder(row: ReminderRow): Reminder {
    return {
      ...row,
      trigger_type: (row.trigger_type ?? 'prompt') as ReminderTriggerType,
      trigger_config: row.trigger_config ? JSON.parse(row.trigger_config) : null,
    };
  }

  /** Delegate to shared FTS query builder (no stopword filtering, max 10 terms) */
  private buildFtsQuery(text: string): string | null {
    return buildFtsQuery(text, { filterStopwords: false, maxTerms: 10 });
  }
}
