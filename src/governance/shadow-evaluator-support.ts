import { realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { projectId } from '../utils/project-id.js';
import { GateConfigError, type LoadedGateConfig } from './gate-config.js';
import type {
  EvidenceRequirementSelection, ClassifiedGateEvidence,
} from './evidence-selector.js';
import type {
  ShadowAuditGateInput, ShadowAuditRuleInput, ShadowEvaluationSnapshot,
} from './repository.js';
import {
  SHADOW_FAULT_CODES, type GovernanceIntent, type ShadowFaultCode,
} from './verdict-types.js';
import { CLAUDE_ADAPTER_VERSION } from './types.js';
import {
  WORKTREE_DIGEST_V2_VERSION, type WorktreeDigestV2Result,
} from './worktree-digest.js';

export interface ResolvedShadowIdentity {
  project: string;
  projectRoot: string;
  sessionId: string;
  clientName: string;
  clientInstallationId: string;
}

export class ShadowEvaluationError extends Error {
  constructor(readonly fault: ShadowFaultCode, message: string) {
    super(message);
    this.name = 'ShadowEvaluationError';
  }
}

function boundedIdentity(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 &&
    !value.includes('\0');
}

export function resolveShadowIdentity(input: {
  sessionId: unknown;
  projectRoot: unknown;
  clientName: unknown;
  clientInstallationId: unknown;
}): ResolvedShadowIdentity {
  if (!boundedIdentity(input.sessionId) || !boundedIdentity(input.clientName) ||
      !boundedIdentity(input.clientInstallationId)) {
    throw new ShadowEvaluationError('invalid_stop_identity', 'invalid Stop identity');
  }
  if (!boundedIdentity(input.projectRoot)) {
    throw new ShadowEvaluationError('invalid_project_root', 'invalid project root');
  }
  let projectRoot: string;
  try {
    projectRoot = realpathSync.native(resolve(input.projectRoot));
    if (!statSync(projectRoot).isDirectory()) throw new Error('not a directory');
  } catch {
    throw new ShadowEvaluationError('invalid_project_root', 'project root is unavailable');
  }
  return {
    project: projectId(projectRoot), projectRoot, sessionId: input.sessionId,
    clientName: input.clientName, clientInstallationId: input.clientInstallationId,
  };
}

export function configFault(error: unknown, configEntryPresent: boolean): ShadowFaultCode {
  if (!(error instanceof GateConfigError)) return 'unexpected_error';
  if (error.code === 'invalid-project-root') return 'invalid_project_root';
  if (error.code === 'config-too-large') return 'config_oversized';
  if (error.code === 'path-escape') return 'config_path_escape';
  if (error.code === 'invalid-config-path' && !configEntryPresent) return 'config_missing';
  return 'config_invalid';
}

export function digestFault(result: WorktreeDigestV2Result): ShadowFaultCode | null {
  if (result.status === 'complete') {
    return result.version === WORKTREE_DIGEST_V2_VERSION ? null : 'unsupported_digest_version';
  }
  const reason = result.reason ?? '';
  if (reason.includes('deadline exceeded')) return 'deadline_exceeded';
  if (reason.includes('changed during both')) return 'digest_race';
  if (reason.includes('bound') || reason.includes('exceeds')) return 'digest_bound_exceeded';
  return 'digest_unavailable';
}

const INTENT_ORDER: Readonly<Record<GovernanceIntent, number>> = {
  advise: 0, warn: 1, block: 2,
};

export function resolveShadowIntent(
  snapshot: ShadowEvaluationSnapshot | null,
  selection: EvidenceRequirementSelection | null,
  config: LoadedGateConfig | null,
): GovernanceIntent {
  if (snapshot !== null && selection !== null && selection.applicableRules.length > 0) {
    const applicable = new Set(selection.applicableRules.map(rule => `${rule.ruleId}:${rule.revision}`));
    return snapshot.rules
      .filter(rule => applicable.has(`${rule.ruleId}:${rule.revision}`))
      .map(rule => rule.level)
      .sort((left, right) => INTENT_ORDER[right] - INTENT_ORDER[left])[0] ??
      config?.config.defaults.level ?? 'advise';
  }
  return config?.config.defaults.level ?? 'advise';
}

export function auditRules(
  snapshot: ShadowEvaluationSnapshot,
  selection: EvidenceRequirementSelection,
): ShadowAuditRuleInput[] {
  const applicable = new Set(selection.applicableRules.map(rule => `${rule.ruleId}:${rule.revision}`));
  return snapshot.rules.filter(rule => applicable.has(`${rule.ruleId}:${rule.revision}`))
    .flatMap(rule => rule.watermark === null ? [] : [{
      ruleId: rule.ruleId, memoryId: rule.memoryId, revision: rule.revision,
      watermarkEventSeq: rule.watermark.eventSeq,
      watermarkMutationSeq: rule.watermark.mutationSeq,
    }]);
}

export function auditGate(
  gateId: string,
  classified: ClassifiedGateEvidence,
  run: ShadowEvaluationSnapshot['gateRuns'][number] | null,
): ShadowAuditGateInput {
  return {
    gateId, state: classified.state, reason: classified.reason,
    evidenceEventSeq: classified.evidenceEventSeq,
    captureResult: run?.captureResult ?? null,
    parserName: run?.parserName ?? null,
    parserVersion: run?.parserVersion ?? null,
    digestVersion: run?.digestVersion ?? null,
  };
}

export function classifiedFault(gates: readonly ShadowAuditGateInput[]): ShadowFaultCode | null {
  const faults = new Set<string>(SHADOW_FAULT_CODES);
  return gates.find(gate => gate.state === 'self_error' && faults.has(gate.reason))
    ?.reason as ShadowFaultCode | undefined ?? null;
}

export function assertSupportedAdapter(snapshot: ShadowEvaluationSnapshot): void {
  if (snapshot.capability !== null && snapshot.capability.adapterVersion !== CLAUDE_ADAPTER_VERSION) {
    throw new ShadowEvaluationError('unsupported_adapter_version', 'unsupported capability adapter');
  }
}
