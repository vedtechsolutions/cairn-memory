/**
 * Governance repository — the one entry point over the governance tables.
 * The operations live in focused stores (recorder, shadow snapshot, shadow
 * verdict, cleanup) and the contract types in repository-types; this class
 * binds them to one connection, and every name the module ever exported is
 * re-exported here so no import path changes.
 */
import type Database from 'better-sqlite3';
import type {
  EnsureShadowWatermarksInput, EnsureShadowWatermarksResult,
  GovernanceEvidenceCleanupOptions, GovernanceEvidenceCleanupResult,
  GovernanceLifecycleCleanupOptions, GovernanceLifecycleCleanupResult,
  GovernanceStopObservationInput, RecorderTransactionInput, RecorderTransactionResult,
  ShadowEvaluationSnapshot, ShadowSequence, ShadowSequenceCheckResult,
  ShadowSnapshotOptions, ShadowStopVerdictAuditInput, ShadowVerdictPersistenceResult,
} from './repository-types.js';
import { observeStop, readClientState, recordToolEvent } from './recorder-store.js';
import { ensureShadowRuleWatermarks, readShadowSnapshot } from './shadow-snapshot-store.js';
import { persistShadowStopVerdict, recheckShadowSequence } from './shadow-verdict-store.js';
import { cleanupEvidence, cleanupLifecycle } from './repository-cleanup.js';

export * from './repository-types.js';
export { EVIDENCE_RETENTION_DAYS } from './recorder-store.js';

export class GovernanceRepository {
  constructor(private readonly db: Database.Database) {}

  /** Assign event order and project mutation order in the same immediate transaction. */
  record(input: RecorderTransactionInput): RecorderTransactionResult {
    return recordToolEvent(this.db, input);
  }

  clientState(project: string, installationId: string): Record<string, unknown> | null {
    return readClientState(this.db, project, installationId);
  }

  /** Record Stop support without overwriting capabilities this hook cannot observe. */
  observeStop(input: GovernanceStopObservationInput): void {
    observeStop(this.db, input);
  }

  /** Read all evaluator inputs from one deferred SQLite snapshot. */
  readShadowSnapshot(options: ShadowSnapshotOptions): ShadowEvaluationSnapshot {
    return readShadowSnapshot(this.db, options);
  }

  /** Create first-seen rule revision watermarks in one serialized transaction. */
  ensureShadowRuleWatermarks(input: EnsureShadowWatermarksInput): EnsureShadowWatermarksResult {
    return ensureShadowRuleWatermarks(this.db, input);
  }

  /** Compare the current project sequence with the snapshot used by an evaluation. */
  recheckShadowSequence(
    project: string, expected: ShadowSequence, retryCount: 0 | 1,
  ): ShadowSequenceCheckResult {
    return recheckShadowSequence(this.db, project, expected, retryCount);
  }

  /** Final sequence check and bounded audit insert share one immediate transaction. */
  persistShadowStopVerdict(input: ShadowStopVerdictAuditInput): ShadowVerdictPersistenceResult {
    return persistShadowStopVerdict(this.db, input);
  }

  /** Evidence cleanup is transactional and never removes an audit-referenced event. */
  cleanupEvidence(options: GovernanceEvidenceCleanupOptions = {}): GovernanceEvidenceCleanupResult {
    return cleanupEvidence(this.db, options);
  }

  /**
   * Explicit project cleanup for shortened audit/rule ceilings. Only fully
   * retired rule families are removable; active/disabled families and every
   * audit row needed to explain them remain intact. A retired family becomes
   * eligible by its latest revision's age; all family revisions and linked
   * audit rows are then pruned together, never by each audit row's own age.
   */
  cleanupLifecycle(options: GovernanceLifecycleCleanupOptions): GovernanceLifecycleCleanupResult {
    return cleanupLifecycle(this.db, options);
  }
}
