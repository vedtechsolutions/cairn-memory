import { posix } from 'node:path';
import {
  EXIT_ONLY_PARSER_VERSION, NODE_TEST_PARSER_VERSION,
  type CaptureStatus, type MutationClass,
} from './types.js';
import {
  WORKTREE_DIGEST_V2_VERSION, type WorktreeDigestV2Result,
} from './worktree-digest.js';
import type { GateEvidenceState } from './verdict-types.js';

export interface EvidenceRuleInput {
  ruleId: string;
  revision: number;
  gateIds: readonly string[];
  paths: readonly string[];
  watermarkEventSeq: number;
}

export interface EvidencePathRuleInput {
  paths: readonly string[];
  require: readonly string[];
}

export interface EvidenceMutationEvent {
  eventSeq: number;
  mutationSeq: number;
  mutationClass: MutationClass;
  affectedPaths: readonly string[];
}

export interface EvidenceSelectionInput {
  rules: readonly EvidenceRuleInput[];
  pathRules: readonly EvidencePathRuleInput[];
  events: readonly EvidenceMutationEvent[];
}

export interface EvidenceRequirementSelection {
  applicableRules: EvidenceRuleInput[];
  requiredGateIds: string[];
  relevantPathsByGate: Readonly<Record<string, string[]>>;
  watermarkByGate: Readonly<Record<string, number>>;
  changedPaths: string[];
  unknownMutation: boolean;
}

export interface GateRunEvidence {
  gateId: string;
  eventSeq: number;
  mutationSeq: number;
  configSha256: string;
  parserName: string;
  parserVersion: number;
  testTotal: number | null;
  testPass: number | null;
  testFail: number | null;
  testSkip: number | null;
  skipReasonsComplete: boolean | null;
  worktreeDigest: string | null;
  digestVersion: number | null;
  relevantPathsSha256: string | null;
  captureResult: CaptureStatus;
}

export interface GateEvidencePolicy {
  parser: 'node-test' | 'exit-only';
  skips: { max: number; requireReasons: boolean };
}

export interface ClassifiedGateEvidence {
  state: GateEvidenceState;
  reason:
    | 'fresh_pass'
    | 'no_eligible_run'
    | 'capture_incomplete'
    | 'recorded_non_pass'
    | 'unsupported_parser_version'
    | 'impossible_result_counts'
    | 'digest_version_requires_rerun'
    | 'digest_unavailable'
    | 'relevant_paths_mismatch'
    | 'later_unknown_mutation'
    | 'later_scoped_mutation'
    | 'worktree_digest_changed';
  evidenceEventSeq: number | null;
  invalidatingEventSeq: number | null;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizePattern(path: string): string {
  return posix.normalize(path.replaceAll('\\', '/')).replace(/^\.\//u, '') || '.';
}

function globRegex(pattern: string): RegExp {
  let source = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        index += 1;
        if (pattern[index + 1] === '/') {
          index += 1;
          source += '(?:.*/)?';
        } else {
          source += '.*';
        }
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += char.replace(/[\\^$+.()|{}\[\]]/g, '\\$&');
    }
  }
  return new RegExp(`${source}$`, 'u');
}

/** Unsupported glob constructs widen matching; they never exclude evidence-relevant paths. */
export function pathMatchesPatterns(path: string, patterns: readonly string[]): boolean {
  const normalized = patterns.map(normalizePattern);
  if (normalized.length === 0 || normalized.some(pattern => /[\[\]{}]/u.test(pattern))) return true;
  const candidate = normalizePattern(path);
  return normalized.some(pattern => globRegex(pattern).test(candidate));
}

export function mutationIntersects(
  event: EvidenceMutationEvent,
  relevantPaths: readonly string[],
): boolean {
  if (event.mutationClass === 'unknown') return true;
  if (event.mutationClass === 'none') return false;
  return event.affectedPaths.some(path => pathMatchesPatterns(path, relevantPaths));
}

/** Pure implementation of plan §8 step 5 and parent-design §5 selection. */
export function selectEvidenceRequirements(
  input: EvidenceSelectionInput,
): EvidenceRequirementSelection {
  const scopedPaths = input.events
    .filter(event => event.mutationClass === 'scoped')
    .flatMap(event => event.affectedPaths.map(normalizePattern));
  const changedPaths = [...new Set(scopedPaths)].sort(compareStrings);
  const unknownMutation = input.events.some(event => event.mutationClass === 'unknown');
  const applicableRules = input.rules.filter(rule =>
    unknownMutation || rule.paths.length === 0 ||
    changedPaths.some(path => pathMatchesPatterns(path, rule.paths)));

  const selectedPathRules = unknownMutation
    ? input.pathRules.filter(rule => rule.paths.some(path => normalizePattern(path) === '**'))
    : input.pathRules.filter(rule =>
        changedPaths.some(path => pathMatchesPatterns(path, rule.paths)));
  const required = new Set(selectedPathRules.flatMap(rule => rule.require));
  for (const rule of applicableRules) {
    for (const gateId of rule.gateIds) required.add(gateId);
  }

  const requiredGateIds = [...required].sort(compareStrings);
  const relevantPathsByGate: Record<string, string[]> = {};
  const watermarkByGate: Record<string, number> = {};
  for (const gateId of requiredGateIds) {
    const paths = input.pathRules
      .filter(rule => rule.require.includes(gateId))
      .flatMap(rule => rule.paths.map(normalizePattern));
    for (const rule of applicableRules.filter(rule => rule.gateIds.includes(gateId))) {
      paths.push(...(rule.paths.length === 0 ? ['**'] : rule.paths.map(normalizePattern)));
    }
    relevantPathsByGate[gateId] = [...new Set(paths.length === 0 ? ['**'] : paths)]
      .sort(compareStrings);
    // Intentionally conservative on v28: config-selected gates have no durable
    // gate-to-rule linkage, so every applicable rule is treated as requiring
    // every selected gate. A newly seen applicable revision therefore forces
    // a rerun instead of reusing evidence captured under older policy.
    watermarkByGate[gateId] = applicableRules.reduce(
      (maximum, rule) => Math.max(maximum, rule.watermarkEventSeq), 0,
    );
  }
  return {
    applicableRules: [...applicableRules].sort((left, right) =>
      compareStrings(left.ruleId, right.ruleId) || left.revision - right.revision),
    requiredGateIds, relevantPathsByGate, watermarkByGate, changedPaths, unknownMutation,
  };
}

/** Pure implementation of plan §8 step 6. */
export function selectLatestEligibleGateRun(options: {
  gateId: string;
  configSha256: string;
  watermarkEventSeq: number;
  runs: readonly GateRunEvidence[];
}): GateRunEvidence | null {
  return options.runs
    .filter(run => run.gateId === options.gateId &&
      run.configSha256 === options.configSha256 &&
      run.eventSeq > options.watermarkEventSeq)
    .sort((left, right) => right.eventSeq - left.eventSeq)[0] ?? null;
}

function validCount(value: number | null): value is number {
  return value !== null && Number.isSafeInteger(value) && value >= 0;
}

function parserState(run: GateRunEvidence, policy: GateEvidencePolicy): ClassifiedGateEvidence | null {
  const expectedVersion = policy.parser === 'node-test'
    ? NODE_TEST_PARSER_VERSION : EXIT_ONLY_PARSER_VERSION;
  if (run.parserName !== policy.parser || run.parserVersion !== expectedVersion) {
    return {
      state: 'self_error', reason: 'unsupported_parser_version',
      evidenceEventSeq: run.eventSeq, invalidatingEventSeq: null,
    };
  }
  if (run.captureResult === 'failed') {
    return {
      state: 'non_pass', reason: 'recorded_non_pass',
      evidenceEventSeq: run.eventSeq, invalidatingEventSeq: null,
    };
  }
  if (run.captureResult !== 'complete') {
    return {
      state: 'missing', reason: 'capture_incomplete',
      evidenceEventSeq: run.eventSeq, invalidatingEventSeq: null,
    };
  }
  if (policy.parser === 'node-test') {
    if (!validCount(run.testTotal) || !validCount(run.testPass) ||
        !validCount(run.testFail) || !validCount(run.testSkip) ||
        run.testPass + run.testFail + run.testSkip > run.testTotal) {
      return {
        state: 'self_error', reason: 'impossible_result_counts',
        evidenceEventSeq: run.eventSeq, invalidatingEventSeq: null,
      };
    }
    if (run.testTotal === 0 || run.testFail !== 0 || run.testSkip > policy.skips.max ||
        (policy.skips.requireReasons && run.testSkip > 0 && run.skipReasonsComplete !== true)) {
      return {
        state: 'non_pass', reason: 'recorded_non_pass',
        evidenceEventSeq: run.eventSeq, invalidatingEventSeq: null,
      };
    }
  } else if ([run.testTotal, run.testPass, run.testFail, run.testSkip]
    .some(value => value !== null)) {
    return {
      state: 'self_error', reason: 'impossible_result_counts',
      evidenceEventSeq: run.eventSeq, invalidatingEventSeq: null,
    };
  }
  return null;
}

/** Pure implementation of plan §8 step 7 plus v2 baseline equality. */
export function classifyGateEvidence(options: {
  run: GateRunEvidence | null;
  policy: GateEvidencePolicy;
  relevantPaths: readonly string[];
  laterEvents: readonly EvidenceMutationEvent[];
  currentDigest: WorktreeDigestV2Result | null;
}): ClassifiedGateEvidence {
  const run = options.run;
  if (run === null) {
    return {
      state: 'missing', reason: 'no_eligible_run',
      evidenceEventSeq: null, invalidatingEventSeq: null,
    };
  }
  const parsed = parserState(run, options.policy);
  if (parsed !== null) return parsed;
  if (run.digestVersion !== WORKTREE_DIGEST_V2_VERSION) {
    return {
      state: 'missing', reason: 'digest_version_requires_rerun',
      evidenceEventSeq: run.eventSeq, invalidatingEventSeq: null,
    };
  }
  if (run.worktreeDigest === null || options.currentDigest?.status !== 'complete' ||
      options.currentDigest.digest === null) {
    return {
      state: 'self_error', reason: 'digest_unavailable',
      evidenceEventSeq: run.eventSeq, invalidatingEventSeq: null,
    };
  }
  if (run.relevantPathsSha256 === null ||
      run.relevantPathsSha256 !== options.currentDigest.relevantPathsSha256) {
    return {
      state: 'missing', reason: 'relevant_paths_mismatch',
      evidenceEventSeq: run.eventSeq, invalidatingEventSeq: null,
    };
  }
  const later = options.laterEvents
    .filter(event => event.eventSeq > run.eventSeq)
    .sort((left, right) => left.eventSeq - right.eventSeq);
  const invalidating = later.find(event => mutationIntersects(event, options.relevantPaths));
  if (invalidating?.mutationClass === 'unknown') {
    return {
      state: 'stale_mutation', reason: 'later_unknown_mutation',
      evidenceEventSeq: run.eventSeq, invalidatingEventSeq: invalidating.eventSeq,
    };
  }
  if (invalidating !== undefined) {
    return {
      state: 'stale_mutation', reason: 'later_scoped_mutation',
      evidenceEventSeq: run.eventSeq, invalidatingEventSeq: invalidating.eventSeq,
    };
  }
  if (run.worktreeDigest !== options.currentDigest.digest) {
    return {
      state: 'stale_digest', reason: 'worktree_digest_changed',
      evidenceEventSeq: run.eventSeq, invalidatingEventSeq: null,
    };
  }
  return {
    state: 'fresh_pass', reason: 'fresh_pass',
    evidenceEventSeq: run.eventSeq, invalidatingEventSeq: null,
  };
}
