export const SHADOW_VERDICT_PAYLOAD_VERSION = 1;

export const GATE_EVIDENCE_STATES = [
  'fresh_pass',
  'missing',
  'non_pass',
  'stale_mutation',
  'stale_digest',
  'self_error',
] as const;

export const SHADOW_RESULTS = [
  'pass',
  'missing',
  'non_pass',
  'stale',
  'degraded',
  'not_applicable',
  'self_error',
] as const;

export const CAPABILITY_DEGRADATION_REASONS = [
  'unsupported_client',
  'missing_post_tool_use',
  'missing_post_tool_failure',
  'missing_file_changed',
  'missing_stop',
  'async_only_stop',
  'blocking_unavailable',
  'stale_heartbeat',
  'missing_settings_source',
] as const;

export const SHADOW_FAULT_CODES = [
  'invalid_stop_identity',
  'invalid_project_root',
  'unsupported_client',
  'config_missing',
  'config_invalid',
  'config_oversized',
  'config_path_escape',
  'database_unavailable',
  'database_busy',
  'schema_unavailable',
  'rule_malformed',
  'evidence_malformed',
  'unsupported_adapter_version',
  'unsupported_parser_version',
  'unsupported_digest_version',
  'unsupported_payload_version',
  'impossible_result_counts',
  'digest_unavailable',
  'digest_bound_exceeded',
  'digest_race',
  'deadline_exceeded',
  'concurrent_mutation',
  'serialization_bound_exceeded',
  'audit_write_failed',
  'unexpected_error',
] as const;

export type GateEvidenceState = (typeof GATE_EVIDENCE_STATES)[number];
export type ShadowResult = (typeof SHADOW_RESULTS)[number];
export type CapabilityDegradationReason = (typeof CAPABILITY_DEGRADATION_REASONS)[number];
export type ShadowFaultCode = (typeof SHADOW_FAULT_CODES)[number];
export type GovernanceIntent = 'advise' | 'warn' | 'block';

export type ShadowVerdictReason =
  | ShadowFaultCode
  | CapabilityDegradationReason
  | 'gate_self_error'
  | 'no_active_pre_exit_rule'
  | 'empty_requirement_set'
  | 'gate_non_pass'
  | 'gate_stale'
  | 'gate_missing'
  | 'all_required_gates_fresh';

export interface GateShadowVerdict {
  gateId: string;
  state: GateEvidenceState;
  reason: string;
  evidenceEventSeq: number | null;
}

export interface ShadowVerdictV1 {
  payloadVersion: typeof SHADOW_VERDICT_PAYLOAD_VERSION;
  mode: 'shadow' | 'warn';
  effectiveMode: 'shadow' | 'advisory' | 'warn';
  completionEffect: 'none';
  intent: GovernanceIntent;
  result: ShadowResult;
  reason: ShadowVerdictReason;
  capabilityReasons: CapabilityDegradationReason[];
  fault: ShadowFaultCode | null;
  gates: GateShadowVerdict[];
}

export interface ShadowPrecedenceInput {
  applicableRuleCount: number;
  requiredGateCount: number;
  gateStates: readonly GateEvidenceState[];
  capabilityReasons?: readonly CapabilityDegradationReason[];
  evaluatorFault?: ShadowFaultCode | null;
}

export interface ShadowPrecedenceResult {
  result: ShadowResult;
  reason: ShadowVerdictReason;
}

/** Fixed §7.2 ordering. Only the final branch can produce a positive pass. */
export function resolveShadowPrecedence(input: ShadowPrecedenceInput): ShadowPrecedenceResult {
  if (input.evaluatorFault !== null && input.evaluatorFault !== undefined) {
    return { result: 'self_error', reason: input.evaluatorFault };
  }
  if (input.gateStates.includes('self_error')) {
    return { result: 'self_error', reason: 'gate_self_error' };
  }
  if (!Number.isSafeInteger(input.applicableRuleCount) || input.applicableRuleCount < 0 ||
      !Number.isSafeInteger(input.requiredGateCount) || input.requiredGateCount < 0 ||
      input.gateStates.length > input.requiredGateCount) {
    return { result: 'self_error', reason: 'evidence_malformed' };
  }
  if (input.applicableRuleCount === 0) {
    return { result: 'not_applicable', reason: 'no_active_pre_exit_rule' };
  }
  if ((input.capabilityReasons?.length ?? 0) > 0) {
    return { result: 'degraded', reason: input.capabilityReasons![0] };
  }
  if (input.gateStates.includes('non_pass')) {
    return { result: 'non_pass', reason: 'gate_non_pass' };
  }
  if (input.gateStates.includes('stale_mutation') || input.gateStates.includes('stale_digest')) {
    return { result: 'stale', reason: 'gate_stale' };
  }
  if (input.requiredGateCount === 0) {
    return { result: 'missing', reason: 'empty_requirement_set' };
  }
  if (input.gateStates.includes('missing') || input.gateStates.length < input.requiredGateCount) {
    return { result: 'missing', reason: 'gate_missing' };
  }
  if (input.gateStates.length === input.requiredGateCount &&
      input.gateStates.every(state => state === 'fresh_pass')) {
    return { result: 'pass', reason: 'all_required_gates_fresh' };
  }
  return { result: 'self_error', reason: 'evidence_malformed' };
}
