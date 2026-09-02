import { lstatSync } from 'node:fs';
import type { EvidenceRequirementSelection } from './evidence-selector.js';
import { selectEvidenceRequirements } from './evidence-selector.js';
import type { LoadedGateConfig } from './gate-config.js';
import type { GovernanceRepository, ShadowEvaluationSnapshot } from './repository.js';
import {
  ShadowEvaluationError, type ResolvedShadowIdentity,
} from './shadow-evaluator-support.js';
import { WORKTREE_DIGEST_HARD_CEILING_MS } from './worktree-digest.js';
import { gatesPath } from '../constants/paths.js';

export const SHADOW_EVALUATOR_DEFAULT_BUDGET_MS = 250;
export const SHADOW_EVALUATOR_HARD_CEILING_MS = WORKTREE_DIGEST_HARD_CEILING_MS;

export type ShadowEvaluatorStage =
  | 'identity' | 'config' | 'snapshot' | 'watermarks' | 'snapshot-refresh'
  | 'selection' | 'digest' | 'classification' | 'capability' | 'precedence' | 'persist';

export interface ShadowEvaluatorRepository {
  readShadowSnapshot: GovernanceRepository['readShadowSnapshot'];
  ensureShadowRuleWatermarks: GovernanceRepository['ensureShadowRuleWatermarks'];
  persistShadowStopVerdict: GovernanceRepository['persistShadowStopVerdict'];
  recheckShadowSequence?: GovernanceRepository['recheckShadowSequence'];
}

export class ShadowDeadline {
  private budgetMs: number;

  constructor(
    readonly startedAt: number,
    private readonly now: () => number,
    budgetMs: number,
    private readonly onStage?: (stage: ShadowEvaluatorStage) => void,
  ) {
    this.budgetMs = Math.min(budgetMs, SHADOW_EVALUATOR_HARD_CEILING_MS);
  }

  useConfigBudget(config: LoadedGateConfig, explicitBudget: boolean): void {
    if (!explicitBudget) {
      this.budgetMs = Math.min(
        config.config.defaults.evaluationTimeoutMs, SHADOW_EVALUATOR_HARD_CEILING_MS,
      );
    }
  }

  check(stage: ShadowEvaluatorStage): void {
    this.onStage?.(stage);
    if (this.now() - this.startedAt >= this.budgetMs) {
      throw new ShadowEvaluationError('deadline_exceeded', `shadow deadline exceeded at ${stage}`);
    }
  }

  absolute(): number {
    return this.startedAt + this.budgetMs;
  }

  elapsed(): number {
    return Math.max(0, Math.ceil(this.now() - this.startedAt));
  }
}

export function configEntryPresent(root: string): boolean {
  try {
    lstatSync(gatesPath(root));
    return true;
  } catch {
    return false;
  }
}

export function preparedShadowSnapshot(
  repository: ShadowEvaluatorRepository,
  identity: ResolvedShadowIdentity,
  configSha256: string,
  occurredAt: string,
  deadline: ShadowDeadline,
): ShadowEvaluationSnapshot {
  deadline.check('snapshot');
  let snapshot = repository.readShadowSnapshot({
    project: identity.project, sessionId: identity.sessionId,
    clientInstallationId: identity.clientInstallationId, configSha256,
  });
  if (snapshot.rules.some(rule => rule.watermark === null)) {
    deadline.check('watermarks');
    const ensured = repository.ensureShadowRuleWatermarks({
      project: identity.project, occurredAt, rules: snapshot.rules,
    });
    if (ensured.requiresRefresh) {
      deadline.check('snapshot-refresh');
      snapshot = repository.readShadowSnapshot({
        project: identity.project, sessionId: identity.sessionId,
        clientInstallationId: identity.clientInstallationId, configSha256,
      });
    }
  }
  if (snapshot.rules.some(rule => rule.watermark === null)) {
    throw new ShadowEvaluationError('rule_malformed', 'active rule watermark is unavailable');
  }
  return snapshot;
}

export function selectShadowRequirements(
  snapshot: ShadowEvaluationSnapshot,
  config: LoadedGateConfig | null,
  deadline: ShadowDeadline,
): EvidenceRequirementSelection {
  deadline.check('selection');
  return selectEvidenceRequirements({
    rules: snapshot.rules.map(rule => ({
      ruleId: rule.ruleId, revision: rule.revision, gateIds: rule.gateIds,
      paths: rule.paths, watermarkEventSeq: rule.watermark?.eventSeq ?? 0,
    })),
    pathRules: config?.config.pathRules ?? [], events: snapshot.events,
  });
}
