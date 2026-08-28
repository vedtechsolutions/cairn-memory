import { performance } from 'node:perf_hooks';
import type Database from 'better-sqlite3';
import { loadGateConfig } from './gate-config.js';
import { evaluationWorktreeDigest } from './evaluation-digest.js';
import type { GovernanceOverrideContext } from './override-validator.js';
import { GovernanceRepository } from './repository.js';
import { resolveShadowIdentity } from './shadow-evaluator-support.js';
import {
  selectShadowRequirements, ShadowDeadline,
} from './shadow-evaluator-runtime.js';
import { captureWorktreeDigestV2 } from './worktree-digest.js';

export interface OverrideContextInput {
  projectRoot: string;
  sessionId: string;
  clientName: string;
  nowMs?: number;
}

/** Derive every binding from durable state and the current worktree, never assistant prose. */
export async function deriveGovernanceOverrideContext(
  db: Database.Database,
  input: OverrideContextInput,
): Promise<GovernanceOverrideContext> {
  const identity = resolveShadowIdentity({
    projectRoot: input.projectRoot, sessionId: input.sessionId,
    clientName: input.clientName, clientInstallationId: 'mcp-governance-override',
  });
  const config = loadGateConfig(identity.projectRoot);
  const started = performance.now();
  const deadline = new ShadowDeadline(started, () => performance.now(), 1_000);
  const repository = new GovernanceRepository(db);
  deadline.check('snapshot');
  const snapshot = repository.readShadowSnapshot({
    project: identity.project, sessionId: identity.sessionId,
    clientInstallationId: identity.clientInstallationId, configSha256: config.sha256,
  });
  const selection = selectShadowRequirements(snapshot, config, deadline);
  if (selection.applicableRules.length === 0 || selection.requiredGateIds.length === 0) {
    throw new Error('no applicable gated pre-exit rules to override');
  }
  const gateDigests = [];
  for (const gateId of selection.requiredGateIds) {
    const digest = await captureWorktreeDigestV2({
      projectRoot: identity.projectRoot, configSha256: config.sha256,
      relevantPaths: selection.relevantPathsByGate[gateId] ?? ['**'],
      deadlineMs: deadline.absolute(),
    });
    if (digest.status !== 'complete' || digest.digest === null) {
      throw new Error('current worktree digest is unavailable');
    }
    gateDigests.push({ gateId, digest: digest.digest });
  }
  return {
    project: identity.project, sessionId: identity.sessionId, configSha256: config.sha256,
    worktreeDigest: evaluationWorktreeDigest(gateDigests),
    rules: selection.applicableRules.map(rule => ({ ruleId: rule.ruleId, revision: rule.revision })),
    gateIds: selection.requiredGateIds, nowMs: input.nowMs ?? Date.now(),
  };
}
