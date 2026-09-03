/**
 * Shadow-evaluation row shapes and their parsers: the bounded identifier
 * grammar, the fault classifier, the sequence read, and the row-to-contract
 * conversions every shadow store operation validates through. Split from
 * repository.ts (phase 4).
 */
import type Database from 'better-sqlite3';
import type { CaptureStatus, MutationClass } from './types.js';
import type { EvidenceMutationEvent } from './evidence-selector.js';
import type { GovernanceClientCapabilityRow } from './capability-status.js';
import {
  CAPABILITY_DEGRADATION_REASONS, SHADOW_FAULT_CODES,
  type GovernanceIntent, type ShadowFaultCode,
} from './verdict-types.js';
import {
  SHADOW_REPOSITORY_LIMITS, SHADOW_RULE_WATERMARK_PAYLOAD_VERSION, ShadowRepositoryError,
  type ShadowRuleRevisionSnapshot, type ShadowRuleWatermark, type ShadowSequence,
} from './repository-types.js';
import { currentMutationSequence } from './recorder-store.js';

export interface ShadowWatermarkRow {
  id: number;
  linked_rule_id: string | null;
  payload_version: number;
  payload: string;
}

export interface ShadowEventRow {
  event_seq: number;
  mutation_seq: number;
  mutation_class: MutationClass;
  affected_paths: string;
}

export interface ShadowGateRunRow {
  gate_id: string;
  event_seq: number;
  mutation_seq: number;
  config_sha256: string;
  parser_name: string;
  parser_version: number;
  test_total: number | null;
  test_pass: number | null;
  test_fail: number | null;
  test_skip: number | null;
  skip_reasons_complete: number | null;
  worktree_digest: string | null;
  digest_version: number | null;
  relevant_paths_sha256: string | null;
  capture_result: CaptureStatus;
}

export interface ShadowCapabilityDbRow {
  project: string;
  client_installation_id: string;
  client_name: string;
  client_version: string | null;
  supports_post_tool_use: number | null;
  supports_post_tool_failure: number | null;
  supports_file_changed: number | null;
  supports_structured_output: number | null;
  supports_stop: number | null;
  supports_blocking: number | null;
  adapter_version: number;
  settings_source: string | null;
  last_session_id: string | null;
  last_heartbeat_at: string | null;
  last_probe_result: string | null;
}

const SHADOW_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,511}$/u;
const SHADOW_RULE_KEY = /^[a-z][a-z0-9_-]{0,63}$/u;
export const SHADOW_REASON = /^[a-z][a-z0-9_]{0,95}$/u;
export const SHADOW_VERDICT_REASONS = new Set<string>([
  ...SHADOW_FAULT_CODES, ...CAPABILITY_DEGRADATION_REASONS,
  'gate_self_error', 'no_active_pre_exit_rule', 'empty_requirement_set',
  'gate_non_pass', 'gate_stale', 'gate_missing', 'all_required_gates_fresh',
]);

export function shadowFault(error: unknown): ShadowFaultCode {
  if (error instanceof ShadowRepositoryError) return error.fault;
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  if (message.includes('no such table') || message.includes('no such column')) return 'schema_unavailable';
  if (message.includes('locked') || message.includes('busy')) return 'database_busy';
  if (message.includes('closed') || message.includes('not open') || message.includes('unable to open')) {
    return 'database_unavailable';
  }
  return 'unexpected_error';
}

export function shadowSequence(db: Database.Database, project: string): ShadowSequence {
  const event = db.prepare(`
    SELECT COALESCE(MAX(event_seq), 0) AS event_seq
    FROM governance_tool_events WHERE project = ?
  `).get(project) as { event_seq: number };
  return { eventSeq: event.event_seq, mutationSeq: currentMutationSequence(db, project) };
}

export function booleanOrNull(value: number | null): boolean | null {
  return value === null ? null : value === 1;
}

export function capabilityRow(row: ShadowCapabilityDbRow | undefined): GovernanceClientCapabilityRow | null {
  if (row === undefined) return null;
  return {
    project: row.project,
    clientInstallationId: row.client_installation_id,
    clientName: row.client_name,
    clientVersion: row.client_version,
    supportsPostToolUse: booleanOrNull(row.supports_post_tool_use),
    supportsPostToolFailure: booleanOrNull(row.supports_post_tool_failure),
    supportsFileChanged: booleanOrNull(row.supports_file_changed),
    supportsStructuredOutput: booleanOrNull(row.supports_structured_output),
    supportsStop: booleanOrNull(row.supports_stop),
    supportsBlocking: booleanOrNull(row.supports_blocking),
    adapterVersion: row.adapter_version,
    settingsSource: row.settings_source,
    lastSessionId: row.last_session_id,
    lastHeartbeatAt: row.last_heartbeat_at,
    lastProbeResult: row.last_probe_result,
  };
}

export function boundedIdentifier(value: string): boolean {
  return value.length <= SHADOW_REPOSITORY_LIMITS.identifierChars && SHADOW_ID.test(value);
}

export function parseRule(
  memoryId: string, project: string, context: Record<string, unknown>,
): ShadowRuleRevisionSnapshot {
  const scope = context.scope as Record<string, unknown> | undefined;
  const gateIds = context.gate_ids;
  const paths = scope?.paths;
  if (context.schema !== 1 || context.record_type !== 'policy' || context.status !== 'active' ||
      !boundedIdentifier(memoryId) || typeof context.rule_id !== 'string' ||
      !SHADOW_RULE_KEY.test(context.rule_id) ||
      !Number.isSafeInteger(context.revision) || Number(context.revision) < 1 ||
      !['advise', 'warn', 'block'].includes(String(context.level)) ||
      !Array.isArray(context.phases) || !context.phases.includes('pre_exit') ||
      context.phases.some(phase => !['create', 'pre_implement', 'during', 'pre_exit'].includes(String(phase))) ||
      !Array.isArray(gateIds) || gateIds.length > SHADOW_REPOSITORY_LIMITS.requiredGates ||
      new Set(gateIds).size !== gateIds.length ||
      gateIds.some(id => typeof id !== 'string' || !SHADOW_RULE_KEY.test(id)) ||
      typeof scope !== 'object' || scope === null || scope.project !== project ||
      !Array.isArray(paths) || paths.length > 64 || new Set(paths).size !== paths.length ||
      paths.some(path => typeof path !== 'string' || path.length === 0 || path.length > 512 ||
        path.startsWith('/') || path.includes('\0') || path.split('/').includes('..'))) {
    throw new ShadowRepositoryError('rule_malformed', 'active rule context violates the policy contract');
  }
  return {
    memoryId,
    ruleId: context.rule_id,
    revision: Number(context.revision),
    level: context.level as GovernanceIntent,
    gateIds: gateIds as string[],
    paths: paths as string[],
    watermark: null,
  };
}

export function parseWatermark(row: ShadowWatermarkRow): ShadowRuleWatermark {
  if (row.payload_version !== SHADOW_RULE_WATERMARK_PAYLOAD_VERSION) {
    throw new ShadowRepositoryError('unsupported_payload_version', 'unsupported rule watermark payload version');
  }
  let value: unknown;
  try {
    value = JSON.parse(row.payload);
  } catch {
    throw new ShadowRepositoryError('evidence_malformed', 'rule watermark payload is not JSON');
  }
  const payload = value as Record<string, unknown> | null;
  if (payload === null || typeof payload !== 'object' ||
      typeof payload.rule_id !== 'string' || payload.rule_id !== row.linked_rule_id ||
      !Number.isSafeInteger(payload.revision) || Number(payload.revision) < 1 ||
      !Number.isSafeInteger(payload.event_seq) || Number(payload.event_seq) < 0 ||
      !Number.isSafeInteger(payload.mutation_seq) || Number(payload.mutation_seq) < 0) {
    throw new ShadowRepositoryError('evidence_malformed', 'rule watermark payload violates its contract');
  }
  return {
    auditId: row.id, ruleId: payload.rule_id, revision: Number(payload.revision),
    eventSeq: Number(payload.event_seq), mutationSeq: Number(payload.mutation_seq),
  };
}

export function parseAffectedPaths(row: ShadowEventRow): EvidenceMutationEvent {
  let paths: unknown;
  try {
    paths = JSON.parse(row.affected_paths);
  } catch {
    throw new ShadowRepositoryError('evidence_malformed', 'affected paths are not JSON');
  }
  if (!Array.isArray(paths) || paths.length > 1_024 ||
      paths.some(path => typeof path !== 'string' || path.length > 512 || path.includes('\0'))) {
    throw new ShadowRepositoryError('evidence_malformed', 'affected paths violate their contract');
  }
  return {
    eventSeq: row.event_seq, mutationSeq: row.mutation_seq,
    mutationClass: row.mutation_class, affectedPaths: paths as string[],
  };
}
