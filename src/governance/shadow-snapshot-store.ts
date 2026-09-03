/**
 * Shadow snapshot store: the one-snapshot read of every evaluator input and
 * the first-seen rule-revision watermarks. Split from repository.ts (phase 4).
 */
import type Database from 'better-sqlite3';
import type { GateRunEvidence } from './evidence-selector.js';
import { GovernanceRuleRepository } from './rule-repository.js';
import {
  SHADOW_REPOSITORY_LIMITS, SHADOW_RULE_WATERMARK_PAYLOAD_VERSION, ShadowRepositoryError,
  type EnsureShadowWatermarksInput, type EnsureShadowWatermarksResult,
  type ShadowEvaluationSnapshot, type ShadowRuleWatermark, type ShadowSnapshotOptions,
} from './repository-types.js';
import { json } from './recorder-store.js';
import {
  boundedIdentifier, booleanOrNull, capabilityRow, parseAffectedPaths, parseRule, parseWatermark,
  shadowFault, shadowSequence,
  type ShadowCapabilityDbRow, type ShadowEventRow, type ShadowGateRunRow, type ShadowWatermarkRow,
} from './shadow-rows.js';

/** Read all evaluator inputs from one deferred SQLite snapshot. */
export function readShadowSnapshot(db: Database.Database, options: ShadowSnapshotOptions): ShadowEvaluationSnapshot {
  try {
    const read = db.transaction((): ShadowEvaluationSnapshot => {
      let authorityRules: ReturnType<GovernanceRuleRepository['activeByPhase']>;
      try {
        authorityRules = new GovernanceRuleRepository(db).activeByPhase(
          options.project, 'pre_exit', SHADOW_REPOSITORY_LIMITS.activeRules + 1,
        );
      } catch (error) {
        if (error instanceof SyntaxError ||
            (error instanceof Error && error.message.toLowerCase().includes('malformed json'))) {
          throw new ShadowRepositoryError('rule_malformed', 'active rule context is not JSON');
        }
        throw error;
      }
      if (authorityRules.length > SHADOW_REPOSITORY_LIMITS.activeRules) {
        throw new ShadowRepositoryError('serialization_bound_exceeded', 'active rule bound exceeded');
      }
      const rules = authorityRules.map(rule => parseRule(
        rule.memoryId, options.project, rule.context as unknown as Record<string, unknown>,
      ));
      options.onReadStage?.('rules');

      const watermarkRows = db.prepare(`
        SELECT audit.id, audit.linked_rule_id, audit.payload_version, audit.payload
        FROM governance_audit AS audit
        JOIN memories AS rule ON rule.id = audit.linked_rule_memory_id
        WHERE audit.project = ? AND audit.event_type = 'shadow_rule_watermark'
          AND rule.kind = 'rule' AND rule.project = audit.project
          AND rule.invalidated = 0 AND rule.superseded_by IS NULL
          AND json_extract(rule.context, '$.record_type') = 'policy'
          AND json_extract(rule.context, '$.status') = 'active'
          AND EXISTS (
            SELECT 1 FROM json_each(json_extract(rule.context, '$.phases'))
            WHERE value = 'pre_exit'
          )
        ORDER BY audit.id
        LIMIT ?
      `).all(
        options.project, SHADOW_REPOSITORY_LIMITS.activeRules * 2 + 1,
      ) as ShadowWatermarkRow[];
      if (watermarkRows.length > SHADOW_REPOSITORY_LIMITS.activeRules * 2) {
        throw new ShadowRepositoryError('serialization_bound_exceeded', 'rule watermark bound exceeded');
      }
      const watermarks = watermarkRows.map(parseWatermark);
      for (const rule of rules) {
        const matching = watermarks.filter(watermark =>
          watermark.ruleId === rule.ruleId && watermark.revision === rule.revision);
        if (matching.length > 1) {
          throw new ShadowRepositoryError('evidence_malformed', 'duplicate rule watermark');
        }
        rule.watermark = matching[0] ?? null;
      }
      options.onReadStage?.('watermarks');

      const sequence = shadowSequence(db, options.project);
      options.onReadStage?.('sequences');

      const capability = capabilityRow(db.prepare(`
        SELECT project, client_installation_id, client_name, client_version,
          supports_post_tool_use, supports_post_tool_failure, supports_file_changed,
          supports_structured_output, supports_stop, supports_blocking, adapter_version,
          settings_source, last_session_id, last_heartbeat_at, last_probe_result
        FROM governance_client_state
        WHERE project = ? AND client_installation_id = ?
      `).get(options.project, options.clientInstallationId) as ShadowCapabilityDbRow | undefined);
      options.onReadStage?.('capability');

      const eventRows = db.prepare(`
        SELECT event_seq, mutation_seq, mutation_class, affected_paths
        FROM governance_tool_events
        WHERE project = ? AND session_id = ?
        ORDER BY event_seq
        LIMIT ?
      `).all(
        options.project, options.sessionId, SHADOW_REPOSITORY_LIMITS.sessionEvents + 1,
      ) as ShadowEventRow[];
      if (eventRows.length > SHADOW_REPOSITORY_LIMITS.sessionEvents) {
        throw new ShadowRepositoryError('serialization_bound_exceeded', 'session event bound exceeded');
      }
      const events = eventRows.map(parseAffectedPaths);
      options.onReadStage?.('events');

      const gateRows = db.prepare(`
        SELECT gate_id, event_seq, mutation_seq, config_sha256, parser_name, parser_version,
          test_total, test_pass, test_fail, test_skip, skip_reasons_complete,
          worktree_digest, digest_version, relevant_paths_sha256, capture_result
        FROM governance_gate_runs
        WHERE project = ? AND session_id = ? AND config_sha256 = ?
        ORDER BY event_seq DESC, gate_id
        LIMIT ?
      `).all(
        options.project, options.sessionId, options.configSha256,
        SHADOW_REPOSITORY_LIMITS.candidateGateRuns + 1,
      ) as ShadowGateRunRow[];
      if (gateRows.length > SHADOW_REPOSITORY_LIMITS.candidateGateRuns) {
        throw new ShadowRepositoryError('serialization_bound_exceeded', 'candidate gate-run bound exceeded');
      }
      const gateRuns: GateRunEvidence[] = gateRows.map(row => ({
        gateId: row.gate_id, eventSeq: row.event_seq, mutationSeq: row.mutation_seq,
        configSha256: row.config_sha256, parserName: row.parser_name,
        parserVersion: row.parser_version, testTotal: row.test_total, testPass: row.test_pass,
        testFail: row.test_fail, testSkip: row.test_skip,
        skipReasonsComplete: booleanOrNull(row.skip_reasons_complete),
        worktreeDigest: row.worktree_digest, digestVersion: row.digest_version,
        relevantPathsSha256: row.relevant_paths_sha256, captureResult: row.capture_result,
      }));
      options.onReadStage?.('gate-runs');
      return {
        project: options.project, sessionId: options.sessionId,
        configSha256: options.configSha256, sequence, rules, events, gateRuns, capability,
      };
    });
    return read.deferred();
  } catch (error) {
    if (error instanceof ShadowRepositoryError) throw error;
    throw new ShadowRepositoryError(shadowFault(error), 'shadow snapshot read failed');
  }
}

/** Create first-seen rule revision watermarks in one serialized transaction. */
export function ensureShadowRuleWatermarks(db: Database.Database, input: EnsureShadowWatermarksInput): EnsureShadowWatermarksResult {
  if (input.rules.length > SHADOW_REPOSITORY_LIMITS.activeRules) {
    throw new ShadowRepositoryError('serialization_bound_exceeded', 'active rule bound exceeded');
  }
  const identities = input.rules.map(rule => `${rule.ruleId}:${rule.revision}`);
  if (new Set(identities).size !== identities.length || input.rules.some(rule =>
    !boundedIdentifier(rule.ruleId) || !boundedIdentifier(rule.memoryId) ||
    !Number.isSafeInteger(rule.revision) || rule.revision < 1)) {
    throw new ShadowRepositoryError('rule_malformed', 'invalid rule watermark input');
  }
  try {
    const write = db.transaction((): EnsureShadowWatermarksResult => {
      const sequence = shadowSequence(db, input.project);
      const existingRows = db.prepare(`
        SELECT audit.id, audit.linked_rule_id, audit.payload_version, audit.payload
        FROM governance_audit AS audit
        JOIN memories AS rule ON rule.id = audit.linked_rule_memory_id
        WHERE audit.project = ? AND audit.event_type = 'shadow_rule_watermark'
          AND rule.kind = 'rule' AND rule.project = audit.project
          AND rule.invalidated = 0 AND rule.superseded_by IS NULL
          AND json_extract(rule.context, '$.record_type') = 'policy'
          AND json_extract(rule.context, '$.status') = 'active'
          AND EXISTS (
            SELECT 1 FROM json_each(json_extract(rule.context, '$.phases'))
            WHERE value = 'pre_exit'
          )
        ORDER BY audit.id
        LIMIT ?
      `).all(
        input.project, SHADOW_REPOSITORY_LIMITS.activeRules * 2 + 1,
      ) as ShadowWatermarkRow[];
      if (existingRows.length > SHADOW_REPOSITORY_LIMITS.activeRules * 2) {
        throw new ShadowRepositoryError('serialization_bound_exceeded', 'rule watermark bound exceeded');
      }
      const existing = existingRows.map(parseWatermark);
      let created = 0;
      let requiresRefresh = false;
      const result: ShadowRuleWatermark[] = [];
      const insert = db.prepare(`
        INSERT INTO governance_audit (
          project, occurred_at, event_type, actor_class, redacted_detail,
          linked_rule_id, linked_rule_memory_id, payload_version, payload
        ) VALUES (?, ?, 'shadow_rule_watermark', 'system', ?, ?, ?, ?, ?)
      `);
      for (const rule of input.rules) {
        const matching = existing.filter(watermark =>
          watermark.ruleId === rule.ruleId && watermark.revision === rule.revision);
        if (matching.length > 1) {
          throw new ShadowRepositoryError('evidence_malformed', 'duplicate rule watermark');
        }
        if (matching.length === 1) {
          result.push(matching[0]);
          continue;
        }
        const current = db.prepare(`
          SELECT id FROM memories
          WHERE id = ? AND project = ? AND kind = 'rule' AND invalidated = 0
            AND superseded_by IS NULL
            AND json_extract(context, '$.record_type') = 'policy'
            AND json_extract(context, '$.status') = 'active'
            AND json_extract(context, '$.rule_id') = ?
            AND json_extract(context, '$.revision') = ?
            AND EXISTS (
              SELECT 1 FROM json_each(json_extract(context, '$.phases'))
              WHERE value = 'pre_exit'
            )
        `).get(rule.memoryId, input.project, rule.ruleId, rule.revision) as { id: string } | undefined;
        if (current === undefined) {
          requiresRefresh = true;
          continue;
        }
        const payload = json({
          rule_id: rule.ruleId, revision: rule.revision,
          event_seq: sequence.eventSeq, mutation_seq: sequence.mutationSeq,
        });
        let inserted: Database.RunResult;
        try {
          inserted = insert.run(
            input.project, input.occurredAt,
            `first observed rule ${rule.ruleId} revision ${rule.revision}`,
            rule.ruleId, rule.memoryId, SHADOW_RULE_WATERMARK_PAYLOAD_VERSION, payload,
          );
        } catch {
          throw new ShadowRepositoryError('audit_write_failed', 'rule watermark audit insert failed');
        }
        result.push({
          auditId: Number(inserted.lastInsertRowid), ruleId: rule.ruleId,
          revision: rule.revision, ...sequence,
        });
        created += 1;
        requiresRefresh = true;
      }
      return { watermarks: result, sequence, created, requiresRefresh };
    });
    return write.immediate();
  } catch (error) {
    if (error instanceof ShadowRepositoryError) throw error;
    const fault = shadowFault(error);
    throw new ShadowRepositoryError(
      fault === 'unexpected_error' ? 'audit_write_failed' : fault,
      'shadow watermark write failed',
    );
  }
}
