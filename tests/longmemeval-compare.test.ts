/**
 * compare.mjs fail-closed contract (W2 review) — apparently-valid paired
 * statistics over unrelated or incomplete reports are worse than none, so
 * incompatible metadata, duplicate/missing questions, and one-sided scored
 * rows must exit nonzero. Process-level: spawns the real script.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(process.cwd(), 'scripts', 'longmemeval', 'compare.mjs');
const SPAWN_TIMEOUT_MS = 15_000;

type Report = Record<string, unknown> & {
  meta: Record<string, unknown>;
  per_question: Array<Record<string, unknown>>;
};

function nsScores(r5: number): Record<string, unknown> {
  return {
    session_recall_all: { 5: r5, 10: r5 },
    session_ndcg_any: { 5: r5, 10: r5 },
    turn_recall_all: { 5: r5, 10: r5 },
    turn_ndcg_any: { 5: r5, 10: r5 },
  };
}

function makeReport(overrides: Partial<Report> = {}, perQuestionR5: Record<string, number> = { qa: 1, qb: 0 }): Report {
  const perQuestion = Object.entries(perQuestionR5).map(([id, r5]) => ({
    question_id: id,
    question_type: 'multi-session',
    abstention: false,
    official_compat: nsScores(r5),
    unique_session: nsScores(r5),
  }));
  const aggregates = {
    official_compat: nsScores(0.5),
    unique_session: nsScores(0.5),
  };
  return {
    meta: {
      dataset: 'synthetic.json', dataset_revision: 'rev1', dataset_sha256: 'sha1',
      variant: 'hybrid', variant_label: 'hybrid', embedded: true, corpus_mode: 'user-only',
      ks: [5, 10], pool_size: 50, candidates_per_retriever: 20,
      harness_commit: 'aaaa111',
    },
    aggregates,
    per_question: perQuestion,
    ...overrides,
  };
}

function runCompare(baseReport: Report, challReport: Report, flags: string[] = []): { status: number | null; stdout: string; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cairn-compare-test-'));
  try {
    const basePath = join(dir, 'base.json');
    const challPath = join(dir, 'chall.json');
    writeFileSync(basePath, JSON.stringify(baseReport));
    writeFileSync(challPath, JSON.stringify(challReport));
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.NODE_TEST_CONTEXT; // child must run as a normal process (stderr suppression)
    const result = spawnSync(process.execPath, [SCRIPT, ...flags, basePath, challPath], {
      env, timeout: SPAWN_TIMEOUT_MS, encoding: 'utf8',
    });
    assert.equal(result.error, undefined, `spawn failed or timed out: ${result.error}`);
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('compare.mjs — fail-closed comparability contract', () => {
  it('compatible reports produce paired statistics and exit 0', () => {
    const { status, stdout } = runCompare(makeReport(), makeReport({}, { qa: 0, qb: 1 }));
    assert.equal(status, 0);
    assert.match(stdout, /sign test .*p=/);
    assert.match(stdout, /bootstrap 95% CI/);
  });

  it('exits nonzero on mismatched dataset sha256', () => {
    const chall = makeReport();
    chall.meta.dataset_sha256 = 'sha2';
    const { status, stderr } = runCompare(makeReport(), chall);
    assert.equal(status, 1);
    assert.match(stderr, /meta\.dataset_sha256 differs/);
  });

  it('exits nonzero on mismatched ks / pool / candidate depth / corpus / variant', () => {
    for (const [field, value] of [
      ['ks', [5]], ['pool_size', 25], ['candidates_per_retriever', 10],
      ['corpus_mode', 'all-roles'], ['embedded', false],
    ] as const) {
      const chall = makeReport();
      chall.meta[field] = value as unknown;
      const { status, stderr } = runCompare(makeReport(), chall);
      assert.equal(status, 1, `${field} mismatch must fail`);
      assert.match(stderr, new RegExp(`meta\\.${field} differs`));
    }
  });

  it('exits nonzero when a question is missing from one side', () => {
    const { status, stderr } = runCompare(makeReport(), makeReport({}, { qa: 1 }));
    assert.equal(status, 1);
    assert.match(stderr, /question counts differ/);

    // Same count, different ids
    const { status: s2, stderr: e2 } = runCompare(makeReport(), makeReport({}, { qa: 1, qz: 0 }));
    assert.equal(s2, 1);
    assert.match(e2, /present in baseline but missing from challenger/);
  });

  it('exits nonzero on duplicate question ids within a report', () => {
    const chall = makeReport();
    chall.per_question = [...chall.per_question, { ...chall.per_question[0] }];
    const { status, stderr } = runCompare(makeReport(), chall);
    assert.equal(status, 1);
    assert.match(stderr, /duplicate question_id/);
  });

  it('exits nonzero when a namespace is scored on one side only', () => {
    const chall = makeReport();
    delete chall.per_question[0].official_compat;
    const { status, stderr } = runCompare(makeReport(), chall);
    assert.equal(status, 1);
    assert.match(stderr, /scored in official_compat on one side only/);
  });

  it('harness-commit mismatch fails by default and passes only with --allow-harness-mismatch', () => {
    const chall = makeReport();
    chall.meta.harness_commit = 'bbbb222';
    const refused = runCompare(makeReport(), chall);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /harness_commit differs/);

    const allowed = runCompare(makeReport(), chall, ['--allow-harness-mismatch']);
    assert.equal(allowed.status, 0);
    assert.match(allowed.stdout, /proceeding under --allow-harness-mismatch/);
  });
});
