/**
 * LongMemEval harness self-tests (roadmap W1) — fixture loading, per-question
 * isolation, corpus modes, turn/session identity, BOTH metric namespaces
 * (official_compat mirrors upstream eval_utils.py; unique_session is the
 * cleaner standard family), corpus preservation (dedup + conflict-detection
 * bypass), fail-closed validation, runner determinism, and the live-store
 * guard. CI-safe: only the checked-in synthetic fixture; no network/models.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  validateDataset, parseSessionDate, isAbstention, type LmeQuestion,
} from '../src/benchmark/longmemeval/data.js';
import {
  assertNotLiveStore, buildQuestionStore, splitTurn, UNIFORM_CONFIDENCE, LME_PROJECT,
} from '../src/benchmark/longmemeval/ingest.js';
import { recallAllAtK, ndcgAnyAtK, uniqueStable } from '../src/benchmark/longmemeval/metrics.js';
import {
  officialDcg, evaluateRetrieval, evaluateTurn2Session, turnDocId,
} from '../src/benchmark/longmemeval/official-metrics.js';
import { runBenchmark } from '../src/benchmark/longmemeval/runner.js';
import { toJsonReport, toMarkdownReport } from '../src/benchmark/longmemeval/report.js';

const FIXTURE_PATH = join(process.cwd(), 'scripts', 'longmemeval', 'fixture', 'harness-fixture.json');

function loadFixture(): LmeQuestion[] {
  return validateDataset(JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')));
}

function makeQuestion(overrides: Partial<LmeQuestion>): LmeQuestion {
  return {
    question_id: 'inline-q', question_type: 'single-session-user',
    question: 'placeholder', haystack_session_ids: [], haystack_dates: [],
    haystack_sessions: [], answer_session_ids: [],
    ...overrides,
  };
}

describe('unique_session metrics — standard definitions', () => {
  it('recall_all@k requires EVERY evidence session in the top k', () => {
    assert.equal(recallAllAtK(['a', 'b'], ['a', 'x', 'b'], 3), 1);
    assert.equal(recallAllAtK(['a', 'b'], ['a', 'x', 'b'], 2), 0);
    assert.equal(recallAllAtK([], ['x'], 5), 0);
  });

  it('standard ndcg discounts rank 2 (log2(i+2))', () => {
    assert.equal(ndcgAnyAtK(['a'], ['a', 'x'], 5), 1);
    const rank2 = ndcgAnyAtK(['a'], ['x', 'a'], 5);
    assert.ok(Math.abs(rank2 - 1 / Math.log2(3)) < 1e-9, `got ${rank2}`);
  });

  it('uniqueStable keeps first-occurrence rank order', () => {
    assert.deepEqual(uniqueStable(['s1', 's2', 's1', 's3', 's2'], s => s), ['s1', 's2', 's3']);
  });
});

describe('official_compat metrics — upstream eval_utils.py mirror', () => {
  it('DCG leaves positions 1 and 2 undiscounted', () => {
    assert.equal(officialDcg([1], 5), 1);
    assert.equal(officialDcg([1, 1], 5), 2, 'position 2 divisor is log2(2)=1');
    const withRank3 = officialDcg([1, 1, 1], 5);
    assert.ok(Math.abs(withRank3 - (2 + 1 / Math.log2(3))) < 1e-9);
  });

  it('single evidence at rank 2 scores NDCG 1.0 (the compatibility difference)', () => {
    const r = evaluateRetrieval(['x_1', 'a_1'], ['a_1'], ['a_1', 'x_1'], 5);
    assert.equal(r.ndcg, 1, 'upstream rank-2 result receives no discount');
    assert.equal(r.recallAll, 1);
    const rank3 = evaluateRetrieval(['x_1', 'y_1', 'a_1'], ['a_1'], ['a_1', 'x_1', 'y_1'], 5);
    assert.ok(Math.abs(rank3.ndcg - 1 / Math.log2(3)) < 1e-9, 'rank 3 IS discounted');
  });

  it('turn2session expands the prefix to k unique sessions and keeps repeated gains', () => {
    // Ranked turns: two turns of sA first, then sB. corpus has sA×2, sB×1, sC×1.
    const ranked = ['sA_1', 'sA_2', 'sB_1'];
    const corpus = ['sA_1', 'sA_2', 'sB_1', 'sC_1'];
    // k=2: prefix of 2 covers only {sA} → expands until {sA,sB} at effective_k=3.
    const r = evaluateTurn2Session(ranked, ['sA_2'], corpus, 2);
    assert.equal(r.recallAll, 1);
    // Stripped actual at effective_k=3: [sA, sA, sB] → rel [1,1,0], dcg=2.
    // Ideal over stripped corpus [sA,sA,sB,sC] rel sorted [1,1,0,0] @3 → 2.
    assert.equal(r.ndcg, 1);
  });

  it('turn doc ids use 1-indexed ORIGINAL turn positions', () => {
    assert.equal(turnDocId('sess', 0), 'sess_1');
    assert.equal(turnDocId('sess', 2), 'sess_3');
  });
});

describe('dataset loading — fail closed', () => {
  it('parses the official date format via Date.UTC', () => {
    assert.equal(parseSessionDate('2023/05/20 (Sat) 02:21'), '2023-05-20T02:21:00.000Z');
    assert.equal(parseSessionDate('2023/05/20 02:21'), '2023-05-20T02:21:00.000Z', 'weekday optional');
  });

  it('rejects malformed and impossible dates instead of inventing fallbacks', () => {
    assert.throws(() => parseSessionDate('not a date'), /unparseable/);
    assert.throws(() => parseSessionDate('2023-05-20 02:21'), /unparseable/);
    assert.throws(() => parseSessionDate('2023/13/40 (Sat) 02:21'), /impossible|unparseable/);
  });

  it('validates the checked-in fixture', () => {
    const questions = loadFixture();
    assert.equal(questions.length, 6);
    assert.equal(questions.filter(isAbstention).length, 1);
  });

  it('rejects structural violations', () => {
    const base = loadFixture()[0];
    const clone = (mut: (q: LmeQuestion) => void): LmeQuestion[] => {
      const q = JSON.parse(JSON.stringify(base)) as LmeQuestion;
      mut(q);
      return [q];
    };
    assert.throws(() => validateDataset(clone(q => { q.haystack_sessions[0][0].role = 'system'; })), /invalid role/);
    assert.throws(() => validateDataset(clone(q => { q.answer_session_ids = ['not-in-haystack']; })), /not present in haystack/);
    assert.throws(() => validateDataset(clone(q => { q.haystack_dates[0] = 'garbage'; })), /unparseable/);
    assert.throws(() => validateDataset(clone(q => {
      (q.haystack_sessions[0][0] as { has_answer?: unknown }).has_answer = 'yes';
    })), /non-boolean has_answer/);
    const dup = loadFixture().slice(0, 1);
    assert.throws(() => validateDataset([...dup, ...dup]), /duplicate question_id/);
  });

  it('pinned-format has_answer labels: absent/boolean accepted, null and non-boolean rejected', () => {
    const base = loadFixture()[0];
    const clone = (): LmeQuestion => JSON.parse(JSON.stringify(base)) as LmeQuestion;

    const absent = clone();
    delete (absent.haystack_sessions[0][0] as { has_answer?: unknown }).has_answer;
    assert.doesNotThrow(() => validateDataset([absent]));

    const labeled = clone();
    (labeled.haystack_sessions[0][0] as { has_answer?: unknown }).has_answer = false;
    assert.doesNotThrow(() => validateDataset([labeled]));

    // The pinned dataset has ZERO null labels (verified by full scan) —
    // null is format drift and must fail closed, not be coerced.
    const nulled = clone();
    (nulled.haystack_sessions[0][0] as { has_answer?: unknown }).has_answer = null;
    assert.throws(() => validateDataset([nulled]), /non-boolean has_answer/);
  });

  it('duplicate session ids: identical content accepted (dates may differ), conflicting content rejected', () => {
    const base = loadFixture()[0];
    const clone = (): LmeQuestion => JSON.parse(JSON.stringify(base)) as LmeQuestion;

    // Real-data shape: same filler conversation at two timeline positions —
    // all 13 pinned-dataset duplicates have identical turns but DIFFERENT dates.
    const identical = clone();
    identical.haystack_session_ids[4] = identical.haystack_session_ids[3];
    identical.haystack_sessions[4] = JSON.parse(JSON.stringify(identical.haystack_sessions[3]));
    assert.notEqual(identical.haystack_dates[4], identical.haystack_dates[3], 'fixture dates differ across sessions');
    assert.doesNotThrow(() => validateDataset([identical]));

    // Same id, different content = corrupt data — fail closed.
    const conflicting = clone();
    conflicting.haystack_session_ids[4] = conflicting.haystack_session_ids[3];
    assert.throws(() => validateDataset([conflicting]), /duplicate session id .* conflicting content/);
  });
});

describe('ingestion — corpus modes, isolation, preservation', () => {
  it('refuses to touch the live store directory', () => {
    assert.throws(() => assertNotLiveStore(join(homedir(), '.cairn', 'cairn.db')), /live store/);
    assert.doesNotThrow(() => assertNotLiveStore(':memory:'));
  });

  it('splitTurn hard-slices a single over-limit token', () => {
    assert.deepEqual(splitTurn('short turn'), ['short turn']);
    const giantToken = 'x'.repeat(5000);
    const chunks = splitTurn(giantToken);
    assert.ok(chunks.length >= 3);
    assert.ok(chunks.every(c => c.length <= 2000), 'no chunk may exceed the bound');
    assert.equal(chunks.join(''), giantToken, 'no content lost');
  });

  it('user-only corpus (official protocol) excludes assistant turns; all-roles keeps them', () => {
    const fx01 = loadFixture()[0];
    const userOnly = buildQuestionStore(fx01); // default corpus mode
    const allRoles = buildQuestionStore(fx01, { corpusMode: 'all-roles' });
    try {
      const count = (s: typeof userOnly): number =>
        (s.db.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number }).n;
      assert.equal(userOnly.corpusMode, 'user-only');
      assert.equal(count(userOnly), 7, 'user turns only: 2+1+1+1+2');
      assert.equal(count(allRoles), 11, 'all roles: 3+2+2+2+2');
      assert.equal(userOnly.corpusTurns.length, 7);
      // Original turn indices survive role filtering (official doc ids)
      assert.deepEqual(userOnly.evidenceTurns, [{ sessionId: 'fx01-s1', occurrence: 0, turnIdx: 2 }]);

      const rows = userOnly.db.prepare('SELECT confidence, created_at FROM memories').all() as Array<{ confidence: number; created_at: string }>;
      assert.ok(rows.every(r => r.confidence === UNIFORM_CONFIDENCE), 'uniform confidence');
      assert.ok(rows.every(r => r.created_at.startsWith('2023-')), 'created_at backdated');
    } finally {
      userOnly.close();
      allRoles.close();
    }
  });

  it('preserves opposing version claims — conflict detection must not retire evidence', () => {
    const q = makeQuestion({
      question_id: 'conflict-q',
      question: 'What version does the api gateway run in production?',
      haystack_session_ids: ['cf-s1', 'cf-s2'],
      haystack_dates: ['2023/01/10 (Tue) 09:00', '2023/06/10 (Sat) 09:00'],
      haystack_sessions: [
        [{ role: 'user', content: 'The api gateway runs version 18.1 in production.', has_answer: true }],
        [{ role: 'user', content: 'The api gateway runs version 20.3 in production.', has_answer: true }],
      ],
      answer_session_ids: ['cf-s1', 'cf-s2'],
    });
    const store = buildQuestionStore(q);
    try {
      const superseded = (store.db.prepare(
        'SELECT COUNT(*) AS n FROM memories WHERE superseded_by IS NOT NULL'
      ).get() as { n: number }).n;
      assert.equal(superseded, 0, 'no benchmark memory may be superseded');

      const results = store.repo.search('api gateway version production', {
        project: LME_PROJECT, readOnly: true, minConfidence: 0,
      });
      const sessions = new Set(results.map(r => store.memoryToSession.get(r.memory.id)));
      assert.ok(sessions.has('cf-s1') && sessions.has('cf-s2'),
        'BOTH opposing version claims must remain retrievable');
    } finally {
      store.close();
    }
  });

  it('keeps per-question stores fully isolated', () => {
    const [fx01, fx02] = loadFixture();
    const store1 = buildQuestionStore(fx01);
    const store2 = buildQuestionStore(fx02);
    try {
      assert.ok([...new Set(store1.memoryToSession.values())].every(s => s.startsWith('fx01-')));
      assert.ok([...new Set(store2.memoryToSession.values())].every(s => s.startsWith('fx02-')));
    } finally {
      store1.close();
      store2.close();
    }
  });

  it('ingestion and read-only retrieval leave recall stats untouched', () => {
    const store = buildQuestionStore(loadFixture()[0]);
    try {
      store.repo.search('solar panel rebate', { project: LME_PROJECT, readOnly: true, minConfidence: 0 });
      store.repo.recallHybrid('solar panel rebate', null, { project: LME_PROJECT, readOnly: true, minConfidence: 0 });
      const touched = (store.db.prepare(
        'SELECT COUNT(*) AS n FROM memories WHERE recall_count > 0 OR last_recalled IS NOT NULL'
      ).get() as { n: number }).n;
      assert.equal(touched, 0);
    } finally {
      store.close();
    }
  });
});

describe('runner — end-to-end on the fixture', () => {
  it('fts variant produces the designed profile in BOTH namespaces', async () => {
    const run = await runBenchmark(loadFixture(), { variant: 'fts', ks: [5, 10] });

    assert.equal(run.variantLabel, 'fts');
    assert.equal(run.corpusMode, 'user-only');
    assert.equal(run.aggregates.questions, 6);
    assert.equal(run.aggregates.skippedAbstention, 1);
    assert.equal(run.aggregates.skippedNoEvidenceTurns, 0);

    const byId = new Map(run.perQuestion.map(r => [r.questionId, r]));
    const fx01 = byId.get('fx-01-ie')!;
    assert.equal(fx01.unique?.sessionRecallAll[5], 1);
    assert.equal(fx01.unique?.turnRecallAll?.[5], 1);
    assert.equal(fx01.official?.sessionRecallAll[5], 1);
    assert.equal(fx01.official?.turnNdcg?.[5], 1,
      'official turn NDCG is 1.0 at rank 1 OR 2 — both undiscounted upstream');
    assert.equal(byId.get('fx-02-multi')?.official?.sessionRecallAll[5], 1);
    assert.equal(byId.get('fx-05-miss')?.unique?.sessionRecallAll[5], 0);
    assert.equal(byId.get('fx-05-miss')?.official?.sessionRecallAll[5], 0);
    assert.equal(byId.get('fx-06-ie_abs')?.abstention, true);

    assert.ok(Math.abs(run.aggregates.unique.sessionRecallAll[5] - 0.8) < 1e-9);
    assert.ok(Math.abs(run.aggregates.official.sessionRecallAll[5] - 0.8) < 1e-9);

    assert.deepEqual(fx01.audit?.evidenceSessions, ['fx01-s1']);
    assert.deepEqual(fx01.audit?.evidenceTurnIds, ['fx01-s1_3'], '1-indexed original position');
  });

  it('separates no-evidence-turn skips from abstention skips (official semantics)', async () => {
    const q = makeQuestion({
      question_id: 'assist-evidence-q',
      question: 'What color was the rented kayak?',
      haystack_session_ids: ['ae-s1'],
      haystack_dates: ['2023/04/01 (Sat) 10:00'],
      haystack_sessions: [[
        { role: 'user', content: 'We rented a kayak at the lake today.' },
        { role: 'assistant', content: 'The rented kayak was bright red.', has_answer: true },
      ]],
      answer_session_ids: ['ae-s1'],
    });
    const run = await runBenchmark([q], { variant: 'fts', ks: [5] });
    const row = run.perQuestion[0];

    assert.equal(run.aggregates.skippedAbstention, 0);
    assert.equal(run.aggregates.skippedNoEvidenceTurns, 1, 'assistant-only evidence has no user-side labels');
    assert.equal(row.noEvidenceTurns, true);
    assert.equal(row.official, undefined, 'official namespace skips the question entirely');
    assert.equal(row.unique?.sessionRecallAll[5], 1, 'unique_session still scores sessions via answer ids');
    assert.equal(row.unique?.turnRecallAll, undefined, 'no turn metrics without labeled turns');
    assert.equal(run.aggregates.official.scored, 0);
    assert.equal(run.aggregates.unique.scored, 1);
  });

  it('upstream parity: duplicate corpus occurrences consume official_compat top-k; unique_session dedups', async () => {
    // Real-data shape: identical filler session at two timeline positions,
    // outranking the evidence. Upstream keeps every corpus copy, so the six
    // filler entries (3 turns × 2 occurrences) fill official top-5 and the
    // evidence at rank 7 is missed; the deduplicated unique_session ranking
    // (3 filler ids + evidence at rank 4) still recalls it.
    const fillerTurns = [
      { role: 'user', content: 'zephyr crystal waterfall shimmer' },
      { role: 'user', content: 'crystal waterfall zephyr glow' },
      { role: 'user', content: 'waterfall zephyr crystal mist' },
    ];
    const q = makeQuestion({
      question_id: 'dup-parity-q',
      question: 'zephyr crystal waterfall',
      haystack_session_ids: ['dup-s1', 'dup-s1', 'ans-s1'],
      haystack_dates: ['2023/03/01 (Wed) 10:00', '2023/04/01 (Sat) 10:00', '2023/02/01 (Wed) 10:00'],
      haystack_sessions: [
        fillerTurns,
        JSON.parse(JSON.stringify(fillerTurns)),
        [{ role: 'user', content: 'my zephyr crystal pendant was a gift', has_answer: true }],
      ],
      answer_session_ids: ['ans-s1'],
    });
    assert.doesNotThrow(() => validateDataset([q]), 'identical duplicate passes validation');

    const run = await runBenchmark([q], { variant: 'fts', ks: [5] });
    const row = run.perQuestion[0];
    assert.equal(row.official?.turnRecallAll?.[5], 0, 'duplicates occupy official top-5; evidence missed');
    assert.equal(row.official?.turnNdcg?.[5], 0);
    assert.equal(row.unique?.turnRecallAll?.[5], 1, 'unique_session collapses duplicates; evidence within 5');

    const rankedIds = row.audit?.rankedTurnIds ?? [];
    assert.equal(rankedIds.length, 5, 'audit list carries the occurrence-preserving ranking');
    assert.ok(new Set(rankedIds).size < rankedIds.length, 'duplicate doc ids visible in ranked list');
    assert.ok(!rankedIds.includes('ans-s1_1'), 'evidence pushed out of top-5');
  });

  it('collapses split chunks of one turn occurrence into a single ranked entry', async () => {
    const bigContent = 'quasar nebulae harmonics resonate deeply '.repeat(120).trim();
    assert.ok(bigContent.length > 4000, 'turn must split into multiple chunks');
    const q = makeQuestion({
      question_id: 'chunk-collapse-q',
      question: 'quasar nebulae harmonics',
      haystack_session_ids: ['ck-s1'],
      haystack_dates: ['2023/03/01 (Wed) 10:00'],
      haystack_sessions: [[{ role: 'user', content: bigContent, has_answer: true }]],
      answer_session_ids: ['ck-s1'],
    });
    const run = await runBenchmark([q], { variant: 'fts', ks: [5] });
    const row = run.perQuestion[0];
    assert.deepEqual(row.audit?.rankedTurnIds, ['ck-s1_1'], 'all chunks of one occurrence collapse to one entry');
    assert.equal(row.official?.turnRecallAll?.[5], 1);
    assert.equal(row.unique?.turnRecallAll?.[5], 1);
  });

  it('passes explicit embedFn roles: documents at ingest, exactly one query per question', async () => {
    // Asymmetric-prefix challengers embed queries and documents differently;
    // a role-less fn embedding the query as a document would silently
    // invalidate every A/B result.
    const calls: Array<{ text: string; role: string }> = [];
    const fakeEmbed = async (text: string, role: 'query' | 'document'): Promise<Float32Array> => {
      calls.push({ text, role });
      const v = new Float32Array(8);
      v[0] = 1;
      return v;
    };
    const q = loadFixture().find(x => !isAbstention(x))!;
    await runBenchmark([q], { variant: 'hybrid', ks: [5], embedFn: fakeEmbed });

    const queryCalls = calls.filter(c => c.role === 'query');
    assert.equal(queryCalls.length, 1, 'exactly one query-role call per question');
    assert.equal(queryCalls[0].text, q.question, 'the benchmark question embeds as a query');
    const docCalls = calls.filter(c => c.role === 'document');
    assert.equal(docCalls.length, calls.length - 1, 'every other call is document-role');
    assert.ok(docCalls.length > 0, 'corpus documents were embedded');
  });

  it('reports are deterministic across runs (byte-identical without timestamp)', async () => {
    const questions = loadFixture();
    const a = await runBenchmark(questions, { variant: 'fts', ks: [5, 10] });
    const b = await runBenchmark(questions, { variant: 'fts', ks: [5, 10] });
    assert.equal(toJsonReport(a, { dataset: 'fixture' }), toJsonReport(b, { dataset: 'fixture' }));
    assert.equal(toMarkdownReport(a, { dataset: 'fixture' }), toMarkdownReport(b, { dataset: 'fixture' }));
  });

  it('markdown report renders a per-ability breakdown table per namespace', async () => {
    const run = await runBenchmark(loadFixture(), { variant: 'fts', ks: [5, 10] });
    const md = toMarkdownReport(run, { dataset: 'fixture' });
    const breakdownHeaders = md.match(/\| ability \(session recall_all\) \| scored \| @5 \| @10 \|/g) ?? [];
    assert.equal(breakdownHeaders.length, 2, 'one breakdown table per namespace');
    for (const type of new Set(run.perQuestion.filter(q => !q.abstention).map(q => q.questionType))) {
      assert.ok(md.includes(`| ${type} |`), `breakdown row for ${type}`);
    }
  });

  it('hybrid without embeddings is labeled hybrid-fts-fallback and carries audit meta', async () => {
    const run = await runBenchmark(loadFixture(), { variant: 'hybrid', ks: [5] });
    assert.equal(run.variant, 'hybrid');
    assert.equal(run.variantLabel, 'hybrid-fts-fallback');
    assert.equal(run.embedded, false);

    const report = JSON.parse(toJsonReport(run, {
      dataset: 'fixture', datasetRevision: 'rev123', datasetSha256: 'sha456',
      harnessCommit: 'abc1234', harnessVersion: 'waykeep@5.1.0',
    }));
    assert.equal(report.meta.variant_label, 'hybrid-fts-fallback');
    assert.equal(report.meta.corpus_mode, 'user-only');
    assert.equal(report.meta.dataset_revision, 'rev123');
    assert.equal(report.meta.dataset_sha256, 'sha456');
    assert.equal(report.meta.harness_commit, 'abc1234');
    assert.ok(report.meta.pool_size > 0);
    assert.ok(report.meta.candidates_per_retriever > 0);
    assert.ok(report.aggregates.official_compat.session_recall_all['5'] !== undefined);
    assert.ok(report.aggregates.unique_session.session_recall_all['5'] !== undefined);
  });
});
