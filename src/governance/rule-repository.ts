import type Database from 'better-sqlite3';
import { generateId, now, sanitize } from '../utils/index.js';

export const RULE_PHASES = ['create', 'pre_implement', 'during', 'pre_exit'] as const;
export const RULE_LEVELS = ['advise', 'warn', 'block'] as const;
export const RULE_STATUSES = ['active', 'superseded', 'disabled', 'retired'] as const;
export type RulePhase = (typeof RULE_PHASES)[number];
export type RuleLevel = (typeof RULE_LEVELS)[number];
export type RuleStatus = (typeof RULE_STATUSES)[number];

const RULE_ID = /^[a-z][a-z0-9_-]{0,63}$/;
const MAX_PROJECT_CHARS = 512;
const MAX_RULE_CONTENT_CHARS = 2_000;
const MAX_PATHS = 64;
const MAX_PATH_CHARS = 512;
const MAX_GATES = 32;

export interface RuleContext {
  schema: 1;
  record_type: 'policy';
  rule_id: string;
  revision: number;
  status: RuleStatus;
  phases: RulePhase[];
  level: RuleLevel;
  gate_ids: string[];
  scope: { project: string; paths: string[] };
  created_by: 'user-confirmed';
  supersedes: string | null;
}

export interface GovernanceRule {
  memoryId: string;
  content: string;
  project: string;
  createdAt: string;
  supersededBy: string | null;
  context: RuleContext;
}

export interface RuleConfirmation {
  userConfirmed: true;
  sessionId?: string;
  clientName?: string;
}

export interface CreateRuleInput {
  ruleId: string;
  content: string;
  project: string;
  phases: readonly RulePhase[];
  level: RuleLevel;
  gateIds?: readonly string[];
  paths?: readonly string[];
  confirmation: RuleConfirmation;
}

export type RuleRevisionInput = Omit<CreateRuleInput, 'ruleId'>;

interface RuleRow {
  id: string;
  content: string;
  project: string;
  created_at: string;
  superseded_by: string | null;
  context: string;
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function validate(input: CreateRuleInput): void {
  if (input.confirmation?.userConfirmed !== true) throw new Error('rule creation requires explicit user confirmation');
  if (!RULE_ID.test(input.ruleId)) throw new Error('invalid rule id');
  if (!input.project || input.project.length > MAX_PROJECT_CHARS || input.project.includes('\0')) {
    throw new Error('invalid rule project');
  }
  if (typeof input.content !== 'string') throw new Error('rule content must be text');
  const content = sanitize(input.content);
  if (!content || content.length > MAX_RULE_CONTENT_CHARS) throw new Error('invalid rule content length');
  if (!(RULE_LEVELS as readonly string[]).includes(input.level)) throw new Error('invalid rule level');
  const phases = unique(input.phases);
  if (phases.length === 0 || phases.length !== input.phases.length ||
      phases.some(p => !(RULE_PHASES as readonly string[]).includes(p))) {
    throw new Error('invalid rule phases');
  }
  const gateIds = unique(input.gateIds ?? []);
  if (gateIds.length > MAX_GATES || gateIds.length !== (input.gateIds ?? []).length ||
      gateIds.some(id => !RULE_ID.test(id))) {
    throw new Error('invalid rule gate ids');
  }
  const paths = unique(input.paths ?? []);
  if (paths.length > MAX_PATHS || paths.length !== (input.paths ?? []).length || paths.some(path =>
    !path || path.length > MAX_PATH_CHARS || path.startsWith('/') || path.includes('\0') ||
    path.split('/').includes('..'))) {
    throw new Error('invalid rule paths');
  }
}

function parseRow(row: RuleRow): GovernanceRule {
  const context = JSON.parse(row.context) as RuleContext;
  return {
    memoryId: row.id,
    content: row.content,
    project: row.project,
    createdAt: row.created_at,
    supersededBy: row.superseded_by,
    context,
  };
}

export class GovernanceRuleRepository {
  constructor(private readonly db: Database.Database) {}

  create(input: CreateRuleInput): GovernanceRule {
    validate(input);
    const existing = this.history(input.project, input.ruleId);
    if (existing.length > 0) throw new Error(`rule ${input.ruleId} already exists`);
    return this.insertRevision(input, input.ruleId, 1, 'active', null, 'rule_created');
  }

  activeByPhase(project: string, phase: RulePhase, maximum?: number): GovernanceRule[] {
    if (!(RULE_PHASES as readonly string[]).includes(phase)) throw new Error('invalid rule phase');
    if (maximum !== undefined && (!Number.isSafeInteger(maximum) || maximum < 1)) {
      throw new Error('invalid active rule limit');
    }
    const rows = this.db.prepare(`
      SELECT id, content, project, created_at, superseded_by, context
      FROM memories
      WHERE kind = 'rule' AND project = ? AND invalidated = 0
        AND superseded_by IS NULL
        AND json_extract(context, '$.record_type') = 'policy'
        AND json_extract(context, '$.status') = 'active'
        AND EXISTS (
          SELECT 1 FROM json_each(json_extract(context, '$.phases'))
          WHERE value = ?
        )
      ORDER BY json_extract(context, '$.rule_id'), json_extract(context, '$.revision') DESC
      ${maximum === undefined ? '' : 'LIMIT ?'}
    `).all(...(maximum === undefined ? [project, phase] : [project, phase, maximum])) as RuleRow[];
    return rows.map(parseRow);
  }

  supersede(ruleId: string, input: RuleRevisionInput): GovernanceRule {
    return this.transition(ruleId, input, 'active', 'rule_superseded', ['active']);
  }

  disable(project: string, ruleId: string, confirmation: RuleConfirmation): GovernanceRule {
    const current = this.current(project, ruleId);
    return this.transition(ruleId, copyInput(current, confirmation), 'disabled', 'rule_disabled', ['active']);
  }

  retire(project: string, ruleId: string, confirmation: RuleConfirmation): GovernanceRule {
    const current = this.current(project, ruleId);
    return this.transition(ruleId, copyInput(current, confirmation), 'retired', 'rule_retired', ['active', 'disabled']);
  }

  history(project: string, ruleId: string): GovernanceRule[] {
    const rows = this.db.prepare(`
      SELECT id, content, project, created_at, superseded_by, context
      FROM memories
      WHERE kind = 'rule' AND project = ?
        AND json_extract(context, '$.record_type') = 'policy'
        AND json_extract(context, '$.rule_id') = ?
      ORDER BY json_extract(context, '$.revision') ASC
    `).all(project, ruleId) as RuleRow[];
    return rows.map(parseRow);
  }

  private transition(
    ruleId: string,
    input: RuleRevisionInput,
    status: RuleStatus,
    eventType: string,
    allowedStatuses: readonly RuleStatus[],
  ): GovernanceRule {
    validate({ ...input, ruleId });
    const current = this.current(input.project, ruleId);
    if (!allowedStatuses.includes(current.context.status)) {
      throw new Error(`rule ${ruleId} cannot transition from ${current.context.status}`);
    }
    return this.insertRevision(
      input, ruleId, current.context.revision + 1, status, current.memoryId, eventType,
    );
  }

  private current(project: string, ruleId: string): GovernanceRule {
    const row = this.db.prepare(`
      SELECT id, content, project, created_at, superseded_by, context
      FROM memories
      WHERE kind = 'rule' AND project = ? AND superseded_by IS NULL
        AND json_extract(context, '$.record_type') = 'policy'
        AND json_extract(context, '$.rule_id') = ?
      LIMIT 1
    `).get(project, ruleId) as RuleRow | undefined;
    if (!row) throw new Error(`active rule ${ruleId} not found`);
    return parseRow(row);
  }

  private insertRevision(
    input: CreateRuleInput | RuleRevisionInput,
    ruleId: string,
    revision: number,
    status: RuleStatus,
    supersedes: string | null,
    eventType: string,
  ): GovernanceRule {
    const id = generateId();
    const timestamp = now();
    const context = {
      schema: 1, record_type: 'policy', rule_id: ruleId, revision, status,
      phases: unique(input.phases), level: input.level,
      gate_ids: unique(input.gateIds ?? []),
      scope: { project: input.project, paths: unique(input.paths ?? []) },
      created_by: 'user-confirmed', supersedes,
    } satisfies RuleContext;
    const run = this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO memories (
          id, content, kind, project, tags, confidence, source, created_at,
          recall_count, invalidated, context, expires_at
        ) VALUES (?, ?, 'rule', ?, ?, 1.0, 'confirmed', ?, 0, 0, ?, NULL)
      `).run(id, sanitize(input.content), input.project, '["governance:rule"]', timestamp, JSON.stringify(context));
      if (supersedes) {
        const changed = this.db.prepare(`
          UPDATE memories SET superseded_by = ?, superseded_at = ?
          WHERE id = ? AND kind = 'rule' AND superseded_by IS NULL
        `).run(id, timestamp, supersedes).changes;
        if (changed !== 1) throw new Error('rule revision race');
      }
      this.db.prepare(`
        INSERT INTO governance_audit (
          project, session_id, client_name, occurred_at, event_type, actor_class,
          redacted_detail, linked_rule_id, linked_rule_memory_id, payload_version, payload
        ) VALUES (?, ?, ?, ?, ?, 'user-confirmed', ?, ?, ?, 1, ?)
      `).run(
        input.project, input.confirmation.sessionId ?? null,
        input.confirmation.clientName ?? null, timestamp, eventType,
        `rule ${ruleId} revision ${revision}: ${status}`, ruleId, id,
        JSON.stringify({ revision, status, supersedes }),
      );
    });
    run.immediate();
    return this.history(input.project, ruleId).at(-1)!;
  }
}

function copyInput(rule: GovernanceRule, confirmation: RuleConfirmation): RuleRevisionInput {
  return {
    content: rule.content, project: rule.project, phases: rule.context.phases,
    level: rule.context.level, gateIds: rule.context.gate_ids,
    paths: rule.context.scope.paths, confirmation,
  };
}
