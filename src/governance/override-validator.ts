import { GOVERNANCE_BOUNDS } from '../constants/index.js';

export const GOVERNANCE_OVERRIDE_PAYLOAD_VERSION = 1;

export interface GovernanceOverrideRuleBinding {
  ruleId: string;
  revision: number;
}

export interface GovernanceOverrideCandidate {
  auditId: number;
  payloadVersion: typeof GOVERNANCE_OVERRIDE_PAYLOAD_VERSION;
  actorClass: 'user-confirmed';
  project: string;
  sessionId: string;
  configSha256: string;
  worktreeDigest: string;
  rules: GovernanceOverrideRuleBinding[];
  gateIds: string[];
  issuedAt: string;
  expiresAt: string;
}

export interface GovernanceOverrideContext {
  project: string;
  sessionId: string;
  configSha256: string;
  worktreeDigest: string;
  rules: readonly GovernanceOverrideRuleBinding[];
  gateIds: readonly string[];
  nowMs: number;
}

export type OverrideInvalidReason =
  | 'malformed'
  | 'project_mismatch'
  | 'session_mismatch'
  | 'config_mismatch'
  | 'digest_mismatch'
  | 'rule_revision_mismatch'
  | 'gate_set_mismatch'
  | 'duration_exceeded'
  | 'expired';

export type OverrideValidation =
  | { valid: true; auditId: number }
  | { valid: false; reason: OverrideInvalidReason };

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function exactStrings(left: readonly string[], right: readonly string[]): boolean {
  const a = [...new Set(left)].sort(compareStrings);
  const b = [...new Set(right)].sort(compareStrings);
  return a.length === left.length && b.length === right.length &&
    a.length === b.length && a.every((value, index) => value === b[index]);
}

function ruleKeys(rules: readonly GovernanceOverrideRuleBinding[]): string[] {
  return rules.map(rule => `${rule.ruleId}\0${rule.revision}`);
}

function validRuleBindings(rules: readonly GovernanceOverrideRuleBinding[]): boolean {
  return rules.length > 0 && rules.every(rule =>
    /^[a-z][a-z0-9_-]{0,63}$/u.test(rule.ruleId) &&
    Number.isSafeInteger(rule.revision) && rule.revision > 0);
}

function validGateIds(gateIds: readonly string[]): boolean {
  return gateIds.length > 0 && gateIds.every(gateId => /^[a-z][a-z0-9_-]{0,63}$/u.test(gateId));
}

/** Exact, fail-closed binding validation. Invalid candidates are silently ignored by callers. */
export function validateGovernanceOverride(
  candidate: GovernanceOverrideCandidate,
  context: GovernanceOverrideContext,
): OverrideValidation {
  const issuedMs = Date.parse(candidate.issuedAt);
  const expiresMs = Date.parse(candidate.expiresAt);
  if (!Number.isSafeInteger(candidate.auditId) || candidate.auditId <= 0 ||
      candidate.payloadVersion !== GOVERNANCE_OVERRIDE_PAYLOAD_VERSION ||
      candidate.actorClass !== 'user-confirmed' || !Number.isFinite(issuedMs) ||
      !Number.isFinite(expiresMs) || !validRuleBindings(candidate.rules) ||
      !validGateIds(candidate.gateIds) ||
      !candidate.project || !candidate.sessionId || !candidate.configSha256 ||
      !candidate.worktreeDigest) {
    return { valid: false, reason: 'malformed' };
  }
  if (candidate.project !== context.project) return { valid: false, reason: 'project_mismatch' };
  if (candidate.sessionId !== context.sessionId) return { valid: false, reason: 'session_mismatch' };
  if (candidate.configSha256 !== context.configSha256) return { valid: false, reason: 'config_mismatch' };
  if (candidate.worktreeDigest !== context.worktreeDigest) return { valid: false, reason: 'digest_mismatch' };
  if (!exactStrings(ruleKeys(candidate.rules), ruleKeys(context.rules))) {
    return { valid: false, reason: 'rule_revision_mismatch' };
  }
  if (!exactStrings(candidate.gateIds, context.gateIds)) {
    return { valid: false, reason: 'gate_set_mismatch' };
  }
  if (expiresMs <= issuedMs || expiresMs - issuedMs > GOVERNANCE_BOUNDS.OVERRIDE_MAX_DURATION_MS) {
    return { valid: false, reason: 'duration_exceeded' };
  }
  if (expiresMs <= context.nowMs) return { valid: false, reason: 'expired' };
  return { valid: true, auditId: candidate.auditId };
}
