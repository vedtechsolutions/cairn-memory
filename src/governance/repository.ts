import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import type {
  CaptureStatus, GovernanceHookEvent, MutationClass, ToolOutcome,
} from './types.js';
import type {
  EvidenceMutationEvent, GateRunEvidence,
} from './evidence-selector.js';
import type { GovernanceClientCapabilityRow } from './capability-status.js';
import { GovernanceRuleRepository } from './rule-repository.js';
import {
  CAPABILITY_DEGRADATION_REASONS, GATE_EVIDENCE_STATES, SHADOW_FAULT_CODES,
  SHADOW_RESULTS, SHADOW_VERDICT_PAYLOAD_VERSION,
  type CapabilityDegradationReason, type GateEvidenceState, type GovernanceIntent,
  type ShadowFaultCode, type ShadowResult, type ShadowVerdictReason,
} from './verdict-types.js';

export interface GovernanceToolEventInsert {
  project: string;
  canonicalRoot: string;
  sessionId: string;
  clientName: string;
  clientVersion: string | null;
  clientInstallationId: string;
  hookEvent: GovernanceHookEvent;
  toolName: string | null;
  toolUseId: string | null;
  deliveryFingerprint: string | null;
  receivedAt: string;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  rawCommand: string | null;
  redactedCommand: string | null;
  commandSha256: string | null;
  cwd: string | null;
  normalizedArgv: string | null;
  outcome: ToolOutcome;
  exitCode: number | null;
  signal: string | null;
  interrupted: boolean;
  timedOut: boolean;
  outputSha256: string | null;
  redactedDiagnostic: string | null;
  mutationClass: MutationClass;
  affectedPaths: string[];
  adapterName: string;
  adapterVersion: number;
  captureStatus: CaptureStatus;
  captureReason: string | null;
  observedStructuredOutput: boolean | null;
}

export interface GovernanceGateRunInsert {
  gateId: string;
  ruleId: string | null;
  ruleRevision: number | null;
  configVersion: number;
  configSha256: string;
  parserName: string;
  parserVersion: number;
  testTotal: number | null;
  testPass: number | null;
  testFail: number | null;
  testSkip: number | null;
  skipReasonsComplete: boolean | null;
  worktreeDigest: string | null;
  digestVersion: number | null;
  relevantPathsSha256: string | null;
  captureResult: CaptureStatus;
  incidentReason: string | null;
}

export interface RecorderTransactionInput {
  event: GovernanceToolEventInsert;
  gateRuns: readonly GovernanceGateRunInsert[];
  evidenceDays: number;
  /** Test-only transaction fault point. */
  failAfterEventInsert?: boolean;
}

export interface RecorderTransactionResult {
  status: 'recorded' | 'deduplicated';
  eventSeq: number;
  mutationSeq: number;
  gateRuns: number;
}

export interface GovernanceEvidenceCleanupResult {
  gateRunsDeleted: number;
  toolEventsDeleted: number;
  projectsAudited: number;
}

export interface GovernanceLifecycleCleanupResult {
  rulesDeleted: number;
  auditRowsDeleted: number;
}

export interface GovernanceStopObservationInput {
  project: string;
  clientInstallationId: string;
  clientName: string;
  clientVersion: string | null;
  adapterVersion: number;
  sessionId: string;
  occurredAt: string;
}

export const SHADOW_REPOSITORY_LIMITS = Object.freeze({
  activeRules: 64,
  candidateGateRuns: 2_048,
  sessionEvents: 4_096,
  requiredGates: 32,
  capabilityReasons: 16,
  identifierChars: 512,
  gateReasonChars: 96,
  payloadBytes: 64 * 1_024,
  elapsedMs: 60_000,
});
export const SHADOW_RULE_WATERMARK_PAYLOAD_VERSION = 1;

export interface ShadowSequence {
  eventSeq: number;
  mutationSeq: number;
}

export interface ShadowRuleWatermark extends ShadowSequence {
  ruleId: string;
  revision: number;
  auditId: number;
}

export interface ShadowRuleRevisionSnapshot {
  memoryId: string;
  ruleId: string;
  revision: number;
  level: GovernanceIntent;
  gateIds: string[];
  paths: string[];
  watermark: ShadowRuleWatermark | null;
}

export interface ShadowEvaluationSnapshot {
  project: string;
  sessionId: string;
  configSha256: string;
  sequence: ShadowSequence;
  rules: ShadowRuleRevisionSnapshot[];
  events: EvidenceMutationEvent[];
  gateRuns: GateRunEvidence[];
  capability: GovernanceClientCapabilityRow | null;
}

export type ShadowSnapshotReadStage =
  | 'rules' | 'watermarks' | 'sequences' | 'capability' | 'events' | 'gate-runs';

export interface ShadowSnapshotOptions {
  project: string;
  sessionId: string;
  clientInstallationId: string;
  configSha256: string;
  /** Test-only hook for proving one SQLite read snapshot across concurrent writes. */
  onReadStage?: (stage: ShadowSnapshotReadStage) => void;
}

export interface EnsureShadowWatermarksResult {
  watermarks: ShadowRuleWatermark[];
  sequence: ShadowSequence;
  created: number;
  requiresRefresh: boolean;
}

export interface EnsureShadowWatermarksInput {
  project: string;
  occurredAt: string;
  rules: readonly Pick<ShadowRuleRevisionSnapshot, 'memoryId' | 'ruleId' | 'revision'>[];
}

export interface ShadowAuditRuleInput {
  ruleId: string;
  memoryId: string;
  revision: number;
  watermarkEventSeq: number;
  watermarkMutationSeq: number;
}

export interface ShadowAuditGateInput {
  gateId: string;
  state: GateEvidenceState;
  reason: string;
  evidenceEventSeq: number | null;
  captureResult: CaptureStatus | null;
  parserName: string | null;
  parserVersion: number | null;
  digestVersion: number | null;
}

export interface ShadowStopVerdictAuditInput {
  project: string;
  sessionId: string;
  clientName: string; mode: 'shadow' | 'warn'; effectiveMode: 'shadow' | 'advisory' | 'warn'; completionEffect: 'none';
  occurredAt: string;
  intent: GovernanceIntent;
  result: ShadowResult;
  reason: ShadowVerdictReason;
  fault: ShadowFaultCode | null;
  configVersion: number | null;
  configSha256: string | null;
  evaluatedThrough: ShadowSequence;
  rules: readonly ShadowAuditRuleInput[];
  requiredGateIds: readonly string[];
  gates: readonly ShadowAuditGateInput[];
  capabilityReasons: readonly CapabilityDegradationReason[];
  stopHookActive: boolean;
  evaluatorVersion: number;
  digestVersion: number;
  elapsedMs: number;
  retryCount: 0 | 1;
}

export type ShadowSequenceCheckResult =
  | { status: 'unchanged'; sequence: ShadowSequence; fault: null }
  | { status: 'retry'; sequence: ShadowSequence; fault: null }
  | { status: 'self_error'; sequence: ShadowSequence | null; fault: ShadowFaultCode };

export type ShadowVerdictPersistenceResult =
  | { status: 'persisted'; auditId: number; sequence: ShadowSequence; fault: null }
  | { status: 'retry'; auditId: null; sequence: ShadowSequence; fault: null }
  | { status: 'self_error'; auditId: null; sequence: ShadowSequence | null; fault: ShadowFaultCode };

export class ShadowRepositoryError extends Error {
  constructor(readonly fault: ShadowFaultCode, message: string) {
    super(message);
    this.name = 'ShadowRepositoryError';
  }
}

interface ExistingEvent {
  event_seq: number;
  mutation_seq: number;
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function dedupedEvent(db: Database.Database, event: GovernanceToolEventInsert): ExistingEvent | undefined {
  if (event.toolUseId !== null) {
    const row = db.prepare(`
      SELECT event_seq, mutation_seq FROM governance_tool_events
      WHERE client_name = ? AND session_id = ? AND tool_use_id = ? AND hook_event = ?
    `).get(event.clientName, event.sessionId, event.toolUseId, event.hookEvent) as ExistingEvent | undefined;
    if (row) return row;
  }
  if (event.hookEvent === 'FileChanged' && event.deliveryFingerprint !== null) {
    return db.prepare(`
      SELECT event_seq, mutation_seq FROM governance_tool_events
      WHERE client_name = ? AND session_id = ? AND hook_event = 'FileChanged'
        AND delivery_fingerprint = ?
    `).get(event.clientName, event.sessionId, event.deliveryFingerprint) as ExistingEvent | undefined;
  }
  return undefined;
}

function isCorrelatedMutation(db: Database.Database, event: GovernanceToolEventInsert): boolean {
  if (event.toolUseId === null || event.mutationClass === 'none') return false;
  const rows = db.prepare(`
    SELECT affected_paths FROM governance_tool_events
    WHERE project = ? AND client_name = ? AND session_id = ? AND tool_use_id = ?
      AND hook_event != ? AND mutation_class = 'scoped'
  `).all(
    event.project, event.clientName, event.sessionId, event.toolUseId, event.hookEvent,
  ) as Array<{ affected_paths: string }>;
  if (event.mutationClass !== 'scoped') return false;
  const expected = json([...event.affectedPaths].sort());
  return rows.some(row => {
    try {
      const paths = JSON.parse(row.affected_paths) as unknown;
      return Array.isArray(paths) && json([...paths].sort()) === expected;
    } catch {
      return false;
    }
  });
}

function currentMutationSequence(db: Database.Database, project: string): number {
  const key = mutationSequenceKey(project);
  const persisted = db.prepare('SELECT value FROM maintenance_meta WHERE key = ?')
    .get(key) as { value: string } | undefined;
  if (persisted !== undefined) {
    const parsed = Number(persisted.value);
    if (Number.isSafeInteger(parsed) && parsed >= 0) return parsed;
    throw new Error('invalid persisted governance mutation sequence');
  }
  return (db.prepare(`
    SELECT COALESCE(MAX(mutation_seq), 0) AS mutation_seq
    FROM governance_tool_events WHERE project = ?
  `).get(project) as { mutation_seq: number }).mutation_seq;
}

function mutationSequenceKey(project: string): string {
  const digest = createHash('sha256').update(project).digest('hex');
  return `governance_mutation_seq:${digest}`;
}

function retentionKey(project: string): string {
  const digest = createHash('sha256').update(project).digest('hex');
  return `governance_evidence_days:${digest}`;
}

function persistMutationSequence(db: Database.Database, project: string, sequence: number): void {
  db.prepare(`
    INSERT INTO maintenance_meta (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(mutationSequenceKey(project), String(sequence));
}

function persistEvidenceDays(db: Database.Database, project: string, days: number): void {
  if (!Number.isInteger(days) || days < 1 || days > 30) {
    throw new Error('evidence retention must be 1..30 days');
  }
  db.prepare(`
    INSERT INTO maintenance_meta (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(retentionKey(project), String(days));
}

function persistedEvidenceDays(db: Database.Database, project: string): number | null {
  const row = db.prepare('SELECT value FROM maintenance_meta WHERE key = ?')
    .get(retentionKey(project)) as { value: string } | undefined;
  if (row === undefined) return null;
  const days = Number(row.value);
  return Number.isInteger(days) && days >= 1 && days <= 30 ? days : null;
}

function updateClientState(db: Database.Database, event: GovernanceToolEventInsert): void {
  const post = event.hookEvent === 'PostToolUse' ? 1 : null;
  const failure = event.hookEvent === 'PostToolUseFailure' ? 1 : null;
  const fileChanged = event.hookEvent === 'FileChanged' ? 1 : null;
  const structured = event.observedStructuredOutput === null
    ? null : event.observedStructuredOutput ? 1 : 0;
  db.prepare(`
    INSERT INTO governance_client_state (
      project, client_installation_id, client_name, client_version,
      supports_post_tool_use, supports_post_tool_failure, supports_file_changed,
      supports_structured_output, adapter_version, last_session_id,
      last_heartbeat_at, last_probe_result
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'hook-observation')
    ON CONFLICT(project, client_installation_id) DO UPDATE SET
      client_name = excluded.client_name,
      client_version = COALESCE(excluded.client_version, governance_client_state.client_version),
      supports_post_tool_use = COALESCE(excluded.supports_post_tool_use, governance_client_state.supports_post_tool_use),
      supports_post_tool_failure = COALESCE(excluded.supports_post_tool_failure, governance_client_state.supports_post_tool_failure),
      supports_file_changed = COALESCE(excluded.supports_file_changed, governance_client_state.supports_file_changed),
      supports_structured_output = COALESCE(excluded.supports_structured_output, governance_client_state.supports_structured_output),
      adapter_version = excluded.adapter_version,
      last_session_id = excluded.last_session_id,
      last_heartbeat_at = excluded.last_heartbeat_at,
      last_probe_result = excluded.last_probe_result
  `).run(
    event.project, event.clientInstallationId, event.clientName, event.clientVersion,
    post, failure, fileChanged, structured, event.adapterVersion,
    event.sessionId, event.receivedAt,
  );
}

interface ShadowWatermarkRow {
  id: number;
  linked_rule_id: string | null;
  payload_version: number;
  payload: string;
}

interface ShadowEventRow {
  event_seq: number;
  mutation_seq: number;
  mutation_class: MutationClass;
  affected_paths: string;
}

interface ShadowGateRunRow {
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

interface ShadowCapabilityDbRow {
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
const SHADOW_REASON = /^[a-z][a-z0-9_]{0,95}$/u;
const SHADOW_VERDICT_REASONS = new Set<string>([
  ...SHADOW_FAULT_CODES, ...CAPABILITY_DEGRADATION_REASONS,
  'gate_self_error', 'no_active_pre_exit_rule', 'empty_requirement_set',
  'gate_non_pass', 'gate_stale', 'gate_missing', 'all_required_gates_fresh',
]);

function shadowFault(error: unknown): ShadowFaultCode {
  if (error instanceof ShadowRepositoryError) return error.fault;
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  if (message.includes('no such table') || message.includes('no such column')) return 'schema_unavailable';
  if (message.includes('locked') || message.includes('busy')) return 'database_busy';
  if (message.includes('closed') || message.includes('not open') || message.includes('unable to open')) {
    return 'database_unavailable';
  }
  return 'unexpected_error';
}

function shadowSequence(db: Database.Database, project: string): ShadowSequence {
  const event = db.prepare(`
    SELECT COALESCE(MAX(event_seq), 0) AS event_seq
    FROM governance_tool_events WHERE project = ?
  `).get(project) as { event_seq: number };
  return { eventSeq: event.event_seq, mutationSeq: currentMutationSequence(db, project) };
}

function booleanOrNull(value: number | null): boolean | null {
  return value === null ? null : value === 1;
}

function capabilityRow(row: ShadowCapabilityDbRow | undefined): GovernanceClientCapabilityRow | null {
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

function boundedIdentifier(value: string): boolean {
  return value.length <= SHADOW_REPOSITORY_LIMITS.identifierChars && SHADOW_ID.test(value);
}

function parseRule(
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

function parseWatermark(row: ShadowWatermarkRow): ShadowRuleWatermark {
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

function parseAffectedPaths(row: ShadowEventRow): EvidenceMutationEvent {
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

export class GovernanceRepository {
  constructor(private readonly db: Database.Database) {}

  /** Assign event order and project mutation order in the same immediate transaction. */
  record(input: RecorderTransactionInput): RecorderTransactionResult {
    const transaction = this.db.transaction((): RecorderTransactionResult => {
      const duplicate = dedupedEvent(this.db, input.event);
      if (duplicate) {
        persistEvidenceDays(this.db, input.event.project, input.evidenceDays);
        updateClientState(this.db, input.event);
        return {
          status: 'deduplicated', eventSeq: duplicate.event_seq,
          mutationSeq: duplicate.mutation_seq, gateRuns: 0,
        };
      }

      const currentMutation = currentMutationSequence(this.db, input.event.project);
      const increments = input.event.mutationClass !== 'none' &&
        !isCorrelatedMutation(this.db, input.event);
      const mutationSeq = currentMutation + (increments ? 1 : 0);
      if (increments) persistMutationSequence(this.db, input.event.project, mutationSeq);
      persistEvidenceDays(this.db, input.event.project, input.evidenceDays);
      const insert = this.db.prepare(`
        INSERT INTO governance_tool_events (
          project, canonical_root, session_id, client_name, client_version,
          hook_event, tool_name, tool_use_id, delivery_fingerprint,
          received_at, started_at, ended_at, duration_ms,
          raw_command, redacted_command, command_sha256, cwd, normalized_argv,
          outcome, exit_code, signal, interrupted, timed_out, output_sha256,
          redacted_diagnostic, mutation_class, affected_paths, mutation_seq,
          adapter_name, adapter_version, capture_status, capture_reason, created_at
        ) VALUES (
          @project, @canonicalRoot, @sessionId, @clientName, @clientVersion,
          @hookEvent, @toolName, @toolUseId, @deliveryFingerprint,
          @receivedAt, @startedAt, @endedAt, @durationMs,
          @rawCommand, @redactedCommand, @commandSha256, @cwd, @normalizedArgv,
          @outcome, @exitCode, @signal, @interrupted, @timedOut, @outputSha256,
          @redactedDiagnostic, @mutationClass, @affectedPaths, @mutationSeq,
          @adapterName, @adapterVersion, @captureStatus, @captureReason, @receivedAt
        )
      `).run({
        ...input.event,
        interrupted: input.event.interrupted ? 1 : 0,
        timedOut: input.event.timedOut ? 1 : 0,
        affectedPaths: json(input.event.affectedPaths),
        mutationSeq,
      });
      const eventSeq = Number(insert.lastInsertRowid);
      if (input.failAfterEventInsert) throw new Error('induced recorder failure');

      const gateInsert = this.db.prepare(`
        INSERT INTO governance_gate_runs (
          event_seq, project, session_id, client_name, gate_id, rule_id, rule_revision,
          config_version, config_sha256, parser_name, parser_version,
          test_total, test_pass, test_fail, test_skip, skip_reasons_complete,
          worktree_digest, digest_version, mutation_seq, relevant_paths_sha256,
          capture_result, created_at
        ) VALUES (
          @eventSeq, @project, @sessionId, @clientName, @gateId, @ruleId, @ruleRevision,
          @configVersion, @configSha256, @parserName, @parserVersion,
          @testTotal, @testPass, @testFail, @testSkip, @skipReasonsComplete,
          @worktreeDigest, @digestVersion, @mutationSeq, @relevantPathsSha256,
          @captureResult, @createdAt
        )
      `);
      const incidentInsert = this.db.prepare(`
        INSERT INTO governance_audit (
          project, session_id, client_name, occurred_at, event_type, actor_class,
          redacted_detail, linked_gate_id, linked_event_seq, payload_version, payload
        ) VALUES (?, ?, ?, ?, 'recorder_incident', 'system', ?, ?, ?, 1, ?)
      `);
      for (const gate of input.gateRuns) {
        gateInsert.run({
          eventSeq, project: input.event.project, sessionId: input.event.sessionId,
          clientName: input.event.clientName, mutationSeq, createdAt: input.event.receivedAt,
          ...gate,
          skipReasonsComplete: gate.skipReasonsComplete === null
            ? null : gate.skipReasonsComplete ? 1 : 0,
        });
        if (gate.incidentReason !== null) {
          incidentInsert.run(
            input.event.project, input.event.sessionId, input.event.clientName,
            input.event.receivedAt, `gate ${gate.gateId}: ${gate.incidentReason}`,
            gate.gateId, eventSeq, json({ reason: gate.incidentReason }),
          );
        }
      }
      if (input.event.captureStatus === 'incomplete' || input.event.captureStatus === 'adapter_error') {
        incidentInsert.run(
          input.event.project, input.event.sessionId, input.event.clientName,
          input.event.receivedAt, `event capture: ${input.event.captureReason ?? input.event.captureStatus}`,
          null, eventSeq, json({ reason: input.event.captureReason ?? input.event.captureStatus }),
        );
      }
      updateClientState(this.db, input.event);
      return { status: 'recorded', eventSeq, mutationSeq, gateRuns: input.gateRuns.length };
    });
    return transaction.immediate();
  }

  clientState(project: string, installationId: string): Record<string, unknown> | null {
    return (this.db.prepare(`
      SELECT * FROM governance_client_state
      WHERE project = ? AND client_installation_id = ?
    `).get(project, installationId) as Record<string, unknown> | undefined) ?? null;
  }

  /** Record Stop support without overwriting capabilities this hook cannot observe. */
  observeStop(input: GovernanceStopObservationInput): void {
    this.db.prepare(`
      INSERT INTO governance_client_state (
        project, client_installation_id, client_name, client_version,
        supports_stop, adapter_version, last_session_id,
        last_heartbeat_at, last_probe_result
      ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, 'hook-observation')
      ON CONFLICT(project, client_installation_id) DO UPDATE SET
        client_name = excluded.client_name,
        client_version = COALESCE(excluded.client_version, governance_client_state.client_version),
        supports_stop = COALESCE(excluded.supports_stop, governance_client_state.supports_stop),
        adapter_version = excluded.adapter_version,
        last_session_id = excluded.last_session_id,
        last_heartbeat_at = excluded.last_heartbeat_at,
        last_probe_result = excluded.last_probe_result
    `).run(
      input.project, input.clientInstallationId, input.clientName, input.clientVersion,
      input.adapterVersion, input.sessionId, input.occurredAt,
    );
  }

  /** Read all evaluator inputs from one deferred SQLite snapshot. */
  readShadowSnapshot(options: ShadowSnapshotOptions): ShadowEvaluationSnapshot {
    try {
      const read = this.db.transaction((): ShadowEvaluationSnapshot => {
        let authorityRules: ReturnType<GovernanceRuleRepository['activeByPhase']>;
        try {
          authorityRules = new GovernanceRuleRepository(this.db).activeByPhase(
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

        const watermarkRows = this.db.prepare(`
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

        const sequence = shadowSequence(this.db, options.project);
        options.onReadStage?.('sequences');

        const capability = capabilityRow(this.db.prepare(`
          SELECT project, client_installation_id, client_name, client_version,
            supports_post_tool_use, supports_post_tool_failure, supports_file_changed,
            supports_structured_output, supports_stop, supports_blocking, adapter_version,
            settings_source, last_session_id, last_heartbeat_at, last_probe_result
          FROM governance_client_state
          WHERE project = ? AND client_installation_id = ?
        `).get(options.project, options.clientInstallationId) as ShadowCapabilityDbRow | undefined);
        options.onReadStage?.('capability');

        const eventRows = this.db.prepare(`
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

        const gateRows = this.db.prepare(`
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
  ensureShadowRuleWatermarks(input: EnsureShadowWatermarksInput): EnsureShadowWatermarksResult {
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
      const write = this.db.transaction((): EnsureShadowWatermarksResult => {
        const sequence = shadowSequence(this.db, input.project);
        const existingRows = this.db.prepare(`
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
        const insert = this.db.prepare(`
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
          const current = this.db.prepare(`
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

  /** Compare the current project sequence with the snapshot used by an evaluation. */
  recheckShadowSequence(
    project: string, expected: ShadowSequence, retryCount: 0 | 1,
  ): ShadowSequenceCheckResult {
    try {
      const current = shadowSequence(this.db, project);
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
  persistShadowStopVerdict(input: ShadowStopVerdictAuditInput): ShadowVerdictPersistenceResult {
    let payload: string;
    try {
      payload = validatedVerdictPayload(input);
    } catch (error) {
      return { status: 'self_error', auditId: null, sequence: null, fault: shadowFault(error) };
    }
    try {
      const write = this.db.transaction((): ShadowVerdictPersistenceResult => {
        const sequence = shadowSequence(this.db, input.project);
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
          const inserted = this.db.prepare(`
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

  /** Evidence cleanup is transactional and never removes an audit-referenced event. */
  cleanupEvidence(options: {
    evidenceDays?: number;
    projectDays?: Readonly<Record<string, number>>;
    nowMs?: number;
  } = {}): GovernanceEvidenceCleanupResult {
    const defaultDays = options.evidenceDays ?? 30;
    if (!Number.isInteger(defaultDays) || defaultDays < 1 || defaultDays > 30) {
      throw new Error('evidence retention must be 1..30 days');
    }
    const nowMs = options.nowMs ?? Date.now();
    const projects = this.db.prepare(`
      SELECT DISTINCT project FROM governance_tool_events
      UNION SELECT DISTINCT project FROM governance_gate_runs
    `).all() as Array<{ project: string }>;
    let gateRunsDeleted = 0;
    let toolEventsDeleted = 0;
    let projectsAudited = 0;
    const transaction = this.db.transaction(() => {
      for (const { project } of projects) {
        const days = options.projectDays?.[project] ?? persistedEvidenceDays(this.db, project) ?? defaultDays;
        if (!Number.isInteger(days) || days < 1 || days > 30) {
          throw new Error(`invalid evidence retention for project ${project}`);
        }
        const cutoff = new Date(nowMs - days * 86_400_000).toISOString();
        const runs = this.db.prepare(`
          DELETE FROM governance_gate_runs WHERE project = ? AND created_at < ?
        `).run(project, cutoff).changes;
        const events = this.db.prepare(`
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
          this.db.prepare(`
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
  cleanupLifecycle(options: {
    project: string;
    auditDays: number;
    ruleDays: number;
    nowMs?: number;
    confirmed: true;
  }): GovernanceLifecycleCleanupResult {
    if (options.confirmed !== true) throw new Error('lifecycle cleanup requires explicit confirmation');
    for (const [name, days] of [['audit', options.auditDays], ['rule', options.ruleDays]] as const) {
      if (!Number.isInteger(days) || days < 1 || days > 3_650) {
        throw new Error(`${name} retention must be 1..3650 days`);
      }
    }
    const nowMs = options.nowMs ?? Date.now();
    const auditCutoff = new Date(nowMs - options.auditDays * 86_400_000).toISOString();
    const jointCutoff = new Date(
      nowMs - Math.max(options.auditDays, options.ruleDays) * 86_400_000,
    ).toISOString();
    let rulesDeleted = 0;
    let auditRowsDeleted = 0;
    const transaction = this.db.transaction(() => {
      const retired = this.db.prepare(`
        SELECT json_extract(context, '$.rule_id') AS rule_id
        FROM memories
        WHERE project = ? AND kind = 'rule' AND superseded_by IS NULL
          AND json_extract(context, '$.record_type') = 'policy'
          AND json_extract(context, '$.status') = 'retired'
          AND created_at < ?
      `).all(options.project, jointCutoff) as Array<{ rule_id: string }>;
      for (const { rule_id: ruleId } of retired) {
        auditRowsDeleted += this.db.prepare(`
          DELETE FROM governance_audit WHERE project = ? AND linked_rule_id = ?
        `).run(options.project, ruleId).changes;
        rulesDeleted += this.db.prepare(`
          DELETE FROM memories
          WHERE project = ? AND kind = 'rule'
            AND json_extract(context, '$.record_type') = 'policy'
            AND json_extract(context, '$.rule_id') = ?
        `).run(options.project, ruleId).changes;
      }
      auditRowsDeleted += this.db.prepare(`
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
        this.db.prepare(`
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
}
