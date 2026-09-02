/**
 * Incident fixture — the 2026-09-01 recall inversion, pinned as a
 * characterization test (remediation plan, step 0b).
 *
 * The incident: on the FTS-only degraded path, `computeScore` let
 * confidence × source-weight × recency (a query-independent prior with ~22.5×
 * range) overwhelm lexical relevance (~1.33× range), ranking truncated raw
 * transcript captures ABOVE the distilled lesson that answered the query.
 * LongMemEval cannot see this class — it ingests at uniform confidence by
 * design — so this fixture is the only instrument that can falsify a fix.
 *
 * STEP 6 LANDED: the characterization assertions below were flipped
 * DELIBERATELY in the step-6 commit — they now pin the FIX (relevance =
 * tokenOverlap × BM25 share, floor 0.05 / gain 1.9: the distilled lesson
 * outranks raw high-confidence pastes on every path; the prior breaks ties
 * instead of overruling relevance).
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type Database from 'better-sqlite3';
import { openDatabase } from '../src/db/connection.js';
import { MemoryRepository } from '../src/db/memory-repository.js';
import { embeddingToBuffer } from '../src/utils/embeddings.js';

let db: Database.Database;
let repo: MemoryRepository;

/** The distilled lesson that answered the incident query. */
const LESSON =
  "Before trusting a probe's result, prove the probe measures the thing — " +
  'cheapest proof is a control that must fail against a known positive result.';

/**
 * Raw truncated captures, shaped like the real rows: opening of a pasted
 * prompt, cut mid-thought, sharing surface vocabulary with the query
 * ("result", "test", "check") without answering it.
 */
const RAW_DISTRACTORS = [
  'this was where we were before we got disconnected - Monitor result Watch for test completion in billing run - Monitor started task b2w5dfwge timeout 600s - Background command Run billing test check res',
  'Do not push cbb87d7 yet. I see one security blocker in the result. Finding 19 payment controllers webhook py 88 verifies the HMAC before resolving the transaction and the check result shows the test ne',
  'Findings High - Comparison headers use duplicate OWL keys in the result. In account_report xml line 39 headers carry duplicate keys and the test result check shows the render probe fails on every seco',
];

const QUERY = 'verify a probe test result before concluding';

beforeEach(() => {
  db = openDatabase({ dbPath: ':memory:' });
  repo = new MemoryRepository(db);

  repo.create({ content: LESSON, kind: 'correction', project: null, source: 'learned', confidence: 0.8 });
  for (const content of RAW_DISTRACTORS) {
    repo.create({ content, kind: 'correction', project: null, source: 'user', confidence: 0.89 });
  }
});

afterEach(() => db.close());

const ftsRanking = () =>
  repo.recall(QUERY, { readOnly: true, maxResults: 10 })
    .map(r => ({ isLesson: r.memory.content === LESSON, score: r.score }));

describe('incident fixture — FTS-path inversion (flips at step 6)', () => {
  it('FIXED (step 6): the distilled lesson outranks high-confidence raw captures', () => {
    const ranked = ftsRanking();
    const lessonRank = ranked.findIndex(r => r.isLesson);
    assert.equal(lessonRank, 0,
      `the lesson must rank #1 on the FTS path (got rank ${lessonRank}) — relevance decides, the prior breaks ties`);
  });

  it('FIXED (step 6): the lesson score exceeds every distractor score', () => {
    const ranked = ftsRanking();
    const lesson = ranked.find(r => r.isLesson);
    const topDistractor = ranked.find(r => !r.isLesson);
    assert.ok(lesson && topDistractor);
    assert.ok(lesson.score > topDistractor.score,
      `expected lesson score > distractor score, got ${lesson.score.toFixed(4)} vs ${topDistractor.score.toFixed(4)}`);
  });

  it('harness property: repeated read-only replays are identical and mutate nothing', () => {
    const first = ftsRanking();
    const second = ftsRanking();
    assert.deepEqual(second, first, 'read-only replay must be deterministic');
    const stats = db.prepare(
      'SELECT SUM(recall_count) AS recalls, COUNT(last_recalled) AS stamped FROM memories',
    ).get() as { recalls: number; stamped: number };
    assert.equal(stats.recalls, 0, 'read-only replay must not bump recall_count');
    assert.equal(stats.stamped, 0, 'read-only replay must not stamp last_recalled');
  });

  it('FIXED (step 6): hybrid with no embedding degrades to the SAME fixed ordering', () => {
    const hybrid = repo.recallHybrid(QUERY, null, { readOnly: true, maxResults: 10 })
      .map(r => ({ isLesson: r.memory.content === LESSON }));
    const lessonRank = hybrid.findIndex(r => r.isLesson);
    assert.equal(lessonRank, 0,
      'the degraded path inherits the FIXED FTS ordering — bistability collapses toward the right answer');
  });

  it('CAUSAL: every distractor is retrieved — the inversion is ranking, not admission', () => {
    const ranked = ftsRanking();
    assert.equal(ranked.length, 1 + RAW_DISTRACTORS.length,
      'all four rows must be candidates; a step-6 "fix" that merely drops distractors from the pool does not satisfy this fixture');
  });

  it('CAUSAL: with the prior neutralized, the lesson wins on relevance alone', () => {
    // Counterfactual store: identical content, identical kind, but EQUAL
    // confidence and EQUAL source. If the lesson ranks #1 here, the inversion
    // in the main fixture is attributable to the confidence/source prior —
    // not to tokenization, stemming, or any other FTS quirk. This is the
    // assertion that stops step 6 from "passing" for the wrong reason.
    const cdb = openDatabase({ dbPath: ':memory:' });
    try {
      const crepo = new MemoryRepository(cdb);
      crepo.create({ content: LESSON, kind: 'correction', project: null, source: 'learned', confidence: 0.8 });
      for (const content of RAW_DISTRACTORS) {
        crepo.create({ content, kind: 'correction', project: null, source: 'learned', confidence: 0.8 });
      }
      const ranked = crepo.recall(QUERY, { readOnly: true, maxResults: 10 });
      assert.ok(ranked.length >= 1 + RAW_DISTRACTORS.length, 'counterfactual store must retrieve all rows');
      assert.equal(ranked[0].memory.content, LESSON,
        'equal prior must leave the lesson on top — if this fails, the inversion is NOT (only) the prior and the mechanism table is wrong');
    } finally {
      cdb.close();
    }
  });

  it('SCOPE: a project-scoped lesson loses to global distractors the same way', () => {
    // The incident lesson was global, but step 2 makes project-scoped learning
    // the common case — pin that the prior beats relevance across scopes too.
    const sdb = openDatabase({ dbPath: ':memory:' });
    try {
      const srepo = new MemoryRepository(sdb);
      srepo.create({ content: LESSON, kind: 'correction', project: 'proj-x', source: 'learned', confidence: 0.8 });
      for (const content of RAW_DISTRACTORS) {
        srepo.create({ content, kind: 'correction', project: null, source: 'user', confidence: 0.89 });
      }
      const ranked = srepo.recall(QUERY, { project: 'proj-x', readOnly: true, maxResults: 10 })
        .map(r => ({ isLesson: r.memory.content === LESSON }));
      const lessonRank = ranked.findIndex(r => r.isLesson);
      assert.ok(lessonRank >= 0, 'project-scoped lesson must be retrieved in its own project');
      assert.equal(lessonRank, 0,
        'FIXED (step 6): a project-scoped lesson outranks global raw captures on relevance');
    } finally {
      sdb.close();
    }
  });

  describe('warm hybrid (synthetic 384-dim embeddings — no model load)', () => {
    /** Deterministic unit vectors: query ≈ lesson, distractors far. */
    const vec = (seed: number, close: boolean): Float32Array => {
      const v = new Float32Array(384);
      if (close) { v[0] = 1; v[1] = seed * 0.01; }        // near the query axis
      else { v[100 + seed] = 1; }                          // orthogonal
      let n = 0; for (const x of v) n += x * x;
      n = Math.sqrt(n); for (let i = 0; i < v.length; i++) v[i] /= n;
      return v;
    };
    const QUERY_VEC = (() => { const v = new Float32Array(384); v[0] = 1; return v; })();

    let wdb: Database.Database;
    let wrepo: MemoryRepository;

    beforeEach(() => {
      wdb = openDatabase({ dbPath: ':memory:' });
      wrepo = new MemoryRepository(wdb);
      wrepo.create({
        content: LESSON, kind: 'correction', project: null, source: 'learned',
        confidence: 0.8, embedding: embeddingToBuffer(vec(1, true)),
      });
      RAW_DISTRACTORS.forEach((content, i) => {
        wrepo.create({
          content, kind: 'correction', project: null, source: 'user',
          confidence: 0.89, embedding: embeddingToBuffer(vec(i, false)),
        });
      });
    });

    afterEach(() => wdb.close());

    const warmRanking = () =>
      wrepo.recallHybrid(QUERY, embeddingToBuffer(QUERY_VEC), { readOnly: true, maxResults: 10 })
        .map(r => ({ isLesson: r.memory.content === LESSON, score: r.score }));

    it('CHARACTERIZATION: warm hybrid ordering with a decisive vector signal', () => {
      // The vector arm ranks the lesson #1 by construction (cosine ~1 vs ~0).
      // Whatever RRF then does to the fusion is the behavior under test:
      // pin the lesson's warm rank so any ranking change must pass this gate.
      const ranked = warmRanking();
      const lessonRank = ranked.findIndex(r => r.isLesson);
      assert.ok(lessonRank >= 0, 'lesson must be retrieved on the warm path');
      // FIXED (step 6): with the FTS arm relevance-first, both RRF legs put
      // the lesson #1 and the fusion agrees — no RRF change was needed, the
      // bistability collapsed by fixing the defective leg.
      assert.equal(lessonRank, 0,
        `warm-hybrid: the lesson must fuse to #1 (got #${lessonRank + 1})`);
    });

    it('warm replay is deterministic and mutates nothing', () => {
      const first = warmRanking();
      const second = warmRanking();
      assert.deepEqual(second, first);
      const stats = wdb.prepare(
        'SELECT SUM(recall_count) AS recalls, COUNT(last_recalled) AS stamped FROM memories',
      ).get() as { recalls: number; stamped: number };
      assert.equal(stats.recalls, 0);
      assert.equal(stats.stamped, 0);
    });
  });
});
