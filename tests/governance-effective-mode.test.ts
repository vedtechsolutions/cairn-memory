import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveEffectiveMode } from '../src/governance/effective-mode.js';
import {
  resolveWarnDisposition,
} from '../src/governance/warning-policy.js';
import type { ShadowResult } from '../src/governance/verdict-types.js';

const healthy = {
  degraded: false, reasons: [] as const,
  observations: { structuredOutput: 'observed' as const, settingsSource: 'observed' as const },
};
const degraded = {
  degraded: true, reasons: ['missing_file_changed'] as const,
  observations: { structuredOutput: 'observed' as const, settingsSource: 'observed' as const },
};

describe('Slice C effective warn matrix', () => {
  it('requires explicit warn intent from a valid config and healthy evaluation', () => {
    assert.equal(resolveEffectiveMode({
      intent: 'advise', configValid: true, capability: healthy,
      fault: null, stopHookActive: false,
    }).effectiveMode, 'advisory');
    for (const input of [
      { intent: 'warn' as const, configValid: false, capability: healthy, fault: null },
      { intent: 'warn' as const, configValid: true, capability: degraded, fault: null },
      { intent: 'warn' as const, configValid: true, capability: healthy, fault: 'digest_race' as const },
    ]) {
      assert.equal(resolveEffectiveMode({ ...input, stopHookActive: false }).effectiveMode, 'advisory');
    }
    assert.equal(resolveEffectiveMode({
      intent: 'warn', configValid: true, capability: healthy,
      fault: null, stopHookActive: false,
    }).effectiveMode, 'warn');
    for (const capability of [
      { ...healthy, observations: { ...healthy.observations, structuredOutput: 'unsupported' as const } },
      { ...healthy, observations: { ...healthy.observations, settingsSource: 'not_observed' as const } },
    ]) {
      assert.equal(resolveEffectiveMode({
        intent: 'warn', configValid: true, capability, fault: null, stopHookActive: false,
      }).effectiveMode, 'advisory');
    }
  });

  it('clamps block intent to warn and keeps an active Stop hook non-controlling', () => {
    const resolution = resolveEffectiveMode({
      intent: 'block', configValid: true, capability: healthy,
      fault: null, stopHookActive: true,
    });
    assert.equal(resolution.effectiveMode, 'warn');
    assert.equal(resolution.clampedFromBlock, true);
    assert.deepEqual(resolution.reasons, [
      'block_clamped_to_warn', 'stop_hook_active_non_controlling',
    ]);
  });

  it('covers every Warn-column verdict cell without continuation control', () => {
    const cases: Array<[ShadowResult, boolean, string]> = [
      ['pass', false, 'silent'],
      ['missing', false, 'visible_unresolved'],
      ['stale', false, 'visible_unresolved'],
      ['non_pass', false, 'visible_unresolved'],
      ['missing', true, 'visible_override'],
      ['self_error', false, 'silent'],
      ['degraded', false, 'silent'],
      ['not_applicable', false, 'silent'],
    ];
    for (const [result, overrideValid, expected] of cases) {
      assert.equal(resolveWarnDisposition({
        effectiveMode: result === 'self_error' || result === 'degraded' ? 'advisory' : 'warn',
        result, overrideValid,
      }), expected, result);
    }
  });
});
