import type Database from 'better-sqlite3';
import {
  LIMITS,
  type PlanStatus,
  type StepStatus,
} from '../constants/index.js';
import { generateId, now, sanitize, validateNoteContent, validateStepCount } from '../utils/index.js';
import { resolveProjectParam } from './project-resolver.js';

// --- Types ------------------------------------------------------------------

export interface Plan {
  id: string;
  project: string;
  name: string;
  status: PlanStatus;
  created_at: string;
  updated_at: string;
  steps: PlanStep[];
  decisions: PlanDecision[];
}

export interface PlanStep {
  plan_id: string;
  step_id: number;
  description: string;
  status: StepStatus;
  depends_on: number[];
  outcome: string | null;
  blockers: string | null;
  notes: Array<{ note: string; at: string }>;
}

export interface PlanDecision {
  id: string;
  plan_id: string;
  step_id: number | null;
  chose: string;
  why: string;
  alternatives: string[];
  permanent: boolean;
  decided_at: string;
}

export interface CreatePlanInput {
  project: string;
  name: string;
  steps: Array<{ description: string; depends_on?: number[] }>;
}

export interface UpdateStepInput {
  step_id: number;
  status?: StepStatus;
  outcome?: string;
  blockers?: string;
}

export interface AddDecisionInput {
  step_id?: number | null;
  chose: string;
  why: string;
  alternatives?: string[];
  permanent?: boolean;
}

export interface AddNoteInput {
  step_id: number;
  note: string;
  replace?: boolean;
}

export type PlanFilter = 'full' | 'active' | 'current' | 'decisions';

// --- Row types from DB ------------------------------------------------------

interface PlanRow {
  id: string;
  project: string;
  name: string;
  status: string;
  created_at: string;
  updated_at: string;
}

interface StepRow {
  plan_id: string;
  step_id: number;
  description: string;
  status: string;
  depends_on: string | null;
  outcome: string | null;
  blockers: string | null;
  notes: string | null;
}

interface DecisionRow {
  id: string;
  plan_id: string;
  step_id: number | null;
  chose: string;
  why: string;
  alternatives: string | null;
  permanent: number;
  decided_at: string;
}

// --- Repository -------------------------------------------------------------

export class PlanRepository {
  constructor(private db: Database.Database) {}

  /** Resolve a user/agent-typed project param — a bare name resolves to the
   *  full id when unambiguous, else passes through unchanged (fail closed). */
  resolveProject(raw: string | null | undefined): string | null | undefined {
    return resolveProjectParam(this.db, raw);
  }

  create(input: CreatePlanInput): { plan: Plan; warnings: string[] } {
    const warnings: string[] = [];
    const stepCheck = validateStepCount(input.steps.length);
    warnings.push(...stepCheck.warnings);
    if (!stepCheck.valid) {
      throw new Error(stepCheck.errors.join('; '));
    }

    // Auto-archive any existing active plan for this project
    this.archiveActive(input.project);

    const id = generateId();
    const timestamp = now();

    this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO plans (id, project, name, status, created_at, updated_at)
        VALUES (?, ?, ?, 'active', ?, ?)
      `).run(id, input.project, sanitize(input.name), timestamp, timestamp);

      const insertStep = this.db.prepare(`
        INSERT INTO plan_steps (plan_id, step_id, description, status, depends_on, outcome, blockers, notes)
        VALUES (?, ?, ?, 'pending', ?, NULL, NULL, NULL)
      `);

      for (let i = 0; i < input.steps.length; i++) {
        const step = input.steps[i];
        insertStep.run(
          id,
          i + 1,
          sanitize(step.description),
          step.depends_on ? JSON.stringify(step.depends_on) : null,
        );
      }
    })();

    return { plan: this.getById(id)!, warnings };
  }

  getById(id: string): Plan | null {
    const row = this.db.prepare('SELECT * FROM plans WHERE id = ?').get(id) as PlanRow | undefined;
    if (!row) return null;
    return this.buildPlan(row);
  }

  getActive(project: string): Plan | null {
    const row = this.db.prepare(
      "SELECT * FROM plans WHERE project = ? AND status = 'active' ORDER BY updated_at DESC LIMIT 1"
    ).get(project) as PlanRow | undefined;
    if (!row) return null;
    return this.buildPlan(row);
  }

  /** Get plan with optional filtering for token efficiency */
  getFiltered(project: string, filter: PlanFilter = 'full'): Plan | null {
    const plan = this.getActive(project);
    if (!plan) return null;

    switch (filter) {
      case 'full':
        return plan;

      case 'active':
        // Only non-done steps
        plan.steps = plan.steps.filter(s => s.status !== 'done');
        return plan;

      case 'current': {
        // Current step + next pending + recent decisions
        const current = plan.steps.find(s => s.status === 'in_progress');
        const nextPending = plan.steps.find(s => s.status === 'pending');
        plan.steps = [current, nextPending].filter((s): s is PlanStep => s !== undefined);
        // Keep only last 3 decisions
        plan.decisions = plan.decisions.slice(-3);
        return plan;
      }

      case 'decisions':
        plan.steps = [];
        return plan;
    }
  }

  updateStep(planId: string, input: UpdateStepInput): { ok: boolean; warnings: string[] } {
    const warnings: string[] = [];

    // Check dependency violations
    if (input.status === 'in_progress') {
      const step = this.getStep(planId, input.step_id);
      if (step && step.depends_on.length > 0) {
        const allSteps = this.getSteps(planId);
        const unmetDeps = step.depends_on.filter(depId => {
          const dep = allSteps.find(s => s.step_id === depId);
          return dep && dep.status !== 'done';
        });
        if (unmetDeps.length > 0) {
          warnings.push(`warn: step ${input.step_id} depends on incomplete steps [${unmetDeps.join(', ')}]`);
        }
      }
    }

    const sets: string[] = [];
    const params: (string | number)[] = [];

    if (input.status) {
      sets.push('status = ?');
      params.push(input.status);
    }
    if (input.outcome !== undefined) {
      sets.push('outcome = ?');
      params.push(sanitize(input.outcome));
    }
    if (input.blockers !== undefined) {
      sets.push('blockers = ?');
      params.push(sanitize(input.blockers));
    }

    if (sets.length === 0) return { ok: false, warnings: ['nothing to update'] };

    params.push(planId, input.step_id);

    // Optimistic locking for in_progress claims (Agent Teams support):
    // Only claim if step is still pending — prevents two teammates claiming the same step
    if (input.status === 'in_progress') {
      params.push('pending');
      const result = this.db.prepare(
        `UPDATE plan_steps SET ${sets.join(', ')} WHERE plan_id = ? AND step_id = ? AND status = ?`
      ).run(...params);
      if (result.changes === 0) {
        warnings.push(`warn: step ${input.step_id} already claimed or not pending`);
        return { ok: false, warnings };
      }
    } else {
      const result = this.db.prepare(
        `UPDATE plan_steps SET ${sets.join(', ')} WHERE plan_id = ? AND step_id = ?`
      ).run(...params);
      if (result.changes === 0) return { ok: false, warnings: ['step not found'] };
    }

    // Touch plan's updated_at
    this.touchPlan(planId);

    return { ok: true, warnings };
  }

  addDecision(planId: string, input: AddDecisionInput): PlanDecision {
    const id = generateId();
    const timestamp = now();

    this.db.prepare(`
      INSERT INTO plan_decisions (id, plan_id, step_id, chose, why, alternatives, permanent, decided_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      planId,
      input.step_id ?? null,
      sanitize(input.chose),
      sanitize(input.why),
      input.alternatives ? JSON.stringify(input.alternatives.map(a => sanitize(a))) : null,
      input.permanent ? 1 : 0,
      timestamp,
    );

    this.touchPlan(planId);

    return {
      id,
      plan_id: planId,
      step_id: input.step_id ?? null,
      chose: input.chose,
      why: input.why,
      alternatives: input.alternatives ?? [],
      permanent: input.permanent ?? false,
      decided_at: timestamp,
    };
  }

  addNote(planId: string, input: AddNoteInput): { ok: boolean; warnings: string[] } {
    const noteCheck = validateNoteContent(input.note);
    if (!noteCheck.valid) {
      return { ok: false, warnings: noteCheck.errors };
    }

    const step = this.getStep(planId, input.step_id);
    if (!step) return { ok: false, warnings: ['step not found'] };

    const entry = { note: sanitize(input.note), at: now() };
    let notes: Array<{ note: string; at: string }>;

    if (input.replace) {
      notes = [entry];
    } else {
      notes = [...step.notes, entry];
    }

    this.db.prepare(
      'UPDATE plan_steps SET notes = ? WHERE plan_id = ? AND step_id = ?'
    ).run(JSON.stringify(notes), planId, input.step_id);

    this.touchPlan(planId);
    return { ok: true, warnings: noteCheck.warnings };
  }

  addStep(planId: string, description: string, dependsOn?: number[]): { step: PlanStep; warnings: string[] } {
    const warnings: string[] = [];
    const steps = this.getSteps(planId);
    const newId = steps.length + 1;

    const totalCheck = validateStepCount(newId);
    warnings.push(...totalCheck.warnings);

    this.db.prepare(`
      INSERT INTO plan_steps (plan_id, step_id, description, status, depends_on, outcome, blockers, notes)
      VALUES (?, ?, ?, 'pending', ?, NULL, NULL, NULL)
    `).run(planId, newId, sanitize(description), dependsOn ? JSON.stringify(dependsOn) : null);

    this.touchPlan(planId);

    return {
      step: {
        plan_id: planId,
        step_id: newId,
        description,
        status: 'pending',
        depends_on: dependsOn ?? [],
        outcome: null,
        blockers: null,
        notes: [],
      },
      warnings,
    };
  }

  /** Complete plan: archive + graduate permanent decisions to memories */
  complete(planId: string): PlanDecision[] {
    this.db.prepare(
      "UPDATE plans SET status = 'completed', updated_at = ? WHERE id = ?"
    ).run(now(), planId);

    // Return permanent decisions for graduation
    const decisions = this.getDecisions(planId);
    return decisions.filter(d => d.permanent);
  }

  abandon(planId: string): void {
    this.db.prepare(
      "UPDATE plans SET status = 'abandoned', updated_at = ? WHERE id = ?"
    ).run(now(), planId);
  }

  listByProject(project: string): Plan[] {
    const rows = this.db.prepare(
      "SELECT * FROM plans WHERE project = ? ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, updated_at DESC LIMIT ?"
    ).all(project, LIMITS.MAX_PLANS_PER_PROJECT) as PlanRow[];
    return this.buildPlans(rows);
  }

  /** Transition all in_progress steps to blocked (used by SessionEnd) */
  blockInProgressSteps(project: string, reason: string): number {
    const plan = this.getActive(project);
    if (!plan) return 0;

    const result = this.db.prepare(`
      UPDATE plan_steps SET status = 'blocked', blockers = ?
      WHERE plan_id = ? AND status = 'in_progress'
    `).run(sanitize(reason), plan.id);

    if (result.changes > 0) this.touchPlan(plan.id);
    return result.changes;
  }

  // --- Private helpers ------------------------------------------------------

  private archiveActive(project: string): void {
    this.db.prepare(
      "UPDATE plans SET status = 'abandoned', updated_at = ? WHERE project = ? AND status = 'active'"
    ).run(now(), project);
  }

  private touchPlan(planId: string): void {
    this.db.prepare('UPDATE plans SET updated_at = ? WHERE id = ?').run(now(), planId);
  }

  private getStep(planId: string, stepId: number): PlanStep | null {
    const row = this.db.prepare(
      'SELECT * FROM plan_steps WHERE plan_id = ? AND step_id = ?'
    ).get(planId, stepId) as StepRow | undefined;
    return row ? this.rowToStep(row) : null;
  }

  private getSteps(planId: string): PlanStep[] {
    const rows = this.db.prepare(
      'SELECT * FROM plan_steps WHERE plan_id = ? ORDER BY step_id'
    ).all(planId) as StepRow[];
    return rows.map(r => this.rowToStep(r));
  }

  private getDecisions(planId: string): PlanDecision[] {
    const rows = this.db.prepare(
      'SELECT * FROM plan_decisions WHERE plan_id = ? ORDER BY decided_at'
    ).all(planId) as DecisionRow[];
    return rows.map(r => this.rowToDecision(r));
  }

  /** Batch build: fetch all steps + decisions for multiple plans in 2 queries instead of 2N */
  private buildPlans(rows: PlanRow[]): Plan[] {
    if (rows.length === 0) return [];

    const ids = rows.map(r => r.id);
    const placeholders = ids.map(() => '?').join(',');

    const allSteps = this.db.prepare(
      `SELECT * FROM plan_steps WHERE plan_id IN (${placeholders}) ORDER BY plan_id, step_id`
    ).all(...ids) as StepRow[];

    const allDecisions = this.db.prepare(
      `SELECT * FROM plan_decisions WHERE plan_id IN (${placeholders}) ORDER BY plan_id, decided_at`
    ).all(...ids) as DecisionRow[];

    const stepsByPlan = new Map<string, StepRow[]>();
    for (const s of allSteps) {
      const list = stepsByPlan.get(s.plan_id) ?? [];
      list.push(s);
      stepsByPlan.set(s.plan_id, list);
    }

    const decisionsByPlan = new Map<string, DecisionRow[]>();
    for (const d of allDecisions) {
      const list = decisionsByPlan.get(d.plan_id) ?? [];
      list.push(d);
      decisionsByPlan.set(d.plan_id, list);
    }

    return rows.map(row => ({
      id: row.id,
      project: row.project,
      name: row.name,
      status: row.status as PlanStatus,
      created_at: row.created_at,
      updated_at: row.updated_at,
      steps: (stepsByPlan.get(row.id) ?? []).map(r => this.rowToStep(r)),
      decisions: (decisionsByPlan.get(row.id) ?? []).map(r => this.rowToDecision(r)),
    }));
  }

  private buildPlan(row: PlanRow): Plan {
    return {
      id: row.id,
      project: row.project,
      name: row.name,
      status: row.status as PlanStatus,
      created_at: row.created_at,
      updated_at: row.updated_at,
      steps: this.getSteps(row.id),
      decisions: this.getDecisions(row.id),
    };
  }

  private rowToStep(row: StepRow): PlanStep {
    return {
      plan_id: row.plan_id,
      step_id: row.step_id,
      description: row.description,
      status: row.status as StepStatus,
      depends_on: row.depends_on ? JSON.parse(row.depends_on) : [],
      outcome: row.outcome,
      blockers: row.blockers,
      notes: row.notes ? JSON.parse(row.notes) : [],
    };
  }

  private rowToDecision(row: DecisionRow): PlanDecision {
    return {
      id: row.id,
      plan_id: row.plan_id,
      step_id: row.step_id,
      chose: row.chose,
      why: row.why,
      alternatives: row.alternatives ? JSON.parse(row.alternatives) : [],
      permanent: row.permanent === 1,
      decided_at: row.decided_at,
    };
  }
}
