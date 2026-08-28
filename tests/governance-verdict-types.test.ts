import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveShadowPrecedence } from '../src/governance/verdict-types.js';

describe('governance shadow verdict precedence', () => {
  it('implements the fixed §7.2 order without allowing empty or degraded passes', () => {
    const cases = [
      {
        input: {
          applicableRuleCount: 0, requiredGateCount: 1,
          gateStates: ['fresh_pass'] as const, evaluatorFault: 'database_unavailable' as const,
        },
        expected: { result: 'self_error', reason: 'database_unavailable' },
      },
      {
        input: {
          applicableRuleCount: 1, requiredGateCount: 1,
          gateStates: ['self_error'] as const,
        },
        expected: { result: 'self_error', reason: 'gate_self_error' },
      },
      {
        input: { applicableRuleCount: 0, requiredGateCount: 0, gateStates: [] },
        expected: { result: 'not_applicable', reason: 'no_active_pre_exit_rule' },
      },
      {
        input: {
          applicableRuleCount: 1, requiredGateCount: 1,
          gateStates: ['non_pass'] as const,
          capabilityReasons: ['missing_file_changed'] as const,
        },
        expected: { result: 'degraded', reason: 'missing_file_changed' },
      },
      {
        input: { applicableRuleCount: 1, requiredGateCount: 1, gateStates: ['non_pass'] as const },
        expected: { result: 'non_pass', reason: 'gate_non_pass' },
      },
      {
        input: { applicableRuleCount: 1, requiredGateCount: 1, gateStates: ['stale_digest'] as const },
        expected: { result: 'stale', reason: 'gate_stale' },
      },
      {
        input: { applicableRuleCount: 1, requiredGateCount: 1, gateStates: ['missing'] as const },
        expected: { result: 'missing', reason: 'gate_missing' },
      },
      {
        input: { applicableRuleCount: 1, requiredGateCount: 0, gateStates: [] },
        expected: { result: 'missing', reason: 'empty_requirement_set' },
      },
      {
        input: { applicableRuleCount: 1, requiredGateCount: 1, gateStates: ['fresh_pass'] as const },
        expected: { result: 'pass', reason: 'all_required_gates_fresh' },
      },
    ];
    for (const { input, expected } of cases) {
      assert.deepEqual(resolveShadowPrecedence(input), expected);
    }
  });

  it('treats cardinality or state contradictions as missing/self-error, never pass', () => {
    assert.deepEqual(resolveShadowPrecedence({
      applicableRuleCount: 1, requiredGateCount: 2, gateStates: ['fresh_pass'],
    }), { result: 'missing', reason: 'gate_missing' });
    assert.deepEqual(resolveShadowPrecedence({
      applicableRuleCount: 1, requiredGateCount: 1,
      gateStates: ['fresh_pass', 'fresh_pass'],
    }), { result: 'self_error', reason: 'evidence_malformed' });
  });
});
