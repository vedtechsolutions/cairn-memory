import type { CapabilityStatus } from './capability-status.js';
import type {
  GovernanceIntent, ShadowFaultCode,
} from './verdict-types.js';

export type GovernanceEffectiveMode = 'advisory' | 'warn';

export type EffectiveModeReason =
  | 'intent_advisory'
  | 'config_unavailable'
  | 'capability_degraded'
  | 'structured_output_unavailable'
  | 'settings_source_unavailable'
  | 'evaluator_fault'
  | 'block_clamped_to_warn'
  | 'stop_hook_active_non_controlling';

export interface EffectiveModeResolution {
  intent: GovernanceIntent;
  effectiveMode: GovernanceEffectiveMode;
  clampedFromBlock: boolean;
  degraded: boolean;
  reasons: EffectiveModeReason[];
  capabilityReasons: CapabilityStatus['reasons'];
  fault: ShadowFaultCode | null;
  stopHookActive: boolean;
}

/** Pure Slice C mode resolution. Warn never changes Stop completion behavior. */
export function resolveEffectiveMode(options: {
  intent: GovernanceIntent;
  configValid: boolean;
  capability: {
    degraded: boolean;
    reasons: ReadonlyArray<CapabilityStatus['reasons'][number]>;
    observations: Pick<CapabilityStatus['observations'], 'structuredOutput' | 'settingsSource'>;
  };
  fault: ShadowFaultCode | null;
  stopHookActive: boolean;
}): EffectiveModeResolution {
  const reasons: EffectiveModeReason[] = [];
  if (options.intent === 'advise') reasons.push('intent_advisory');
  if (!options.configValid) reasons.push('config_unavailable');
  if (options.capability.degraded) reasons.push('capability_degraded');
  if (options.capability.observations.structuredOutput !== 'observed') {
    reasons.push('structured_output_unavailable');
  }
  if (options.capability.observations.settingsSource !== 'observed') {
    reasons.push('settings_source_unavailable');
  }
  if (options.fault !== null) reasons.push('evaluator_fault');

  const warnEligible = options.intent !== 'advise' && options.configValid &&
    !options.capability.degraded && options.fault === null &&
    options.capability.observations.structuredOutput === 'observed' &&
    options.capability.observations.settingsSource === 'observed';
  if (warnEligible && options.intent === 'block') reasons.push('block_clamped_to_warn');
  if (warnEligible && options.stopHookActive) reasons.push('stop_hook_active_non_controlling');

  return {
    intent: options.intent,
    effectiveMode: warnEligible ? 'warn' : 'advisory',
    clampedFromBlock: warnEligible && options.intent === 'block',
    degraded: !warnEligible && options.intent !== 'advise',
    reasons,
    capabilityReasons: [...options.capability.reasons],
    fault: options.fault,
    stopHookActive: options.stopHookActive,
  };
}
