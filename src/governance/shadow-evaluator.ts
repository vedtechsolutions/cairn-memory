import { performance } from 'node:perf_hooks';
import type Database from 'better-sqlite3';
import { resolveCapabilityStatus } from './capability-status.js';
import { resolveEffectiveMode } from './effective-mode.js';
import {
  classifyGateEvidence, selectLatestEligibleGateRun,
  type EvidenceRequirementSelection,
} from './evidence-selector.js';
import { loadGateConfig, type LoadedGateConfig } from './gate-config.js';
import { evaluationWorktreeDigest } from './evaluation-digest.js';
import {
  GovernanceRepository, ShadowRepositoryError,
  type ShadowEvaluationSnapshot, type ShadowStopVerdictAuditInput,
  type ShadowVerdictPersistenceResult,
} from './repository.js';
import {
  configEntryPresent, preparedShadowSnapshot, selectShadowRequirements, ShadowDeadline,
  type ShadowEvaluatorRepository, type ShadowEvaluatorStage,
} from './shadow-evaluator-runtime.js';
import {
  assertSupportedAdapter, auditGate, auditRules, classifiedFault, configFault, digestFault,
  resolveShadowIdentity, resolveShadowIntent, ShadowEvaluationError,
  type ResolvedShadowIdentity,
} from './shadow-evaluator-support.js';
import {
  resolveShadowPrecedence, SHADOW_VERDICT_PAYLOAD_VERSION,
  type ShadowFaultCode, type ShadowVerdictV1,
} from './verdict-types.js';
import {
  captureWorktreeDigestV2, WORKTREE_DIGEST_V2_VERSION, type WorktreeDigestV2Result,
} from './worktree-digest.js';
import { GOVERNANCE_BOUNDS } from '../constants/index.js';

export const SHADOW_EVALUATOR_VERSION = 1;
export { SHADOW_EVALUATOR_HARD_CEILING_MS,
  type ShadowEvaluatorStage,
} from './shadow-evaluator-runtime.js';

export interface ShadowStopEvaluatorInput {
  sessionId: string;
  projectRoot: string;
  clientName: string;
  clientInstallationId: string;
  stopHookActive: boolean;
}
export interface ShadowEvaluatorOptions {
  budgetMs?: number;
  monotonicNow?: () => number;
  wallNowMs?: () => number;
  repository?: ShadowEvaluatorRepository;
  loadConfig?: typeof loadGateConfig;
  captureDigest?: typeof captureWorktreeDigestV2;
  onStage?: (stage: ShadowEvaluatorStage) => void;
  persist?: boolean;
  onResolved?: (resolved: ShadowResolvedEvaluation) => void;
}
export interface ShadowResolvedEvaluation {
  identity: ResolvedShadowIdentity;
  config: LoadedGateConfig;
  snapshot: ShadowEvaluationSnapshot;
  selection: EvidenceRequirementSelection;
  verdict: ShadowVerdictV1;
  worktreeDigest: string;
}
export interface ShadowEvaluationDiagnostic {
  status: 'skipped' | 'persisted' | 'not_persisted';
  verdict: ShadowVerdictV1 | null;
  persistence: ShadowVerdictPersistenceResult | null;
  elapsedMs: number;
  retryCount: 0 | 1;
}
interface AttemptContext {
  snapshot: ShadowEvaluationSnapshot;
  selection: EvidenceRequirementSelection;
  verdict: ShadowVerdictV1;
  audit: Omit<ShadowStopVerdictAuditInput, 'elapsedMs' | 'retryCount'>;
  worktreeDigest: string;
}
async function evaluateAttempt(options: {
  identity: ResolvedShadowIdentity;
  config: LoadedGateConfig;
  repository: ShadowEvaluatorRepository;
  captureDigest: typeof captureWorktreeDigestV2;
  occurredAt: string;
  stopHookActive: boolean;
  deadline: ShadowDeadline;
  onContext?: (
    snapshot: ShadowEvaluationSnapshot, selection: EvidenceRequirementSelection,
  ) => void;
}): Promise<AttemptContext> {
  const snapshot = preparedShadowSnapshot(
    options.repository, options.identity, options.config.sha256, options.occurredAt, options.deadline,
  );
  const selection = selectShadowRequirements(snapshot, options.config, options.deadline);
  options.onContext?.(snapshot, selection);
  const gates: ReturnType<typeof auditGate>[] = [];
  const gateDigests: Array<{ gateId: string; digest: string }> = [];
  if (selection.applicableRules.length > 0) {
    const digestCache = new Map<string, WorktreeDigestV2Result>();
    for (const gateId of selection.requiredGateIds) {
      const policy = options.config.config.gates[gateId];
      if (policy === undefined) {
        throw new ShadowEvaluationError('config_invalid', `required gate ${gateId} is undefined`);
      }
      const relevantPaths = selection.relevantPathsByGate[gateId] ?? ['**'];
      const digestKey = JSON.stringify(relevantPaths);
      options.deadline.check('digest');
      let digest = digestCache.get(digestKey);
      if (digest === undefined) {
        digest = await options.captureDigest({
          projectRoot: options.identity.projectRoot, relevantPaths,
          configSha256: options.config.sha256, deadlineMs: options.deadline.absolute(),
        });
        digestCache.set(digestKey, digest);
      }
      const fault = digestFault(digest);
      if (fault !== null) throw new ShadowEvaluationError(fault, digest.reason ?? fault);
      gateDigests.push({ gateId, digest: digest.digest! });
      options.deadline.check('classification');
      const run = selectLatestEligibleGateRun({
        gateId, configSha256: options.config.sha256,
        watermarkEventSeq: selection.watermarkByGate[gateId] ?? 0,
        runs: snapshot.gateRuns,
      });
      const classified = classifyGateEvidence({
        run, policy, relevantPaths, laterEvents: snapshot.events, currentDigest: digest,
      });
      gates.push(auditGate(gateId, classified, run));
    }
  }
  options.deadline.check('capability');
  assertSupportedAdapter(snapshot);
  const capability = resolveCapabilityStatus({
    row: snapshot.capability, clientName: options.identity.clientName,
    sessionId: options.identity.sessionId, currentStopObserved: true,
  });
  options.deadline.check('precedence');
  const gateFault = classifiedFault(gates);
  const precedence = resolveShadowPrecedence({
    applicableRuleCount: selection.applicableRules.length,
    requiredGateCount: selection.requiredGateIds.length,
    gateStates: gates.map(gate => gate.state), capabilityReasons: capability.reasons,
  });
  const intent = resolveShadowIntent(snapshot, selection, options.config);
  const effective = resolveEffectiveMode({
    intent, configValid: true, capability, fault: gateFault,
    stopHookActive: options.stopHookActive,
  });
  const verdict: ShadowVerdictV1 = {
    payloadVersion: SHADOW_VERDICT_PAYLOAD_VERSION,
    mode: intent === 'advise' ? 'shadow' : 'warn',
    effectiveMode: intent === 'advise' ? 'shadow' : effective.effectiveMode,
    completionEffect: 'none', intent: resolveShadowIntent(snapshot, selection, options.config),
    ...precedence, capabilityReasons: capability.reasons, fault: gateFault,
    gates: gates.map(gate => ({
      gateId: gate.gateId, state: gate.state, reason: gate.reason,
      evidenceEventSeq: gate.evidenceEventSeq,
    })),
  };
  return {
    snapshot, selection, verdict, worktreeDigest: evaluationWorktreeDigest(gateDigests),
    audit: {
      project: options.identity.project, sessionId: options.identity.sessionId,
      clientName: options.identity.clientName, occurredAt: options.occurredAt,
      mode: verdict.mode, effectiveMode: verdict.effectiveMode,
      completionEffect: verdict.completionEffect,
      intent: verdict.intent, result: verdict.result, reason: verdict.reason, fault: verdict.fault,
      configVersion: options.config.config.version, configSha256: options.config.sha256,
      evaluatedThrough: snapshot.sequence, rules: auditRules(snapshot, selection),
      requiredGateIds: selection.requiredGateIds, gates,
      capabilityReasons: capability.reasons, stopHookActive: options.stopHookActive,
      evaluatorVersion: SHADOW_EVALUATOR_VERSION, digestVersion: WORKTREE_DIGEST_V2_VERSION,
    },
  };
}
function faultVerdict(
  fault: ShadowFaultCode,
  intent: ShadowVerdictV1['intent'],
): ShadowVerdictV1 {
  const precedence = resolveShadowPrecedence({
    applicableRuleCount: 0, requiredGateCount: 0, gateStates: [], evaluatorFault: fault,
  });
  return {
    payloadVersion: SHADOW_VERDICT_PAYLOAD_VERSION,
    mode: intent === 'advise' ? 'shadow' : 'warn',
    effectiveMode: intent === 'advise' ? 'shadow' : 'advisory', completionEffect: 'none',
    intent, ...precedence, capabilityReasons: [], fault, gates: [],
  };
}
function persistFault(options: {
  fault: ShadowFaultCode;
  identity: ResolvedShadowIdentity;
  config: LoadedGateConfig | null;
  repository: ShadowEvaluatorRepository;
  snapshot: ShadowEvaluationSnapshot | null;
  selection: EvidenceRequirementSelection | null;
  occurredAt: string;
  stopHookActive: boolean;
  retryCount: 0 | 1;
  elapsedMs: number;
}): { verdict: ShadowVerdictV1; persistence: ShadowVerdictPersistenceResult | null } {
  const intent = resolveShadowIntent(options.snapshot, options.selection, options.config);
  const verdict = faultVerdict(options.fault, intent);
  if (options.snapshot === null) return { verdict, persistence: null };
  const selection = options.selection ?? {
    applicableRules: [], requiredGateIds: [], relevantPathsByGate: {}, watermarkByGate: {},
    changedPaths: [], unknownMutation: false,
  };
  const persistence = options.repository.persistShadowStopVerdict({
    project: options.identity.project, sessionId: options.identity.sessionId,
    clientName: options.identity.clientName, occurredAt: options.occurredAt,
    mode: verdict.mode, effectiveMode: verdict.effectiveMode,
    completionEffect: verdict.completionEffect,
    intent, result: verdict.result, reason: verdict.reason, fault: options.fault,
    configVersion: options.config?.config.version ?? null,
    configSha256: options.config?.sha256 ?? null,
    evaluatedThrough: options.snapshot.sequence,
    rules: auditRules(options.snapshot, selection), requiredGateIds: [], gates: [],
    capabilityReasons: [], stopHookActive: options.stopHookActive,
    evaluatorVersion: SHADOW_EVALUATOR_VERSION, digestVersion: WORKTREE_DIGEST_V2_VERSION,
    elapsedMs: options.elapsedMs, retryCount: options.retryCount,
  });
  return { verdict, persistence };
}
/** Advisory-only Stop evaluation. The returned diagnostic is never hook output. */
export async function evaluateShadowStop(
  db: Database.Database,
  input: ShadowStopEvaluatorInput,
  options: ShadowEvaluatorOptions = {},
): Promise<ShadowEvaluationDiagnostic> {
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  const startedAt = monotonicNow();
  const deadline = new ShadowDeadline(
    startedAt, monotonicNow, options.budgetMs ?? GOVERNANCE_BOUNDS.SHADOW_EVALUATOR_DEFAULT_BUDGET_MS, options.onStage,
  );
  const repository = options.repository ?? new GovernanceRepository(db);
  const loadConfig = options.loadConfig ?? loadGateConfig;
  const captureDigest = options.captureDigest ?? captureWorktreeDigestV2;
  const occurredAt = new Date((options.wallNowMs ?? Date.now)()).toISOString();
  let identity: ResolvedShadowIdentity;
  try {
    deadline.check('identity');
    identity = resolveShadowIdentity(input);
  } catch (error) {
    const fault = error instanceof ShadowEvaluationError
      ? error.fault : boundedInputFault(input);
    return {
      status: 'not_persisted', verdict: faultVerdict(fault, 'advise'),
      persistence: null, elapsedMs: deadline.elapsed(), retryCount: 0,
    };
  }

  let config: LoadedGateConfig | null = null;
  let loaderFault: ShadowFaultCode | null = null;
  try {
    deadline.check('config');
    config = loadConfig(identity.projectRoot);
    deadline.useConfigBudget(config, options.budgetMs !== undefined);
  } catch (error) {
    loaderFault = error instanceof ShadowEvaluationError
      ? error.fault : configFault(error, configEntryPresent(identity.projectRoot));
  }

  for (const retryCount of [0, 1] as const) {
    let snapshot: ShadowEvaluationSnapshot | null = null;
    let selection: EvidenceRequirementSelection | null = null;
    try {
      if (loaderFault !== null) {
        snapshot = preparedShadowSnapshot(repository, identity, '', occurredAt, deadline);
        selection = selectShadowRequirements(snapshot, null, deadline);
        if (loaderFault === 'config_missing' && snapshot.rules.length === 0 &&
            !configEntryPresent(identity.projectRoot)) {
          return {
            status: 'skipped', verdict: null, persistence: null,
            elapsedMs: deadline.elapsed(), retryCount,
          };
        }
        throw new ShadowEvaluationError(loaderFault, 'gate config unavailable');
      }
      const attempt = await evaluateAttempt({
        identity, config: config!, repository, captureDigest, occurredAt,
        stopHookActive: input.stopHookActive, deadline,
        onContext: (currentSnapshot, currentSelection) => {
          snapshot = currentSnapshot;
          selection = currentSelection;
        },
      });
      snapshot = attempt.snapshot;
      selection = attempt.selection;
      if (options.persist === false) {
        const checked = repository.recheckShadowSequence?.(
          identity.project, attempt.snapshot.sequence, retryCount,
        ) ?? { status: 'unchanged' as const, sequence: attempt.snapshot.sequence, fault: null };
        if (checked.status === 'retry' && retryCount === 0) continue;
        if (checked.status === 'self_error') {
          return {
            status: 'not_persisted', verdict: faultVerdict(checked.fault, attempt.verdict.intent),
            persistence: null, elapsedMs: deadline.elapsed(), retryCount,
          };
        }
        options.onResolved?.({
          identity, config: config!, snapshot: attempt.snapshot, selection: attempt.selection,
          verdict: attempt.verdict, worktreeDigest: attempt.worktreeDigest,
        });
        return {
          status: 'not_persisted', verdict: attempt.verdict, persistence: null,
          elapsedMs: deadline.elapsed(), retryCount,
        };
      }
      deadline.check('persist');
      const persistence = repository.persistShadowStopVerdict({
        ...attempt.audit, elapsedMs: deadline.elapsed(), retryCount,
      });
      if (persistence.status === 'retry' && retryCount === 0) continue;
      if (persistence.status === 'self_error') {
        return {
          status: 'not_persisted', verdict: faultVerdict(persistence.fault, attempt.verdict.intent),
          persistence, elapsedMs: deadline.elapsed(), retryCount,
        };
      }
      return {
        status: 'persisted', verdict: attempt.verdict, persistence,
        elapsedMs: deadline.elapsed(), retryCount,
      };
    } catch (error) {
      const fault = error instanceof ShadowEvaluationError ? error.fault
        : error instanceof ShadowRepositoryError ? error.fault : 'unexpected_error';
      if (options.persist === false) {
        return {
          status: 'not_persisted',
          verdict: faultVerdict(fault, resolveShadowIntent(snapshot, selection, config)),
          persistence: null, elapsedMs: deadline.elapsed(), retryCount,
        };
      }
      const persisted = persistFault({
        fault, identity, config, repository, snapshot, selection, occurredAt,
        stopHookActive: input.stopHookActive, retryCount, elapsedMs: deadline.elapsed(),
      });
      if (persisted.persistence?.status === 'retry' && retryCount === 0) continue;
      return {
        status: persisted.persistence?.status === 'persisted' ? 'persisted' : 'not_persisted',
        verdict: persisted.verdict, persistence: persisted.persistence,
        elapsedMs: deadline.elapsed(), retryCount,
      };
    }
  }
  throw new Error('unreachable shadow retry state');
}

function boundedInputFault(input: ShadowStopEvaluatorInput): ShadowFaultCode {
  return typeof input.projectRoot !== 'string' || input.projectRoot.length === 0
    ? 'invalid_project_root' : 'invalid_stop_identity';
}
