import type Database from 'better-sqlite3';
import {
  decideWarningEmission, type WarningAuditObservation, type WarningDecision,
} from './warning-policy.js';
import type { ShadowResult, ShadowVerdictReason } from './verdict-types.js';

export interface CommitWarningInput {
  project: string;
  sessionId: string;
  clientName: string;
  occurredAt: string;
  fingerprint: string;
  result: ShadowResult;
  reason: ShadowVerdictReason;
  overrideAuditId: number | null;
  clampedFromBlock: boolean;
}

interface WarningRow { event_type: string; payload: string }

function history(rows: readonly WarningRow[]): WarningAuditObservation[] {
  return rows.flatMap(row => {
    try {
      const payload = JSON.parse(row.payload) as Record<string, unknown>;
      return typeof payload.fingerprint === 'string' &&
        (row.event_type === 'warning_emitted' || row.event_type === 'warning_suppressed')
        ? [{ eventType: row.event_type, fingerprint: payload.fingerprint }]
        : [];
    } catch {
      return [];
    }
  });
}

export class GovernanceWarningAuditStore {
  constructor(private readonly db: Database.Database) {}

  commit(input: CommitWarningInput): WarningDecision {
    const transaction = this.db.transaction(() => {
      const rows = this.db.prepare(`
        SELECT event_type, payload FROM governance_audit
        WHERE project = ? AND session_id = ?
          AND event_type = 'warning_emitted'
        ORDER BY id LIMIT 6
      `).all(input.project, input.sessionId) as WarningRow[];
      const decision = decideWarningEmission(input.fingerprint, history(rows));
      this.db.prepare(`
        INSERT INTO governance_audit (
          project, session_id, client_name, occurred_at, event_type, actor_class,
          redacted_detail, payload_version, payload
        ) VALUES (?, ?, ?, ?, ?, 'system', ?, 1, ?)
      `).run(
        input.project, input.sessionId, input.clientName, input.occurredAt,
        decision.auditEventType,
        decision.emit ? 'non-controlling governance warning emitted'
          : `governance warning suppressed: ${decision.reason}`,
        JSON.stringify({
          fingerprint: input.fingerprint, result: input.result, reason: input.reason,
          suppression_reason: decision.emit ? null : decision.reason,
          override_audit_id: input.overrideAuditId,
          clamped_from_block: input.clampedFromBlock,
          completion_effect: 'none', effective_mode: 'warn',
        }),
      );
      return decision;
    });
    return transaction.immediate();
  }

  incident(input: {
    project: string; sessionId: string; clientName: string; occurredAt: string; reason: string;
  }): void {
    this.db.prepare(`
      INSERT INTO governance_audit (
        project, session_id, client_name, occurred_at, event_type, actor_class,
        redacted_detail, payload_version, payload
      ) VALUES (?, ?, ?, ?, 'warning_incident', 'system', ?, 1, ?)
    `).run(
      input.project, input.sessionId, input.clientName, input.occurredAt,
      `governance warning incident: ${input.reason.slice(0, 96)}`,
      JSON.stringify({ reason: input.reason.slice(0, 96), completion_effect: 'none' }),
    );
  }
}
