import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CAPABILITY_HEARTBEAT_FUTURE_SKEW_MS, CAPABILITY_HEARTBEAT_MAX_AGE_MS,
  resolveCapabilityStatus, type GovernanceClientCapabilityRow,
} from '../src/governance/capability-status.js';

const NOW = Date.UTC(2026, 7, 26, 12);

function row(overrides: Partial<GovernanceClientCapabilityRow> = {}): GovernanceClientCapabilityRow {
  return {
    project: 'project-a', clientInstallationId: 'install-a', clientName: 'claude-code',
    clientVersion: '1.0.0', supportsPostToolUse: true, supportsPostToolFailure: true,
    supportsFileChanged: true, supportsStructuredOutput: true, supportsStop: true,
    supportsBlocking: true, adapterVersion: 1, settingsSource: 'declared',
    lastSessionId: 'session-a', lastHeartbeatAt: new Date(NOW).toISOString(),
    lastProbeResult: 'ok', ...overrides,
  };
}

describe('governance capability heartbeat policy', () => {
  it('accepts the exact 30-minute boundary and bounded clock skew', () => {
    const exact = resolveCapabilityStatus({
      row: row({ lastHeartbeatAt: new Date(NOW - CAPABILITY_HEARTBEAT_MAX_AGE_MS).toISOString() }),
      clientName: 'claude-code', sessionId: 'session-a', nowMs: NOW,
    });
    assert.equal(exact.observations.heartbeat, 'current');
    assert.equal(exact.degraded, false);
    const skew = resolveCapabilityStatus({
      row: row({ lastHeartbeatAt: new Date(NOW + CAPABILITY_HEARTBEAT_FUTURE_SKEW_MS).toISOString() }),
      clientName: 'claude-code', sessionId: 'session-a', nowMs: NOW,
    });
    assert.equal(skew.observations.heartbeat, 'current');
    const excessiveSkew = resolveCapabilityStatus({
      row: row({ lastHeartbeatAt: new Date(NOW + CAPABILITY_HEARTBEAT_FUTURE_SKEW_MS + 1).toISOString() }),
      clientName: 'claude-code', sessionId: 'session-a', nowMs: NOW,
    });
    assert.equal(excessiveSkew.observations.heartbeat, 'stale');
  });

  it('does not inherit heartbeat or unknown support from another session', () => {
    const status = resolveCapabilityStatus({
      row: row({
        lastSessionId: 'old-session', supportsFileChanged: null,
        supportsPostToolFailure: null, supportsStop: null, supportsBlocking: null,
      }),
      clientName: 'claude-code', sessionId: 'session-a', nowMs: NOW,
    });
    assert.equal(status.observations.heartbeat, 'stale');
    assert.equal(status.observations.fileChanged, 'not_observed');
    assert.equal(status.observations.stop, 'not_observed');
    assert.equal(status.observations.blocking, 'unavailable');
    assert.deepEqual(status.reasons.slice(0, 3), [
      'stale_heartbeat', 'missing_post_tool_failure', 'missing_file_changed',
    ]);
  });

  it('uses the current Stop only as Stop heartbeat evidence and exposes real degradation', () => {
    const status = resolveCapabilityStatus({
      row: row({
        supportsPostToolFailure: null, supportsFileChanged: null,
        supportsStop: null, supportsBlocking: null, lastHeartbeatAt: null,
      }),
      clientName: 'claude-code', sessionId: 'session-a', nowMs: NOW,
      currentStopObserved: true,
    });
    assert.equal(status.observations.stop, 'observed');
    assert.equal(status.observations.heartbeat, 'current');
    assert.equal(status.observations.fileChanged, 'not_observed');
    assert.equal(status.observations.blocking, 'unavailable');
    assert.ok(status.reasons.includes('missing_file_changed'));
    assert.ok(status.reasons.includes('blocking_unavailable'));
    assert.ok(!status.reasons.includes('missing_stop'));
  });

  it('classifies unsupported clients without treating missing state as healthy', () => {
    const unsupported = resolveCapabilityStatus({
      row: row({ clientName: 'other-client' }), clientName: 'other-client',
      sessionId: 'session-a', nowMs: NOW,
    });
    assert.equal(unsupported.reasons[0], 'unsupported_client');
    const missing = resolveCapabilityStatus({
      row: null, clientName: 'claude-code', sessionId: 'session-a', nowMs: NOW,
    });
    assert.equal(missing.degraded, true);
    assert.equal(missing.observations.fileChanged, 'not_observed');
    assert.equal(missing.observations.blocking, 'unavailable');
  });
});
