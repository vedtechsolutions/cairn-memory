import type Database from 'better-sqlite3';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { projectId } from '../utils/project-id.js';
import { resolveCapabilityStatus } from './capability-status.js';
import { resolveEffectiveMode } from './effective-mode.js';
import { observeGovernanceGate } from './governance-client-observation.js';
import { GovernanceOverrideStore } from './governance-overrides.js';
import { GovernanceWarningAuditStore } from './governance-warning-audit.js';
import {
  evaluateShadowStop, type ShadowEvaluationDiagnostic, type ShadowResolvedEvaluation,
  type ShadowStopEvaluatorInput,
} from './shadow-evaluator.js';
import { shadowStopEvaluatorInput, type ShadowStopWireInput } from './shadow-stop.js';
import {
  CLAUDE_HOOK_NON_BLOCKING_MESSAGE_FIELD, renderGovernanceWarning,
  resolveWarnDisposition, warningFingerprint,
} from './warning-policy.js';

export const GOVERNANCE_GATE_ROUTE = '/governance-gate';

export interface WarnStopOptions {
  nowMs?: () => number;
  evaluate?: (
    db: Database.Database,
    input: ShadowStopEvaluatorInput,
    options: NonNullable<Parameters<typeof evaluateShadowStop>[2]>,
  ) => Promise<ShadowEvaluationDiagnostic>;
}

/** The only Slice C hook output adapter. It cannot express a control decision. */
export function governanceWarningHookOutput(message: string): string {
  return JSON.stringify({ [CLAUDE_HOOK_NON_BLOCKING_MESSAGE_FIELD]: message });
}

function bestEffortIncident(
  db: Database.Database,
  input: ShadowStopEvaluatorInput,
  occurredAt: string,
  reason: string,
): void {
  try {
    const root = realpathSync.native(resolve(input.projectRoot));
    new GovernanceWarningAuditStore(db).incident({
      project: projectId(root), sessionId: input.sessionId,
      clientName: input.clientName, occurredAt, reason,
    });
  } catch { /* incident persistence is best-effort on a failing path */ }
}

/** Synchronous warn evaluation. Every failure is silent and non-controlling. */
export async function evaluateGovernanceWarnStop(
  db: Database.Database,
  wireInput: ShadowStopWireInput,
  options: WarnStopOptions = {},
): Promise<string | null> {
  const nowMs = options.nowMs ?? Date.now;
  const occurredAt = new Date(nowMs()).toISOString();
  const evaluatorInput = shadowStopEvaluatorInput(wireInput);
  try {
    observeGovernanceGate(db, wireInput, occurredAt);
  } catch {
    return null;
  }
  let resolved: ShadowResolvedEvaluation | null = null;
  let diagnostic: ShadowEvaluationDiagnostic;
  try {
    diagnostic = await (options.evaluate ?? evaluateShadowStop)(db, evaluatorInput, {
      persist: false, wallNowMs: nowMs,
      onResolved: value => { resolved = value; },
    });
  } catch {
    bestEffortIncident(db, evaluatorInput, occurredAt, 'unexpected_error');
    return null;
  }
  if (diagnostic.verdict?.fault !== null && diagnostic.verdict?.fault !== undefined) {
    bestEffortIncident(db, evaluatorInput, occurredAt, diagnostic.verdict.fault);
    return null;
  }
  if (resolved === null) return null;
  const current = resolved as ShadowResolvedEvaluation;
  const capability = resolveCapabilityStatus({
    row: current.snapshot.capability, clientName: current.identity.clientName,
    sessionId: current.identity.sessionId, currentStopObserved: true, nowMs: nowMs(),
  });
  const effective = resolveEffectiveMode({
    intent: current.verdict.intent, configValid: true, capability,
    fault: current.verdict.fault, stopHookActive: evaluatorInput.stopHookActive,
  });
  const overrideContext = {
    project: current.identity.project, sessionId: current.identity.sessionId,
    configSha256: current.config.sha256, worktreeDigest: current.worktreeDigest,
    rules: current.selection.applicableRules.map(rule => ({
      ruleId: rule.ruleId, revision: rule.revision,
    })),
    gateIds: current.selection.requiredGateIds, nowMs: nowMs(),
  };
  let overrideAuditId: number | null = null;
  try {
    const override = new GovernanceOverrideStore(db).latest(overrideContext);
    if (override.status === 'self_error') {
      bestEffortIncident(db, evaluatorInput, occurredAt, 'override_audit_write_failed');
      return null;
    }
    if (override.status === 'valid') overrideAuditId = override.candidate.auditId;
  } catch {
    bestEffortIncident(db, evaluatorInput, occurredAt, 'override_read_failed');
    return null;
  }
  const disposition = resolveWarnDisposition({
    effectiveMode: effective.effectiveMode, result: current.verdict.result,
    overrideValid: overrideAuditId !== null,
  });
  if (disposition === 'silent') return null;
  const unresolved = current.verdict.gates.filter(gate => gate.state !== 'fresh_pass');
  const fingerprint = warningFingerprint({
    project: current.identity.project, configSha256: current.config.sha256,
    unresolvedGates: unresolved.map(gate => ({ gateId: gate.gateId, state: gate.state })),
    result: current.verdict.result, reason: current.verdict.reason,
    worktreeDigest: current.worktreeDigest,
  });
  let emission;
  try {
    emission = new GovernanceWarningAuditStore(db).commit({
      project: current.identity.project, sessionId: current.identity.sessionId,
      clientName: current.identity.clientName, occurredAt, fingerprint,
      result: current.verdict.result, reason: current.verdict.reason,
      overrideAuditId, clampedFromBlock: effective.clampedFromBlock,
    });
  } catch {
    bestEffortIncident(db, evaluatorInput, occurredAt, 'warning_audit_failed');
    return null;
  }
  if (!emission.emit) return null;
  const unresolvedSet = new Set(unresolved.map(gate => gate.gateId));
  const message = renderGovernanceWarning({
    ruleIds: current.selection.applicableRules.map(rule => rule.ruleId),
    gates: current.selection.requiredGateIds.flatMap(gateId => {
      const verdictGate = current.verdict.gates.find(gate => gate.gateId === gateId);
      const gate = current.config.config.gates[gateId];
      return verdictGate && gate && (unresolvedSet.has(gateId) || overrideAuditId !== null)
        ? [{ gateId, state: verdictGate.state, gate }] : [];
    }),
    overrideValid: overrideAuditId !== null,
    stopHookActive: evaluatorInput.stopHookActive,
  });
  return governanceWarningHookOutput(message);
}
