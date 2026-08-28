import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { generateId } from '../utils/index.js';
import {
  GOVERNANCE_OVERRIDE_MAX_DURATION_MS,
  GOVERNANCE_OVERRIDE_PAYLOAD_VERSION,
  validateGovernanceOverride,
  type GovernanceOverrideCandidate,
  type GovernanceOverrideContext,
  type GovernanceOverrideRuleBinding,
  type OverrideValidation,
} from './override-validator.js';

export const GOVERNANCE_OVERRIDE_EVENT = 'governance_override_created';
export const GOVERNANCE_OVERRIDE_INCIDENT_EVENT = 'governance_override_incident';
export const GOVERNANCE_OVERRIDE_DEFAULT_DURATION_MS = GOVERNANCE_OVERRIDE_MAX_DURATION_MS;

export interface CreateGovernanceOverrideInput {
  project: string;
  sessionId: string;
  clientName: string;
  configSha256: string;
  worktreeDigest: string;
  rules: readonly GovernanceOverrideRuleBinding[];
  gateIds: readonly string[];
  reason: string;
  confirmation: { userConfirmed: true; mechanism: 'mcp-elicitation' };
  durationMs?: number;
  nowMs?: number;
  /** Test-only fault point proving that the fact and audit row are atomic. */
  failAuditWrite?: boolean;
}

export interface CreatedGovernanceOverride {
  auditId: number;
  factMemoryId: string;
  issuedAt: string;
  expiresAt: string;
}

export type GovernanceOverrideRead =
  | { status: 'none'; candidate: null; validation: null }
  | { status: 'self_error'; candidate: null; validation: null }
  | { status: 'invalid'; candidate: GovernanceOverrideCandidate | null; validation: OverrideValidation }
  | { status: 'valid'; candidate: GovernanceOverrideCandidate; validation: OverrideValidation };

interface OverrideAuditRow {
  id: number;
  actor_class: string;
  payload_version: number;
  payload: string;
  linked_fact_valid: number;
  event_type: string;
}

function redactedReason(reason: string): string {
  const bounded = reason.trim().slice(0, 500);
  if (!bounded) throw new Error('override reason is required');
  return bounded
    .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/giu, '[REDACTED KEY]')
    .replace(/\b(api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/giu, '$1=[REDACTED]');
}

function stable<T>(values: readonly T[], key: (value: T) => string): T[] {
  return [...values].sort((left, right) => key(left).localeCompare(key(right)));
}

function payloadCandidate(row: OverrideAuditRow): GovernanceOverrideCandidate | null {
  try {
    const payload = JSON.parse(row.payload) as Omit<GovernanceOverrideCandidate, 'auditId' | 'actorClass'>;
    return {
      ...payload,
      auditId: row.id,
      actorClass: row.actor_class as GovernanceOverrideCandidate['actorClass'],
      payloadVersion: row.payload_version as typeof GOVERNANCE_OVERRIDE_PAYLOAD_VERSION,
    };
  } catch {
    return null;
  }
}

export class GovernanceOverrideStore {
  constructor(private readonly db: Database.Database) {}

  create(input: CreateGovernanceOverrideInput): CreatedGovernanceOverride {
    if (input.confirmation?.userConfirmed !== true || input.confirmation.mechanism !== 'mcp-elicitation') {
      throw new Error('override requires interactive user confirmation');
    }
    const durationMs = input.durationMs ?? GOVERNANCE_OVERRIDE_DEFAULT_DURATION_MS;
    if (!Number.isSafeInteger(durationMs) || durationMs <= 0 ||
        durationMs > GOVERNANCE_OVERRIDE_MAX_DURATION_MS) {
      throw new Error('override duration must be 1 ms..24 h');
    }
    const reason = redactedReason(input.reason);
    const nowMs = input.nowMs ?? Date.now();
    const issuedAt = new Date(nowMs).toISOString();
    const expiresAt = new Date(nowMs + durationMs).toISOString();
    const rules = stable(input.rules, rule => `${rule.ruleId}\0${rule.revision}`);
    const gateIds = stable(input.gateIds, gate => gate);
    const bindingCheck = validateGovernanceOverride({
      auditId: 1, payloadVersion: GOVERNANCE_OVERRIDE_PAYLOAD_VERSION,
      actorClass: 'user-confirmed', project: input.project, sessionId: input.sessionId,
      configSha256: input.configSha256, worktreeDigest: input.worktreeDigest,
      rules, gateIds, issuedAt, expiresAt,
    }, {
      project: input.project, sessionId: input.sessionId,
      configSha256: input.configSha256, worktreeDigest: input.worktreeDigest,
      rules, gateIds, nowMs,
    });
    if (!bindingCheck.valid) throw new Error(`invalid override binding: ${bindingCheck.reason}`);
    const factMemoryId = generateId();
    const transaction = this.db.transaction((): CreatedGovernanceOverride => {
      this.db.prepare(`
        INSERT INTO memories (
          id, content, kind, project, tags, confidence, source, created_at,
          recall_count, invalidated, expires_at, context
        ) VALUES (?, ?, 'fact', ?, ?, 1, 'confirmed', ?, 0, 0, ?, ?)
      `).run(
        factMemoryId,
        `Temporary governance override for ${rules.map(rule => rule.ruleId).join(', ')}`,
        input.project, JSON.stringify(['governance:override', 'audit']), issuedAt, expiresAt,
        JSON.stringify({ record_type: 'governance_override_summary', audit_id: null }),
      );
      if (input.failAuditWrite) throw new Error('injected governance override audit failure');
      const payload = {
        project: input.project, sessionId: input.sessionId,
        configSha256: input.configSha256, worktreeDigest: input.worktreeDigest,
        rules, gateIds, issuedAt, expiresAt, reason,
        confirmationMechanism: input.confirmation.mechanism,
        localUid: typeof process.getuid === 'function' ? process.getuid() : null,
        clientName: input.clientName,
        bindingSha256: createHash('sha256').update(JSON.stringify({
          project: input.project, sessionId: input.sessionId, configSha256: input.configSha256,
          worktreeDigest: input.worktreeDigest, rules, gateIds,
        })).digest('hex'),
      };
      const result = this.db.prepare(`
        INSERT INTO governance_audit (
          project, session_id, client_name, occurred_at, event_type, actor_class,
          redacted_detail, linked_rule_memory_id, payload_version, payload
        ) VALUES (?, ?, ?, ?, ?, 'user-confirmed', ?, ?, ?, ?)
      `).run(
        input.project, input.sessionId, input.clientName, issuedAt, GOVERNANCE_OVERRIDE_EVENT,
        `temporary override confirmed for ${rules.length} rule(s), ${gateIds.length} gate(s): ${reason}`,
        factMemoryId, GOVERNANCE_OVERRIDE_PAYLOAD_VERSION, JSON.stringify(payload),
      );
      const auditId = Number(result.lastInsertRowid);
      this.db.prepare(`UPDATE memories SET context = ? WHERE id = ?`).run(
        JSON.stringify({ record_type: 'governance_override_summary', audit_id: auditId }),
        factMemoryId,
      );
      return { auditId, factMemoryId, issuedAt, expiresAt };
    });
    try {
      return transaction.immediate();
    } catch (error) {
      try {
        this.db.prepare(`
          INSERT INTO governance_audit (
            project, session_id, client_name, occurred_at, event_type, actor_class,
            redacted_detail, payload_version, payload
          ) VALUES (?, ?, ?, ?, ?, 'system', 'override audit write failed', 1, ?)
        `).run(
          input.project, input.sessionId, input.clientName, issuedAt,
          GOVERNANCE_OVERRIDE_INCIDENT_EVENT,
          JSON.stringify({ fault: 'audit_write_failed', confirmation_mechanism: 'mcp-elicitation' }),
        );
      } catch { /* the audit store itself may be unavailable */ }
      throw error;
    }
  }

  latest(context: GovernanceOverrideContext): GovernanceOverrideRead {
    const row = this.db.prepare(`
      SELECT audit.id, audit.actor_class, audit.payload_version, audit.payload, audit.event_type,
        EXISTS (
          SELECT 1 FROM memories AS fact
          WHERE fact.id = audit.linked_rule_memory_id AND fact.kind = 'fact'
            AND fact.invalidated = 0
            AND EXISTS (SELECT 1 FROM json_each(fact.tags) WHERE value = 'governance:override')
        ) AS linked_fact_valid
      FROM governance_audit AS audit
      WHERE audit.project = ? AND audit.session_id = ?
        AND audit.event_type IN (?, ?)
      ORDER BY audit.id DESC LIMIT 1
    `).get(
      context.project, context.sessionId, GOVERNANCE_OVERRIDE_EVENT,
      GOVERNANCE_OVERRIDE_INCIDENT_EVENT,
    ) as OverrideAuditRow | undefined;
    if (!row) return { status: 'none', candidate: null, validation: null };
    if (row.event_type === GOVERNANCE_OVERRIDE_INCIDENT_EVENT) {
      return { status: 'self_error', candidate: null, validation: null };
    }
    const candidate = payloadCandidate(row);
    if (!candidate || row.linked_fact_valid !== 1) {
      return { status: 'invalid', candidate: null, validation: { valid: false, reason: 'malformed' } };
    }
    let validation: OverrideValidation;
    try {
      validation = validateGovernanceOverride(candidate, context);
    } catch {
      validation = { valid: false, reason: 'malformed' };
    }
    return validation.valid
      ? { status: 'valid', candidate, validation }
      : { status: 'invalid', candidate, validation };
  }
}
