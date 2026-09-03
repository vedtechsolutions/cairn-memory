import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  GOVERNANCE_OVERRIDE_PAYLOAD_VERSION,
  validateGovernanceOverride,
  type GovernanceOverrideCandidate, type GovernanceOverrideContext,
} from '../src/governance/override-validator.js';
import { GOVERNANCE_BOUNDS } from '../src/constants/index.js';

const NOW = Date.UTC(2026, 7, 26, 12);

function candidate(overrides: Partial<GovernanceOverrideCandidate> = {}): GovernanceOverrideCandidate {
  return {
    auditId: 7, payloadVersion: GOVERNANCE_OVERRIDE_PAYLOAD_VERSION,
    actorClass: 'user-confirmed', project: 'project-a', sessionId: 'session-a',
    configSha256: 'a'.repeat(64), worktreeDigest: 'b'.repeat(64),
    rules: [{ ruleId: 'verify-core', revision: 2 }], gateIds: ['lint', 'test'],
    issuedAt: new Date(NOW - 60_000).toISOString(),
    expiresAt: new Date(NOW + 60_000).toISOString(), ...overrides,
  };
}

function context(overrides: Partial<GovernanceOverrideContext> = {}): GovernanceOverrideContext {
  return {
    project: 'project-a', sessionId: 'session-a', configSha256: 'a'.repeat(64),
    worktreeDigest: 'b'.repeat(64), rules: [{ ruleId: 'verify-core', revision: 2 }],
    gateIds: ['test', 'lint'], nowMs: NOW, ...overrides,
  };
}

describe('Slice C override binding validation', () => {
  it('accepts exact bindings independent of set order', () => {
    assert.deepEqual(validateGovernanceOverride(candidate(), context()), { valid: true, auditId: 7 });
  });

  it('rejects every identity, tree, config, rule, and gate mismatch', () => {
    const cases: Array<[GovernanceOverrideContext, string]> = [
      [context({ project: 'project-b' }), 'project_mismatch'],
      [context({ sessionId: 'session-b' }), 'session_mismatch'],
      [context({ configSha256: 'c'.repeat(64) }), 'config_mismatch'],
      [context({ worktreeDigest: 'd'.repeat(64) }), 'digest_mismatch'],
      [context({ rules: [{ ruleId: 'verify-core', revision: 3 }] }), 'rule_revision_mismatch'],
      [context({ gateIds: ['test'] }), 'gate_set_mismatch'],
    ];
    for (const [changed, reason] of cases) {
      assert.deepEqual(validateGovernanceOverride(candidate(), changed), { valid: false, reason });
    }
  });

  it('treats the exact expiry boundary as expired and rejects malformed candidates', () => {
    assert.deepEqual(validateGovernanceOverride(candidate({
      expiresAt: new Date(NOW).toISOString(),
    }), context()), { valid: false, reason: 'expired' });
    assert.deepEqual(validateGovernanceOverride(candidate({ auditId: 0 }), context()), {
      valid: false, reason: 'malformed',
    });
    assert.deepEqual(validateGovernanceOverride(candidate({ gateIds: ['test', 'test'] }), context()), {
      valid: false, reason: 'gate_set_mismatch',
    });
    assert.deepEqual(validateGovernanceOverride(candidate({
      expiresAt: new Date(NOW - 60_000 + GOVERNANCE_BOUNDS.OVERRIDE_MAX_DURATION_MS + 1).toISOString(),
    }), context()), { valid: false, reason: 'duration_exceeded' });
  });
});
