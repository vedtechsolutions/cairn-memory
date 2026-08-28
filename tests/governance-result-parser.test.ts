import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { parseGateResult } from '../src/governance/result-parser.js';
import type { ResultObservation } from '../src/governance/types.js';

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

function observation(
  outputText: string,
  overrides: Partial<ResultObservation> = {},
): ResultObservation {
  return {
    outcome: 'success', exitCode: 0, signal: null,
    interrupted: false, timedOut: false,
    outputText, outputSha256: sha(outputText),
    ...overrides,
  };
}

function nodeSummary(options: {
  total: number;
  passed: number;
  failed?: number;
  skipped?: number;
  skipLines?: string[];
  plan?: number;
}): string {
  return [
    'TAP version 13',
    ...(options.skipLines ?? []),
    `1..${options.plan ?? options.total}`,
    `# tests ${options.total}`,
    `# pass ${options.passed}`,
    `# fail ${options.failed ?? 0}`,
    `# skipped ${options.skipped ?? 0}`,
  ].join('\n');
}

describe('governance result parsing (A4)', () => {
  it('captures a complete non-zero Node test summary and only returns its SHA-256/counts', () => {
    const raw = nodeSummary({ total: 3, passed: 3 });
    const parsed = parseGateResult(observation(raw), {
      parser: 'node-test', skips: { max: 0, requireReasons: true },
    });
    assert.deepEqual(parsed, {
      parserName: 'node-test', parserVersion: 1,
      captureResult: 'complete', reason: null, outputSha256: sha(raw),
      total: 3, passed: 3, failed: 0, skipped: 0, skipReasonsComplete: true,
    });
    assert.equal('outputText' in parsed, false);
    assert.equal(JSON.stringify(parsed).includes(raw), false);
  });

  it('treats a zero TAP plan or zero summary as failed evidence', () => {
    for (const raw of ['TAP version 13\n1..0', nodeSummary({ total: 0, passed: 0 })]) {
      const parsed = parseGateResult(observation(raw), { parser: 'node-test' });
      assert.equal(parsed.captureResult, 'failed');
      assert.equal(parsed.reason, 'zero_tests');
      assert.equal(parsed.total, 0);
    }
  });

  it('accepts skips at the configured ceiling when every required reason is parsed', () => {
    const raw = nodeSummary({
      total: 3, passed: 1, skipped: 2,
      skipLines: ['ok 2 - windows only # SKIP linux', 'ok 3 - optional # SKIP feature disabled'],
    });
    const parsed = parseGateResult(observation(raw), {
      parser: 'node-test', skips: { max: 2, requireReasons: true },
    });
    assert.equal(parsed.captureResult, 'complete');
    assert.equal(parsed.reason, null);
    assert.equal(parsed.skipped, 2);
    assert.equal(parsed.skipReasonsComplete, true);

    const specReporter = [
      '﹣ platform test (1ms) # package not available',
      'ℹ tests 1', 'ℹ pass 0', 'ℹ fail 0', 'ℹ skipped 1',
    ].join('\n');
    assert.equal(parseGateResult(observation(specReporter), {
      parser: 'node-test', skips: { max: 1, requireReasons: true },
    }).captureResult, 'complete');
  });

  it('fails excess skips and missing required skip reasons without inventing reasons', () => {
    const excess = nodeSummary({
      total: 2, passed: 1, skipped: 1,
      skipLines: ['ok 2 - optional # SKIP has reason'],
    });
    assert.equal(parseGateResult(observation(excess), {
      parser: 'node-test', skips: { max: 0, requireReasons: false },
    }).reason, 'skip_ceiling_exceeded');

    const missingReason = nodeSummary({
      total: 2, passed: 1, skipped: 1,
      skipLines: ['ok 2 - optional # SKIP'],
    });
    const parsed = parseGateResult(observation(missingReason), {
      parser: 'node-test', skips: { max: 1, requireReasons: true },
    });
    assert.equal(parsed.captureResult, 'failed');
    assert.equal(parsed.reason, 'skip_reasons_missing');
    assert.equal(parsed.skipReasonsComplete, false);
  });

  it('records reported test failures as failed evidence even when transport status is zero', () => {
    const raw = nodeSummary({ total: 2, passed: 1, failed: 1 });
    const parsed = parseGateResult(observation(raw), { parser: 'node-test' });
    assert.equal(parsed.captureResult, 'failed');
    assert.equal(parsed.reason, 'reported_test_failures');
    assert.equal(parsed.failed, 1);
  });

  it('marks missing, conflicting, impossible, and plan-mismatched counts incomplete', () => {
    const malformed = [
      'all tests passed',
      `${nodeSummary({ total: 2, passed: 2 })}\n# tests 3`,
      nodeSummary({ total: 2, passed: 3 }),
      nodeSummary({ total: 2, passed: 2, plan: 3 }),
      '1..2\n# tests 2\n# pass 2\n# fail 0',
    ];
    for (const raw of malformed) {
      const parsed = parseGateResult(observation(raw), { parser: 'node-test' });
      assert.equal(parsed.captureResult, 'incomplete', raw);
      assert.match(parsed.reason ?? '', /missing|malformed|mismatch/, raw);
    }
  });

  it('never upgrades unknown status, non-zero failure, signal, interrupt, kill, or timeout', () => {
    const cases: Array<[Partial<ResultObservation>, string]> = [
      [{ outcome: 'unknown_failure', exitCode: null }, 'unknown_status'],
      [{ outcome: 'failure', exitCode: 2 }, 'failure_event'],
      [{ outcome: 'failure', exitCode: null, signal: 'SIGTERM' }, 'signaled'],
      [{ outcome: 'failure', exitCode: null, interrupted: true }, 'interrupted'],
      [{ outcome: 'failure', exitCode: null, signal: 'SIGKILL' }, 'signaled'],
      [{ outcome: 'failure', exitCode: null, timedOut: true }, 'timed_out'],
    ];
    const raw = nodeSummary({ total: 1, passed: 1 });
    for (const [overrides, reason] of cases) {
      const parsed = parseGateResult(observation(raw, overrides), { parser: 'node-test' });
      assert.equal(parsed.captureResult, 'failed');
      assert.equal(parsed.reason, reason);
      assert.equal(parsed.total, null, 'failed transport never receives guessed test counts');
    }
  });

  it('accepts exit-only for command gates but never as test-gate evidence', () => {
    const build = observation('build completed');
    assert.deepEqual(parseGateResult(build, { parser: 'exit-only', gateKind: 'command' }), {
      parserName: 'exit-only', parserVersion: 1,
      captureResult: 'complete', reason: null, outputSha256: sha('build completed'),
      total: null, passed: null, failed: null, skipped: null, skipReasonsComplete: null,
    });
    const testGate = parseGateResult(build, { parser: 'exit-only', gateKind: 'test' });
    assert.equal(testGate.captureResult, 'failed');
    assert.equal(testGate.reason, 'exit_only_not_test_evidence');
  });

  it('rejects an output/digest mismatch instead of storing an unverified digest', () => {
    const parsed = parseGateResult(observation('actual output', {
      outputSha256: sha('different output'),
    }), { parser: 'exit-only' });
    assert.equal(parsed.captureResult, 'incomplete');
    assert.equal(parsed.reason, 'output_digest_mismatch');
  });
});
