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

/**
 * Wall-clock budget for assembling override context. The window spans a
 * filesystem walk and a git subprocess, so it is load-sensitive: an overrun
 * surfaces as an evaluator fault (`self_error`), not a timeout, which makes
 * it easy to misread as a logic bug under CI contention.
 *
 * Equal to WORKTREE_DIGEST_HARD_CEILING_MS by coincidence, not by contract —
 * they bound different work and should be tunable apart.
 */
export const OVERRIDE_CONTEXT_DEADLINE_MS = 1_000;

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
  const deadline = new ShadowDeadline(started, () => performance.now(), OVERRIDE_CONTEXT_DEADLINE_MS);
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
