/**
 * Governance retention: evidence cleanup (never an audit-referenced event)
 * and the explicit, confirmed lifecycle cleanup of retired rule families.
 * Split from repository.ts (phase 4).
 */
import type Database from 'better-sqlite3';
import { MS_PER_DAY } from '../constants/time.js';
import {
  EVIDENCE_RETENTION_DAYS, evidenceDaysOutOfRange, evidenceRangeMessage, json, persistedEvidenceDays,
} from './recorder-store.js';
import type {
  GovernanceEvidenceCleanupOptions, GovernanceEvidenceCleanupResult,
  GovernanceLifecycleCleanupOptions, GovernanceLifecycleCleanupResult,
} from './repository-types.js';

/** Evidence cleanup is transactional and never removes an audit-referenced event. */
export function cleanupEvidence(
  db: Database.Database, options: GovernanceEvidenceCleanupOptions = {},
): GovernanceEvidenceCleanupResult {
  const defaultDays = options.evidenceDays ?? EVIDENCE_RETENTION_DAYS.DEFAULT;
  if (evidenceDaysOutOfRange(defaultDays)) {
    throw new Error(evidenceRangeMessage());
  }
  const nowMs = options.nowMs ?? Date.now();
  const projects = db.prepare(`
    SELECT DISTINCT project FROM governance_tool_events
    UNION SELECT DISTINCT project FROM governance_gate_runs
  `).all() as Array<{ project: string }>;
  let gateRunsDeleted = 0;
  let toolEventsDeleted = 0;
  let projectsAudited = 0;
  const transaction = db.transaction(() => {
    for (const { project } of projects) {
      const days = options.projectDays?.[project] ?? persistedEvidenceDays(db, project) ?? defaultDays;
      if (evidenceDaysOutOfRange(days)) {
        throw new Error(`invalid evidence retention for project ${project}`);
      }
      const cutoff = new Date(nowMs - days * MS_PER_DAY).toISOString();
      const runs = db.prepare(`
        DELETE FROM governance_gate_runs WHERE project = ? AND created_at < ?
      `).run(project, cutoff).changes;
      const events = db.prepare(`
        DELETE FROM governance_tool_events
        WHERE project = ? AND created_at < ?
          AND NOT EXISTS (
            SELECT 1 FROM governance_gate_runs r
            WHERE r.event_seq = governance_tool_events.event_seq
          )
          AND NOT EXISTS (
            SELECT 1 FROM governance_audit a
            WHERE a.linked_event_seq = governance_tool_events.event_seq
          )
      `).run(project, cutoff).changes;
      gateRunsDeleted += runs;
      toolEventsDeleted += events;
      if (runs > 0 || events > 0) {
        db.prepare(`
          INSERT INTO governance_audit (
            project, occurred_at, event_type, actor_class, redacted_detail,
            payload_version, payload
          ) VALUES (?, ?, 'retention_run', 'system', ?, 1, ?)
        `).run(
          project, new Date(nowMs).toISOString(),
          `evidence retention removed ${runs} gate run(s) and ${events} event(s)`,
          json({ evidenceDays: days, gateRunsDeleted: runs, toolEventsDeleted: events }),
        );
        projectsAudited += 1;
      }
    }
  });
  transaction.immediate();
  return { gateRunsDeleted, toolEventsDeleted, projectsAudited };
}

/**
 * Explicit project cleanup for shortened audit/rule ceilings. Only fully
 * retired rule families are removable; active/disabled families and every
 * audit row needed to explain them remain intact. A retired family becomes
 * eligible by its latest revision's age; all family revisions and linked
 * audit rows are then pruned together, never by each audit row's own age.
 */
export function cleanupLifecycle(
  db: Database.Database, options: GovernanceLifecycleCleanupOptions,
): GovernanceLifecycleCleanupResult {
  if (options.confirmed !== true) throw new Error('lifecycle cleanup requires explicit confirmation');
  for (const [name, days] of [['audit', options.auditDays], ['rule', options.ruleDays]] as const) {
    if (!Number.isInteger(days) || days < 1 || days > 3_650) {
      throw new Error(`${name} retention must be 1..3650 days`);
    }
  }
  const nowMs = options.nowMs ?? Date.now();
  const auditCutoff = new Date(nowMs - options.auditDays * MS_PER_DAY).toISOString();
  const jointCutoff = new Date(
    nowMs - Math.max(options.auditDays, options.ruleDays) * MS_PER_DAY,
  ).toISOString();
  let rulesDeleted = 0;
  let auditRowsDeleted = 0;
  const transaction = db.transaction(() => {
    const retired = db.prepare(`
      SELECT json_extract(context, '$.rule_id') AS rule_id
      FROM memories
      WHERE project = ? AND kind = 'rule' AND superseded_by IS NULL
        AND json_extract(context, '$.record_type') = 'policy'
        AND json_extract(context, '$.status') = 'retired'
        AND created_at < ?
    `).all(options.project, jointCutoff) as Array<{ rule_id: string }>;
    for (const { rule_id: ruleId } of retired) {
      auditRowsDeleted += db.prepare(`
        DELETE FROM governance_audit WHERE project = ? AND linked_rule_id = ?
      `).run(options.project, ruleId).changes;
      rulesDeleted += db.prepare(`
        DELETE FROM memories
        WHERE project = ? AND kind = 'rule'
          AND json_extract(context, '$.record_type') = 'policy'
          AND json_extract(context, '$.rule_id') = ?
      `).run(options.project, ruleId).changes;
    }
    auditRowsDeleted += db.prepare(`
      DELETE FROM governance_audit AS audit
      WHERE audit.project = ? AND audit.occurred_at < ?
        AND (
          audit.linked_rule_id IS NULL OR NOT EXISTS (
            SELECT 1 FROM memories AS rule
            WHERE rule.project = audit.project AND rule.kind = 'rule'
              AND json_extract(rule.context, '$.record_type') = 'policy'
              AND json_extract(rule.context, '$.rule_id') = audit.linked_rule_id
          )
        )
    `).run(options.project, auditCutoff).changes;
    if (rulesDeleted > 0 || auditRowsDeleted > 0) {
      db.prepare(`
        INSERT INTO governance_audit (
          project, occurred_at, event_type, actor_class, redacted_detail,
          payload_version, payload
        ) VALUES (?, ?, 'lifecycle_retention_run', 'user-confirmed', ?, 1, ?)
      `).run(
        options.project, new Date(nowMs).toISOString(),
        `explicit lifecycle retention removed ${rulesDeleted} rule revision(s) and ${auditRowsDeleted} audit row(s)`,
        json({
          auditDays: options.auditDays, ruleDays: options.ruleDays,
          rulesDeleted, auditRowsDeleted,
        }),
      );
    }
  });
  transaction.immediate();
  return { rulesDeleted, auditRowsDeleted };
}
