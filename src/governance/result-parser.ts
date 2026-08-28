import { createHash } from 'node:crypto';
import {
  EXIT_ONLY_PARSER_VERSION, NODE_TEST_PARSER_VERSION,
  type ParsedGateResult, type ResultObservation,
} from './types.js';

export interface ParseGateResultOptions {
  parser: 'node-test' | 'exit-only';
  gateKind?: 'test' | 'command';
  skips?: { max: number; requireReasons: boolean };
}

interface NodeSummary {
  kind: 'complete' | 'incomplete' | 'zero';
  reason: string | null;
  total: number | null;
  passed: number | null;
  failed: number | null;
  skipped: number | null;
  skipReasonsComplete: boolean | null;
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function baseResult(
  options: ParseGateResultOptions,
  observation: ResultObservation,
  captureResult: ParsedGateResult['captureResult'],
  reason: string | null,
): ParsedGateResult {
  return {
    parserName: options.parser,
    parserVersion: options.parser === 'node-test'
      ? NODE_TEST_PARSER_VERSION
      : EXIT_ONLY_PARSER_VERSION,
    captureResult,
    reason,
    outputSha256: observation.outputSha256,
    total: null,
    passed: null,
    failed: null,
    skipped: null,
    skipReasonsComplete: null,
  };
}

function resultFailureReason(observation: ResultObservation): string | null {
  if (observation.timedOut) return 'timed_out';
  if (observation.interrupted) return 'interrupted';
  if (observation.signal !== null) return 'signaled';
  if (observation.outcome === 'unknown_failure' || observation.exitCode === null) {
    return 'unknown_status';
  }
  if (observation.outcome === 'failure') return 'failure_event';
  if (observation.exitCode !== 0) return 'nonzero_exit';
  return null;
}

function safeCount(value: string): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function uniqueLineCount(output: string, label: string): number | null | 'missing' | 'conflict' {
  const expression = new RegExp(`^(?:ℹ|#)\\s*${label}\\s+(\\d+)\\s*$`, 'gmu');
  const values = [...output.matchAll(expression)].map(match => safeCount(match[1]));
  if (values.length === 0) return 'missing';
  if (values.some(value => value === null)) return null;
  const distinct = new Set(values as number[]);
  return distinct.size === 1 ? (values[0] as number) : 'conflict';
}

function tapPlan(output: string): number | null | 'missing' | 'conflict' {
  const values = [...output.matchAll(/^1\.\.(\d+)(?:\s+#.*)?\s*$/gmu)]
    .map(match => safeCount(match[1]));
  if (values.length === 0) return 'missing';
  if (values.some(value => value === null)) return null;
  const distinct = new Set(values as number[]);
  return distinct.size === 1 ? (values[0] as number) : 'conflict';
}

function skipReasonCount(output: string): number {
  let count = 0;
  for (const line of output.split('\n')) {
    const tap = line.match(/#[ \t]*SKIP(?:[ \t]+(.+\S))?[ \t]*$/iu);
    if (tap !== null) {
      if ((tap[1] ?? '').trim().length > 0) count += 1;
      continue;
    }
    const spec = line.match(/^[ \t]*﹣[ \t]+.*?#[ \t]*(.+\S)[ \t]*$/u);
    if (spec !== null && spec[1].trim().length > 0) count += 1;
  }
  return count;
}

function parseNodeSummary(
  outputText: string,
  skipPolicy: { max: number; requireReasons: boolean },
): NodeSummary {
  const output = outputText.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  const plan = tapPlan(output);
  const total = uniqueLineCount(output, 'tests');
  if (plan === 'conflict' || plan === null || total === 'conflict' || total === null) {
    return {
      kind: 'incomplete', reason: 'malformed_test_counts', total: null,
      passed: null, failed: null, skipped: null, skipReasonsComplete: null,
    };
  }
  if (plan === 0 || total === 0) {
    return {
      kind: 'zero', reason: 'zero_tests', total: 0,
      passed: 0, failed: 0, skipped: 0, skipReasonsComplete: true,
    };
  }
  if (total === 'missing') {
    return {
      kind: 'incomplete', reason: 'missing_test_summary', total: null,
      passed: null, failed: null, skipped: null, skipReasonsComplete: null,
    };
  }
  if (plan !== 'missing' && plan !== total) {
    return {
      kind: 'incomplete', reason: 'tap_plan_mismatch', total,
      passed: null, failed: null, skipped: null, skipReasonsComplete: null,
    };
  }

  const passed = uniqueLineCount(output, 'pass');
  const failed = uniqueLineCount(output, 'fail');
  const skipped = uniqueLineCount(output, 'skipped');
  if (typeof passed !== 'number' || typeof failed !== 'number' || typeof skipped !== 'number' ||
      passed > total || failed > total || skipped > total || passed + failed + skipped > total) {
    return {
      kind: 'incomplete', reason: 'malformed_test_counts', total,
      passed: null, failed: null, skipped: null, skipReasonsComplete: null,
    };
  }
  const reasonsComplete = skipped === 0 || skipReasonCount(output) >= skipped;
  if (failed > 0) {
    return {
      kind: 'complete', reason: 'reported_test_failures', total, passed, failed, skipped,
      skipReasonsComplete: reasonsComplete,
    };
  }
  if (skipped > skipPolicy.max) {
    return {
      kind: 'complete', reason: 'skip_ceiling_exceeded', total, passed, failed, skipped,
      skipReasonsComplete: reasonsComplete,
    };
  }
  if (skipPolicy.requireReasons && !reasonsComplete) {
    return {
      kind: 'complete', reason: 'skip_reasons_missing', total, passed, failed, skipped,
      skipReasonsComplete: false,
    };
  }
  return {
    kind: 'complete', reason: null, total, passed, failed, skipped,
    skipReasonsComplete: reasonsComplete,
  };
}

/** Parse normalized output into bounded evidence fields; raw output is never returned. */
export function parseGateResult(
  observation: ResultObservation,
  options: ParseGateResultOptions,
): ParsedGateResult {
  if (sha256(observation.outputText) !== observation.outputSha256) {
    return baseResult(options, observation, 'incomplete', 'output_digest_mismatch');
  }
  const transportFailure = resultFailureReason(observation);
  if (transportFailure !== null) {
    return baseResult(options, observation, 'failed', transportFailure);
  }

  const gateKind = options.gateKind ?? (options.parser === 'node-test' ? 'test' : 'command');
  if (options.parser === 'exit-only') {
    if (gateKind === 'test') {
      return baseResult(options, observation, 'failed', 'exit_only_not_test_evidence');
    }
    return baseResult(options, observation, 'complete', null);
  }

  const summary = parseNodeSummary(
    observation.outputText,
    options.skips ?? { max: 0, requireReasons: false },
  );
  const parsed = baseResult(
    options,
    observation,
    summary.kind === 'incomplete' ? 'incomplete' : summary.reason === null ? 'complete' : 'failed',
    summary.reason,
  );
  parsed.total = summary.total;
  parsed.passed = summary.passed;
  parsed.failed = summary.failed;
  parsed.skipped = summary.skipped;
  parsed.skipReasonsComplete = summary.skipReasonsComplete;
  return parsed;
}
