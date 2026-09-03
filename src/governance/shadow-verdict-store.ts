/**
 * Shadow verdict persistence: the bounded verdict payload, the sequence
 * re-check, and the audit insert that shares one immediate transaction with
 * it. Split from repository.ts (phase 4).
 */
import type Database from 'better-sqlite3';
import {
  CAPABILITY_DEGRADATION_REASONS, GATE_EVIDENCE_STATES, SHADOW_FAULT_CODES, SHADOW_RESULTS,
  SHADOW_VERDICT_PAYLOAD_VERSION,
} from './verdict-types.js';
import {
  SHADOW_REPOSITORY_LIMITS, ShadowRepositoryError,
  type ShadowSequence, type ShadowSequenceCheckResult, type ShadowStopVerdictAuditInput,
  type ShadowVerdictPersistenceResult,
} from './repository-types.js';
import { json } from './recorder-store.js';
import { SHADOW_REASON, SHADOW_VERDICT_REASONS, boundedIdentifier, shadowFault, shadowSequence } from './shadow-rows.js';

function assertUniqueBounded(values: readonly string[], maximum: number): void {
  if (values.length > maximum || new Set(values).size !== values.length ||
      values.some(value => !boundedIdentifier(value))) {
    throw new ShadowRepositoryError('serialization_bound_exceeded', 'verdict identifier bound exceeded');
  }
}

function validatedVerdictPayload(input: ShadowStopVerdictAuditInput): string {
  const configUnavailable = input.result === 'self_error' && input.fault !== null && [
    'config_missing', 'config_invalid', 'config_oversized', 'config_path_escape',
  ].includes(input.fault);
  const validConfigCoordinates = input.configVersion !== null && input.configSha256 !== null &&
    Number.isSafeInteger(input.configVersion) && input.configVersion >= 1 &&
    /^[a-f0-9]{64}$/u.test(input.configSha256);
  const validUnavailableCoordinates = configUnavailable &&
    (input.configVersion === null ||
      (Number.isSafeInteger(input.configVersion) && input.configVersion >= 1)) &&
    (input.configSha256 === null || /^[a-f0-9]{64}$/u.test(input.configSha256));
  assertUniqueBounded(input.requiredGateIds, SHADOW_REPOSITORY_LIMITS.requiredGates);
  assertUniqueBounded(input.capabilityReasons, SHADOW_REPOSITORY_LIMITS.capabilityReasons);
  assertUniqueBounded(input.gates.map(gate => gate.gateId), SHADOW_REPOSITORY_LIMITS.requiredGates);
  if (!boundedIdentifier(input.project) || !boundedIdentifier(input.sessionId) ||
      !boundedIdentifier(input.clientName) ||
      (!validConfigCoordinates && !validUnavailableCoordinates) ||
      !['advise', 'warn', 'block'].includes(input.intent) || !['shadow', 'warn'].includes(input.mode) || !['shadow', 'advisory', 'warn'].includes(input.effectiveMode) || input.completionEffect !== 'none' ||
      !(SHADOW_RESULTS as readonly string[]).includes(input.result) ||
      !SHADOW_VERDICT_REASONS.has(input.reason) ||
      (input.fault !== null && !(SHADOW_FAULT_CODES as readonly string[]).includes(input.fault)) ||
      input.capabilityReasons.some(reason =>
        !(CAPABILITY_DEGRADATION_REASONS as readonly string[]).includes(reason)) ||
      typeof input.stopHookActive !== 'boolean' || ![0, 1].includes(input.retryCount) ||
      typeof input.occurredAt !== 'string' || input.occurredAt.length > 40 ||
      !Number.isFinite(Date.parse(input.occurredAt)) ||
      !Number.isSafeInteger(input.evaluatorVersion) || input.evaluatorVersion < 1 ||
      !Number.isSafeInteger(input.digestVersion) || input.digestVersion < 1 ||
      input.rules.length > SHADOW_REPOSITORY_LIMITS.activeRules ||
      input.gates.length > SHADOW_REPOSITORY_LIMITS.requiredGates ||
      !Number.isSafeInteger(input.elapsedMs) || input.elapsedMs < 0 ||
      input.elapsedMs > SHADOW_REPOSITORY_LIMITS.elapsedMs ||
      !Number.isSafeInteger(input.evaluatedThrough.eventSeq) || input.evaluatedThrough.eventSeq < 0 ||
      !Number.isSafeInteger(input.evaluatedThrough.mutationSeq) || input.evaluatedThrough.mutationSeq < 0) {
    throw new ShadowRepositoryError('serialization_bound_exceeded', 'verdict scalar bound exceeded');
  }
  assertUniqueBounded(input.rules.map(rule => rule.ruleId), SHADOW_REPOSITORY_LIMITS.activeRules);
  for (const rule of input.rules) {
    if (!boundedIdentifier(rule.ruleId) || !boundedIdentifier(rule.memoryId) ||
        !Number.isSafeInteger(rule.revision) || rule.revision < 1 ||
        !Number.isSafeInteger(rule.watermarkEventSeq) || rule.watermarkEventSeq < 0 ||
        !Number.isSafeInteger(rule.watermarkMutationSeq) || rule.watermarkMutationSeq < 0) {
      throw new ShadowRepositoryError('serialization_bound_exceeded', 'verdict rule bound exceeded');
    }
  }
  for (const gate of input.gates) {
    if (!boundedIdentifier(gate.gateId) || !SHADOW_REASON.test(gate.reason) ||
        !(GATE_EVIDENCE_STATES as readonly string[]).includes(gate.state) ||
        !input.requiredGateIds.includes(gate.gateId) ||
        (gate.parserName !== null && !boundedIdentifier(gate.parserName)) ||
        (gate.captureResult !== null &&
          !['complete', 'failed', 'incomplete', 'adapter_error'].includes(gate.captureResult)) ||
        (gate.parserVersion !== null &&
          (!Number.isSafeInteger(gate.parserVersion) || gate.parserVersion < 1)) ||
        (gate.digestVersion !== null &&
          (!Number.isSafeInteger(gate.digestVersion) || gate.digestVersion < 1)) ||
        (gate.evidenceEventSeq !== null && (!Number.isSafeInteger(gate.evidenceEventSeq) ||
          gate.evidenceEventSeq < 1))) {
      throw new ShadowRepositoryError('serialization_bound_exceeded', 'verdict gate bound exceeded');
    }
  }
  const payload = json({
    mode: input.mode, effective_mode: input.effectiveMode, completion_effect: input.completionEffect,
    result: input.result, reason: input.reason, intent: input.intent,
    project: input.project, session_id: input.sessionId, client_name: input.clientName,
    config_version: input.configVersion, config_sha256: input.configSha256,
    evaluated_through: {
      event_seq: input.evaluatedThrough.eventSeq,
      mutation_seq: input.evaluatedThrough.mutationSeq,
    },
    active_rules: input.rules.map(rule => ({
      rule_id: rule.ruleId, revision: rule.revision,
      watermark_event_seq: rule.watermarkEventSeq,
      watermark_mutation_seq: rule.watermarkMutationSeq,
    })),
    required_gate_ids: input.requiredGateIds,
    gates: input.gates.map(gate => ({
      gate_id: gate.gateId, state: gate.state, reason: gate.reason,
      evidence_event_seq: gate.evidenceEventSeq, capture_result: gate.captureResult,
      parser_name: gate.parserName, parser_version: gate.parserVersion,
      digest_version: gate.digestVersion,
    })),
    capability_reasons: input.capabilityReasons,
    stop_hook_active: input.stopHookActive,
    evaluator_version: input.evaluatorVersion, digest_version: input.digestVersion,
    elapsed_ms: input.elapsedMs, retry_count: input.retryCount, self_error: input.fault,
  });
  if (Buffer.byteLength(payload, 'utf8') > SHADOW_REPOSITORY_LIMITS.payloadBytes) {
    throw new ShadowRepositoryError('serialization_bound_exceeded', 'verdict payload byte bound exceeded');
  }
  return payload;
}

/** Compare the current project sequence with the snapshot used by an evaluation. */
export function recheckShadowSequence(
  db: Database.Database, project: string, expected: ShadowSequence, retryCount: 0 | 1,
): ShadowSequenceCheckResult {
  try {
    const current = shadowSequence(db, project);
    if (current.eventSeq === expected.eventSeq && current.mutationSeq === expected.mutationSeq) {
      return { status: 'unchanged', sequence: current, fault: null };
    }
    return retryCount === 0
      ? { status: 'retry', sequence: current, fault: null }
      : { status: 'self_error', sequence: current, fault: 'concurrent_mutation' };
  } catch (error) {
    return { status: 'self_error', sequence: null, fault: shadowFault(error) };
  }
}

/** Final sequence check and bounded audit insert share one immediate transaction. */
export function persistShadowStopVerdict(db: Database.Database, input: ShadowStopVerdictAuditInput): ShadowVerdictPersistenceResult {
  let payload: string;
  try {
    payload = validatedVerdictPayload(input);
  } catch (error) {
    return { status: 'self_error', auditId: null, sequence: null, fault: shadowFault(error) };
  }
  try {
    const write = db.transaction((): ShadowVerdictPersistenceResult => {
      const sequence = shadowSequence(db, input.project);
      if (sequence.eventSeq !== input.evaluatedThrough.eventSeq ||
          sequence.mutationSeq !== input.evaluatedThrough.mutationSeq) {
        return input.retryCount === 0
          ? { status: 'retry', auditId: null, sequence, fault: null }
          : {
              status: 'self_error', auditId: null, sequence,
              fault: 'concurrent_mutation',
            };
      }
      const soleRule = input.rules.length === 1 ? input.rules[0] : null;
      const soleGate = input.gates.length === 1 && input.requiredGateIds.length === 1 &&
        input.gates[0].gateId === input.requiredGateIds[0] ? input.gates[0] : null;
      try {
        const inserted = db.prepare(`
          INSERT INTO governance_audit (
            project, session_id, client_name, occurred_at, event_type, actor_class,
            redacted_detail, linked_rule_id, linked_rule_memory_id,
            linked_gate_id, linked_event_seq, payload_version, payload
          ) VALUES (?, ?, ?, ?, 'shadow_stop_verdict', 'system', ?, ?, ?, ?, ?, ?, ?)
        `).run(
          input.project, input.sessionId, input.clientName, input.occurredAt,
          `shadow verdict: ${input.result}/${input.reason}`,
          soleRule?.ruleId ?? null, soleRule?.memoryId ?? null,
          soleGate?.gateId ?? null, soleGate?.evidenceEventSeq ?? null,
          SHADOW_VERDICT_PAYLOAD_VERSION, payload,
        );
        return {
          status: 'persisted', auditId: Number(inserted.lastInsertRowid),
          sequence, fault: null,
        };
      } catch {
        throw new ShadowRepositoryError('audit_write_failed', 'shadow verdict audit insert failed');
      }
    });
    return write.immediate();
  } catch (error) {
    const fault = shadowFault(error);
    return {
      status: 'self_error', auditId: null, sequence: null,
      fault: fault === 'unexpected_error' ? 'audit_write_failed' : fault,
    };
  }
}
