import { createHash } from 'node:crypto';
import type { NormalizedGate } from './gate-config.js';
import { redactArgv } from './redaction.js';
import type { GovernanceEffectiveMode } from './effective-mode.js';
import type {
  GateEvidenceState, ShadowResult, ShadowVerdictReason,
} from './verdict-types.js';
import { GOVERNANCE_BOUNDS } from '../constants/index.js';

export const CLAUDE_HOOK_NON_BLOCKING_MESSAGE_FIELD = 'systemMessage' as const;

export interface WarningFingerprintInput {
  project: string;
  configSha256: string;
  unresolvedGates: ReadonlyArray<{ gateId: string; state: GateEvidenceState }>;
  result: ShadowResult;
  reason: ShadowVerdictReason;
  worktreeDigest: string;
}

export interface WarningAuditObservation {
  eventType: 'warning_emitted' | 'warning_suppressed';
  fingerprint: string;
}

export interface WarningDecision {
  emit: boolean;
  auditEventType: WarningAuditObservation['eventType'];
  reason: 'eligible' | 'duplicate_fingerprint' | 'session_ceiling';
}

export type WarnDisposition = 'silent' | 'visible_unresolved' | 'visible_override';

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Canonical fingerprint for one unresolved policy state. */
export function warningFingerprint(input: WarningFingerprintInput): string {
  const canonical = JSON.stringify({
    project: input.project,
    configSha256: input.configSha256,
    unresolvedGates: [...input.unresolvedGates]
      .sort((left, right) => compareStrings(left.gateId, right.gateId) ||
        compareStrings(left.state, right.state))
      .map(gate => [gate.gateId, gate.state]),
    result: input.result,
    reason: input.reason,
    worktreeDigest: input.worktreeDigest,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

export function resolveWarnDisposition(options: {
  effectiveMode: GovernanceEffectiveMode;
  result: ShadowResult;
  overrideValid: boolean;
}): WarnDisposition {
  if (options.effectiveMode !== 'warn') return 'silent';
  if (options.overrideValid) return 'visible_override';
  return ['missing', 'non_pass', 'stale'].includes(options.result)
    ? 'visible_unresolved' : 'silent';
}

export function decideWarningEmission(
  fingerprint: string,
  history: readonly WarningAuditObservation[],
): WarningDecision {
  const emissions = history.filter(row => row.eventType === 'warning_emitted');
  if (emissions.some(row => row.fingerprint === fingerprint)) {
    return { emit: false, auditEventType: 'warning_suppressed', reason: 'duplicate_fingerprint' };
  }
  if (emissions.length >= GOVERNANCE_BOUNDS.WARNING_MAX_PER_SESSION) {
    return { emit: false, auditEventType: 'warning_suppressed', reason: 'session_ceiling' };
  }
  return { emit: true, auditEventType: 'warning_emitted', reason: 'eligible' };
}

function shellArgument(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/u.test(value)) return value;
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function safeDisplay(value: string): string {
  return value.replace(/\b(?:blocked|passed)\b/giu, '[REDACTED]');
}

function boundedJoin(values: readonly string[], maxChars: number): string {
  const included: string[] = [];
  for (const value of values) {
    const candidate = [...included, value].join(', ');
    if (candidate.length > maxChars) return `${included.join(', ')}, …`;
    included.push(value);
  }
  return included.join(', ');
}

function commandText(gate: NormalizedGate): string {
  return redactArgv(gate.argv).map(shellArgument).map(safeDisplay).join(' ');
}

function stateText(state: GateEvidenceState): string {
  switch (state) {
    case 'missing': return 'no eligible run';
    case 'non_pass': return 'last run did not satisfy policy';
    case 'stale_mutation': return 'evidence predates a relevant change';
    case 'stale_digest': return 'worktree differs from the evidence baseline';
    case 'self_error': return 'status unavailable';
    case 'fresh_pass': return 'current evidence satisfies policy';
  }
}

/** Bounded, redacted warning. It accepts no assistant-message input by construction. */
export function renderGovernanceWarning(options: {
  ruleIds: readonly string[];
  gates: ReadonlyArray<{ gateId: string; state: GateEvidenceState; gate: NormalizedGate }>;
  overrideValid: boolean;
  stopHookActive: boolean;
}): string {
  const rules = [...new Set(options.ruleIds)].sort(compareStrings).map(safeDisplay);
  const lines = [
    options.overrideValid
      ? 'Governance warning: a user-confirmed temporary override is active.'
      : 'Governance warning: pre-exit checks remain unresolved.',
    `Rules: ${boundedJoin(rules, 1_024) || '(none)'}`,
  ];
  const closing = 'Completion continues; this warning is non-controlling.';
  const active = 'A prior Stop hook is active; no escalation is performed.';
  for (const item of [...options.gates].sort((left, right) => compareStrings(left.gateId, right.gateId))) {
    const candidate = [
      `- ${safeDisplay(item.gateId)}: ${stateText(item.state)}`,
      `  Rerun from ${safeDisplay(item.gate.cwd)}: ${commandText(item.gate)}`,
    ];
    if ([...lines, ...candidate, ...(options.stopHookActive ? [active] : []), closing]
      .join('\n').length > GOVERNANCE_BOUNDS.WARNING_MAX_CHARS) {
      lines.push('- Additional unresolved checks omitted by the message size limit.');
      break;
    }
    lines.push(...candidate);
  }
  if (options.stopHookActive) lines.push(active);
  lines.push(closing);
  return lines.join('\n');
}
