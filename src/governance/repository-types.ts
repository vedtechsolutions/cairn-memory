/**
 * Governance repository contract: the row-insert shapes, the shadow-evaluation
 * snapshot types, the persistence results, the bounds, and the typed error.
 * Pure declarations shared by the recorder, shadow and cleanup stores.
 */
import type {
  CaptureStatus, GovernanceHookEvent, MutationClass, ToolOutcome,
} from './types.js';
import type {
  EvidenceMutationEvent, GateRunEvidence,
} from './evidence-selector.js';
import type { GovernanceClientCapabilityRow } from './capability-status.js';
import type {
  CapabilityDegradationReason, GateEvidenceState, GovernanceIntent,
  ShadowFaultCode, ShadowResult, ShadowVerdictReason,
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

export interface GovernanceEvidenceCleanupOptions {
  evidenceDays?: number;
  projectDays?: Readonly<Record<string, number>>;
  nowMs?: number;
}

export interface GovernanceLifecycleCleanupOptions {
  project: string;
  auditDays: number;
  ruleDays: number;
  nowMs?: number;
  confirmed: true;
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
