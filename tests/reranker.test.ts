/**
 * Reranker service + benchmark integration (W2 slice 4) — registry
 * invariants, CAIRN_RERANK contract (invalid values fail closed),
 * deterministic tie ordering, runner rerank window semantics, and the
 * mislabeled-run guard. CI-safe: no model downloads (fake rerank fns).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import {
  DEFAULT_RERANKER_MODEL_KEY, RERANKER_MODELS, RERANK,
} from '../src/constants/reranker-models.js';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { isRerankEnabled, orderByScore, resolveRerankerModel, scoresFromLogits, verifyArtifacts } from '../src/utils/reranker.js';
import { runBenchmark, type RerankFn } from '../src/benchmark/longmemeval/runner.js';
import { validateDataset, type LmeQuestion } from '../src/benchmark/longmemeval/data.js';
import { toMarkdownReport } from '../src/benchmark/longmemeval/report.js';

const FIXTURE_PATH = join(process.cwd(), 'scripts', 'longmemeval', 'fixture', 'harness-fixture.json');
const loadFixture = (): LmeQuestion[] => validateDataset(JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')));

describe('reranker registry + env contract', () => {
  it('default key resolves and every entry is consistent', () => {
    assert.equal(resolveRerankerModel(undefined).key, DEFAULT_RERANKER_MODEL_KEY);
    for (const [key, config] of Object.entries(RERANKER_MODELS)) {
      assert.equal(config.key, key);
      assert.ok(config.hfPath.includes('/'));
      assert.ok(['q8', 'q4'].includes(config.dtype));
    }
    assert.ok(RERANK.CANDIDATES > 0);
  });

  it('unknown and prototype-property model keys fail closed', () => {
    assert.throws(() => resolveRerankerModel('gpt-reranker'), /unknown CAIRN_RERANK_MODEL/);
    for (const key of ['__proto__', 'constructor', 'toString']) {
      assert.throws(() => resolveRerankerModel(key), /unknown CAIRN_RERANK_MODEL/);
    }
  });

  it('CAIRN_RERANK: unset/empty/0 off, 1 on, anything else fails closed', () => {
    assert.equal(isRerankEnabled(undefined), false);
    assert.equal(isRerankEnabled(''), false);
    assert.equal(isRerankEnabled('0'), false);
    assert.equal(isRerankEnabled('1'), true);
    for (const bad of ['true', 'yes', '2', 'on']) {
      assert.throws(() => isRerankEnabled(bad), /invalid CAIRN_RERANK/);
    }
  });
});

describe('scoresFromLogits — unusable inference output fails closed', () => {
  it('passes through an exact finite logit vector', () => {
    assert.deepEqual(scoresFromLogits([0.5, -1.2, 3.0], 3), [0.5, -1.2, 3.0]);
  });

  it('rejects short and long logit vectors', () => {
    assert.equal(scoresFromLogits([0.5, 0.2], 3), null, 'short output');
    assert.equal(scoresFromLogits([0.5, 0.2, 0.1, 0.9], 3), null, 'long output');
    assert.equal(scoresFromLogits([], 1), null, 'empty output');
  });

  it('rejects NaN and infinities anywhere in the vector', () => {
    assert.equal(scoresFromLogits([0.5, NaN, 0.1], 3), null);
    assert.equal(scoresFromLogits([Infinity, 0.2, 0.1], 3), null);
    assert.equal(scoresFromLogits([0.5, 0.2, -Infinity], 3), null);
  });
});

describe('orderByScore — deterministic ordering', () => {
  it('sorts by score descending', () => {
    const out = orderByScore(
      [{ rank: 0 }, { rank: 1 }, { rank: 2 }],
      [0.1, 0.9, 0.5],
    );
    assert.deepEqual(out.map(c => c.rank), [1, 2, 0]);
  });

  it('breaks ties by ORIGINAL rank — byte-identical across runs', () => {
    const candidates = [{ rank: 0 }, { rank: 1 }, { rank: 2 }, { rank: 3 }];
    const out = orderByScore(candidates, [0.5, 0.7, 0.5, 0.7]);
    assert.deepEqual(out.map(c => c.rank), [1, 3, 0, 2], 'equal scores keep RRF order');
  });
});

describe('runner rerank integration', () => {
  const q = (): LmeQuestion => loadFixture().find(x => !x.question_id.endsWith('_abs'))!;

  it('reranks only the top window, labels the variant, and reordering changes the ranking', async () => {
    const seen: Array<{ query: string; count: number; ranks: number[] }> = [];
    const reverse: RerankFn = async (query, candidates) => {
      seen.push({ query, count: candidates.length, ranks: candidates.map(c => c.rank) });
      return [...candidates].reverse();
    };
    const question = q();
    const plain = await runBenchmark([question], { variant: 'hybrid', ks: [5] });
    const reranked = await runBenchmark([question], { variant: 'hybrid', ks: [5], rerankFn: reverse });

    assert.equal(reranked.variantLabel, 'hybrid-fts-fallback+rerank', 'label carries the rerank stage');
    assert.equal(seen.length, 1, 'one rerank call per question');
    assert.equal(seen[0].query, question.question, 'cross-encoder sees the question');
    assert.ok(seen[0].count <= RERANK.CANDIDATES, 'window capped at RERANK.CANDIDATES');
    assert.deepEqual(seen[0].ranks, seen[0].ranks.map((_, i) => i), 'original ranks are 0..n-1');

    const plainIds = plain.perQuestion[0].audit!.rankedTurnIds;
    const rerankedIds = reranked.perQuestion[0].audit!.rankedTurnIds;
    assert.notDeepEqual(rerankedIds, plainIds, 'reversed window must change the audit ranking');
  });

  it('identity rerank leaves the ranking unchanged (disabled-path equivalence)', async () => {
    const identity: RerankFn = async (_q, candidates) => candidates;
    const question = q();
    const plain = await runBenchmark([question], { variant: 'hybrid', ks: [5] });
    const reranked = await runBenchmark([question], { variant: 'hybrid', ks: [5], rerankFn: identity });
    assert.deepEqual(
      reranked.perQuestion[0].audit!.rankedTurnIds,
      plain.perQuestion[0].audit!.rankedTurnIds,
      'identity rerank must not perturb the ranking',
    );
  });

  it('throws when the reranker is unavailable instead of scoring a mislabeled run', async () => {
    const unavailable: RerankFn = async () => null;
    await assert.rejects(
      runBenchmark([q()], { variant: 'hybrid', ks: [5], rerankFn: unavailable }),
      /refusing to score a mislabeled run/,
    );
  });

  it('rejects a rerank result that is not an exact permutation of its window', async () => {
    const omitting: RerankFn = async (_q, candidates) => candidates.slice(1);
    await assert.rejects(
      runBenchmark([q()], { variant: 'hybrid', ks: [5], rerankFn: omitting }),
      /not a permutation/,
      'omission must throw',
    );

    const duplicating: RerankFn = async (_q, candidates) => [candidates[0], ...candidates.slice(0, -1)];
    await assert.rejects(
      runBenchmark([q()], { variant: 'hybrid', ks: [5], rerankFn: duplicating }),
      /not a permutation/,
      'duplication must throw',
    );

    const injecting: RerankFn = async (_q, candidates) => [...candidates.slice(1), { id: 'foreign-id-999' }];
    await assert.rejects(
      runBenchmark([q()], { variant: 'hybrid', ks: [5], rerankFn: injecting }),
      /not in its window/,
      'foreign-id injection must throw',
    );
  });
});

describe('verifyArtifacts — complete-package provenance manifest', () => {
  it('verifies every manifest file, throws distinctly on mismatch and missing file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cairn-artifact-test-'));
    try {
      const weightBytes = Buffer.from('synthetic onnx bytes for provenance testing');
      const tokenizerBytes = Buffer.from('{"synthetic":"tokenizer"}');
      mkdirSync(join(dir, 'onnx'));
      writeFileSync(join(dir, 'onnx', 'model_quantized.onnx'), weightBytes);
      writeFileSync(join(dir, 'tokenizer.json'), tokenizerBytes);
      const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
      const manifest = {
        'onnx/model_quantized.onnx': sha(weightBytes),
        'tokenizer.json': sha(tokenizerBytes),
      };

      const verified = await verifyArtifacts(dir, manifest);
      assert.deepEqual(verified, manifest, 'match returns every verified hash');

      // Tokenizer drift must fail even when the weights still match —
      // that is exactly the gap a weights-only pin leaves open.
      writeFileSync(join(dir, 'tokenizer.json'), Buffer.from('{"synthetic":"DRIFTED"}'));
      await assert.rejects(
        verifyArtifacts(dir, manifest),
        /sha256 mismatch for tokenizer\.json/,
        'non-weight drift must throw the mismatch error',
      );

      await assert.rejects(
        verifyArtifacts(dir, { 'onnx/model_quantized.onnx': sha(weightBytes), 'config.json': sha(weightBytes) }),
        /missing or unreadable .*load the model first/,
        'a manifest file absent from the cache must throw the missing-artifact error',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('report — reranker provenance rendering', () => {
  it('renders the reranker identity line in markdown with the artifact hash', async () => {
    const identity: RerankFn = async (_q, candidates) => candidates;
    const question = loadFixture().find(x => !x.question_id.endsWith('_abs'))!;
    const run = await runBenchmark([question], { variant: 'hybrid', ks: [5], rerankFn: identity });
    const md = toMarkdownReport(run, {
      dataset: 'fixture',
      reranker: {
        model: 'jinaai/jina-reranker-v1-turbo-en', dtype: 'q8',
        artifacts: { 'onnx/model_quantized.onnx': '3defdef1ae34e119bd704216087743e79665934c96aebabcb6077c239dc3ae66' },
      },
    });
    assert.match(md, /hybrid-fts-fallback\+rerank/, 'variant label in title');
    assert.match(md, /Reranker: jinaai\/jina-reranker-v1-turbo-en \(q8, artifact 3defdef1ae34…\)/, 'provenance line rendered');
  });
});

describe('MCP server — reranker config fail-closed at startup', () => {
  const SERVER_PATH = join(process.cwd(), 'dist', 'src', 'mcp', 'server.js');

  function spawnServer(env: Record<string, string>): { status: number | null; stderr: string } {
    const dir = mkdtempSync(join(tmpdir(), 'cairn-rerank-gate-'));
    try {
      const fullEnv: NodeJS.ProcessEnv = { ...process.env, CAIRN_DB_PATH: join(dir, 'gate.db'), ...env };
      delete fullEnv.NODE_TEST_CONTEXT;
      const result = spawnSync(process.execPath, [SERVER_PATH], { env: fullEnv, timeout: 15_000, encoding: 'utf8' });
      assert.equal(result.error, undefined, `spawn failed or timed out: ${result.error}`);
      return { status: result.status, stderr: result.stderr ?? '' };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('exits 1 on an invalid CAIRN_RERANK value', () => {
    const { status, stderr } = spawnServer({ CAIRN_RERANK: 'yes' });
    assert.equal(status, 1);
    assert.match(stderr, /invalid CAIRN_RERANK "yes"/);
  });

  it('exits 1 on an unknown CAIRN_RERANK_MODEL when reranking is enabled', () => {
    const { status, stderr } = spawnServer({ CAIRN_RERANK: '1', CAIRN_RERANK_MODEL: 'bogus-reranker' });
    assert.equal(status, 1);
    assert.match(stderr, /unknown CAIRN_RERANK_MODEL "bogus-reranker"/);
  });
});
