import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { NormalizedGate } from '../src/governance/gate-config.js';
import {
  CLAUDE_HOOK_NON_BLOCKING_MESSAGE_FIELD, decideWarningEmission,
  renderGovernanceWarning, warningFingerprint,
} from '../src/governance/warning-policy.js';
import { GOVERNANCE_BOUNDS } from '../src/constants/index.js';

function fingerprint(overrides: Partial<Parameters<typeof warningFingerprint>[0]> = {}): string {
  return warningFingerprint({
    project: 'project-a', configSha256: 'a'.repeat(64),
    unresolvedGates: [{ gateId: 'test', state: 'missing' }],
    result: 'missing', reason: 'gate_missing', worktreeDigest: 'b'.repeat(64),
    ...overrides,
  });
}

function gate(argv: string[]): NormalizedGate {
  return {
    argv, cwd: '.', parser: 'node-test', timeoutMs: 1_000,
    skips: { max: 0, requireReasons: true }, aliases: [], envNames: [],
  };
}

describe('Slice C warning policy', () => {
  it('uses the documented non-blocking Claude Code message field', () => {
    assert.equal(CLAUDE_HOOK_NON_BLOCKING_MESSAGE_FIELD, 'systemMessage');
  });

  it('keeps fingerprints stable under gate ordering and sensitive to every binding', () => {
    const stable = warningFingerprint({
      project: 'project-a', configSha256: 'a'.repeat(64),
      unresolvedGates: [
        { gateId: 'lint', state: 'stale_digest' }, { gateId: 'test', state: 'missing' },
      ], result: 'missing', reason: 'gate_missing', worktreeDigest: 'b'.repeat(64),
    });
    assert.equal(stable, warningFingerprint({
      project: 'project-a', configSha256: 'a'.repeat(64),
      unresolvedGates: [
        { gateId: 'test', state: 'missing' }, { gateId: 'lint', state: 'stale_digest' },
      ], result: 'missing', reason: 'gate_missing', worktreeDigest: 'b'.repeat(64),
    }));
    for (const changed of [
      fingerprint({ project: 'project-b' }),
      fingerprint({ configSha256: 'c'.repeat(64) }),
      fingerprint({ unresolvedGates: [{ gateId: 'build', state: 'missing' }] }),
      fingerprint({ unresolvedGates: [{ gateId: 'test', state: 'non_pass' }] }),
      fingerprint({ result: 'stale', reason: 'gate_stale' }),
      fingerprint({ worktreeDigest: 'd'.repeat(64) }),
    ]) assert.notEqual(changed, fingerprint());
  });

  it('emits once per session fingerprint and enforces the five-warning ceiling', () => {
    const target = fingerprint();
    assert.equal(decideWarningEmission(target, []).emit, true);
    assert.deepEqual(decideWarningEmission(target, [
      { eventType: 'warning_emitted', fingerprint: target },
    ]), {
      emit: false, auditEventType: 'warning_suppressed', reason: 'duplicate_fingerprint',
    });
    const full = Array.from({ length: GOVERNANCE_BOUNDS.WARNING_MAX_PER_SESSION }, (_, index) => ({
      eventType: 'warning_emitted' as const, fingerprint: String(index).padStart(64, '0'),
    }));
    assert.equal(decideWarningEmission(target, full).reason, 'session_ceiling');
  });

  it('renders bounded redacted guidance without assistant or control claims', () => {
    const message = renderGovernanceWarning({
      ruleIds: ['verify-core'], overrideValid: false, stopHookActive: true,
      gates: [{
        gateId: 'test', state: 'non_pass',
        gate: gate(['npm', 'test', '--token', 'needle-secret', 'URL=https://user:pw@example.test']),
      }],
    });
    assert.match(message, /verify-core/u);
    assert.match(message, /test: last run did not satisfy policy/u);
    assert.match(message, /npm test --token '\[REDACTED\]'/u);
    assert.doesNotMatch(message, /needle-secret|user:pw|assistant-needle/iu);
    assert.doesNotMatch(message, /\b(?:blocked|passed)\b/iu);
    assert.ok(message.length <= GOVERNANCE_BOUNDS.WARNING_MAX_CHARS);
  });
});
