import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyGateEvidence, mutationIntersects, selectEvidenceRequirements,
  selectLatestEligibleGateRun, type EvidenceMutationEvent, type GateRunEvidence,
} from '../src/governance/evidence-selector.js';
import type { WorktreeDigestV2Result } from '../src/governance/worktree-digest.js';

const configSha256 = 'a'.repeat(64);
const digestSha256 = 'b'.repeat(64);
const relevantPathsSha256 = 'c'.repeat(64);

function event(
  eventSeq: number,
  mutationClass: EvidenceMutationEvent['mutationClass'],
  affectedPaths: string[] = [],
): EvidenceMutationEvent {
  return { eventSeq, mutationSeq: eventSeq, mutationClass, affectedPaths };
}

function run(overrides: Partial<GateRunEvidence> = {}): GateRunEvidence {
  return {
    gateId: 'test-core', eventSeq: 10, mutationSeq: 4, configSha256,
    parserName: 'node-test', parserVersion: 1,
    testTotal: 3, testPass: 3, testFail: 0, testSkip: 0,
    skipReasonsComplete: true, worktreeDigest: digestSha256, digestVersion: 2,
    relevantPathsSha256, captureResult: 'complete', ...overrides,
  };
}

function current(overrides: Partial<WorktreeDigestV2Result> = {}): WorktreeDigestV2Result {
  return {
    status: 'complete', digest: digestSha256, version: 2,
    relevantPathsSha256, repositoryKind: 'git', reason: null, attempts: 1,
    ...overrides,
  };
}

const nodePolicy = {
  parser: 'node-test' as const,
  skips: { max: 0, requireReasons: true },
};

describe('governance evidence selector', () => {
  it('selects applicable rules and the union of path/explicit gates deterministically', () => {
    const selected = selectEvidenceRequirements({
      rules: [
        { ruleId: 'docs', revision: 1, gateIds: ['lint'], paths: ['docs/**'], watermarkEventSeq: 4 },
        { ruleId: 'core', revision: 2, gateIds: ['security'], paths: ['src/**'], watermarkEventSeq: 7 },
        { ruleId: 'global', revision: 1, gateIds: ['build'], paths: [], watermarkEventSeq: 6 },
      ],
      pathRules: [
        { paths: ['src/**'], require: ['test-core', 'build'] },
        { paths: ['docs/**'], require: [] },
        { paths: ['**'], require: ['smoke'] },
      ],
      events: [event(8, 'scoped', ['src/a.ts']), event(9, 'none')],
    });
    assert.deepEqual(selected.applicableRules.map(rule => rule.ruleId), ['core', 'global']);
    assert.deepEqual(selected.requiredGateIds, ['build', 'security', 'smoke', 'test-core']);
    assert.deepEqual(selected.relevantPathsByGate.security, ['src/**']);
    assert.deepEqual(selected.relevantPathsByGate.smoke, ['**']);
    assert.equal(selected.watermarkByGate['test-core'], 7,
      'all applicable revisions conservatively invalidate pre-rule evidence');
  });

  it('widens unknown mutations to every rule and only the config catch-all gates', () => {
    const selected = selectEvidenceRequirements({
      rules: [
        { ruleId: 'docs', revision: 1, gateIds: ['lint'], paths: ['docs/**'], watermarkEventSeq: 2 },
        { ruleId: 'core', revision: 1, gateIds: [], paths: ['src/**'], watermarkEventSeq: 3 },
      ],
      pathRules: [
        { paths: ['src/**'], require: ['test-core'] },
        { paths: ['**'], require: ['smoke'] },
      ],
      events: [event(4, 'unknown')],
    });
    assert.deepEqual(selected.applicableRules.map(rule => rule.ruleId), ['core', 'docs']);
    assert.deepEqual(selected.requiredGateIds, ['lint', 'smoke']);
    assert.equal(selected.unknownMutation, true);
  });

  it('selects only post-watermark evidence with the exact current config SHA', () => {
    const selected = selectLatestEligibleGateRun({
      gateId: 'test-core', configSha256, watermarkEventSeq: 7,
      runs: [
        run({ eventSeq: 6 }),
        run({ eventSeq: 20, configSha256: 'd'.repeat(64) }),
        run({ eventSeq: 8 }),
        run({ eventSeq: 12 }),
      ],
    });
    assert.equal(selected?.eventSeq, 12);
  });

  it('intersects scoped paths, widens unknowns, and ignores out-of-scope/none mutations', () => {
    assert.equal(mutationIntersects(event(1, 'scoped', ['src/a.ts']), ['src/**']), true);
    assert.equal(mutationIntersects(event(2, 'scoped', ['docs/a.md']), ['src/**']), false);
    assert.equal(mutationIntersects(event(3, 'unknown'), ['src/**']), true);
    assert.equal(mutationIntersects(event(4, 'none'), ['src/**']), false);
    assert.equal(mutationIntersects(event(5, 'scoped', ['anything']), ['src/[abc].ts']), true,
      'unsupported glob syntax widens instead of excluding');
  });

  it('classifies fresh, non-pass, v1, mutation-stale, digest-stale, and self-error evidence', () => {
    const base = {
      policy: nodePolicy, relevantPaths: ['src/**'], laterEvents: [] as EvidenceMutationEvent[],
      currentDigest: current(),
    };
    assert.equal(classifyGateEvidence({ ...base, run: run() }).state, 'fresh_pass');
    assert.equal(classifyGateEvidence({ ...base, run: run({ captureResult: 'failed' }) }).state, 'non_pass');
    assert.deepEqual(classifyGateEvidence({ ...base, run: run({ digestVersion: 1 }) }), {
      state: 'missing', reason: 'digest_version_requires_rerun',
      evidenceEventSeq: 10, invalidatingEventSeq: null,
    });
    assert.deepEqual(classifyGateEvidence({
      ...base, run: run(), laterEvents: [event(11, 'scoped', ['docs/a.md']), event(12, 'unknown')],
    }), {
      state: 'stale_mutation', reason: 'later_unknown_mutation',
      evidenceEventSeq: 10, invalidatingEventSeq: 12,
    });
    assert.equal(classifyGateEvidence({
      ...base, run: run(), currentDigest: current({ digest: 'e'.repeat(64) }),
    }).state, 'stale_digest');
    assert.equal(classifyGateEvidence({
      ...base, run: run({ parserVersion: 99 }),
    }).state, 'self_error');
    assert.equal(classifyGateEvidence({
      ...base, run: run(), currentDigest: current({ status: 'incomplete', digest: null }),
    }).state, 'self_error');
  });

  it('does not let an out-of-scope later edit invalidate passing evidence', () => {
    assert.equal(classifyGateEvidence({
      run: run(), policy: nodePolicy, relevantPaths: ['src/**'],
      laterEvents: [event(11, 'scoped', ['docs/note.md'])], currentDigest: current(),
    }).state, 'fresh_pass');
  });

  it('keeps genuine test failures separate from structurally impossible counts', () => {
    const base = {
      policy: nodePolicy, relevantPaths: ['src/**'], laterEvents: [] as EvidenceMutationEvent[],
      currentDigest: current(),
    };
    for (const evidence of [
      run({ testTotal: 0, testPass: 0 }),
      run({ testTotal: 3, testPass: 2, testFail: 1 }),
      run({ testTotal: 3, testPass: 2, testSkip: 1 }),
    ]) {
      assert.equal(classifyGateEvidence({ ...base, run: evidence }).state, 'non_pass');
    }
    assert.deepEqual(classifyGateEvidence({
      ...base, run: run({ testTotal: 1, testPass: 2 }),
    }).reason, 'impossible_result_counts');
  });
});
