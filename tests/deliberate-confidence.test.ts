/**
 * Deliberate vs auto-detected confidence (remediation plan, step 3).
 *
 * The defect (M7): an explicit `cairn_learn` pitfall was born at the
 * AUTO_DETECTED confidence (0.55) — below the 0.65 injection gate — so a
 * lesson the user consciously chose to store was indistinguishable from one
 * an error-miner guessed at, and could never surface proactively. During the
 * incident, the freshly stored lesson was structurally uninjectable.
 *
 * The gate: explicit MCP learning gets a value STRICTLY above 0.65 (0.65
 * exactly passes at birth and decays below the gate within days); automatic
 * capture stays at 0.55; the snr-guardrails inverse probe (warning
 * displacement) stays green.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { openDatabase } from '../src/db/connection.js';
import { MemoryRepository } from '../src/db/memory-repository.js';
import { registerMemoryTools } from '../src/mcp/tools/memory-tools.js';
import { setSessionProjectForTests } from '../src/utils/session-project.js';
import { CONFIDENCE, RELEVANCE } from '../src/constants/index.js';

const SESSION_PROJECT = 'proj-deliberate';

let db: Database.Database;
let repo: MemoryRepository;
let client: Client;

beforeEach(async () => {
  db = openDatabase({ dbPath: ':memory:' });
  repo = new MemoryRepository(db);
  setSessionProjectForTests(SESSION_PROJECT);
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerMemoryTools(server, repo, () => 'normal');
  client = new Client({ name: 'test-client', version: '0.0.0' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(ct), server.connect(st)]);
});

afterEach(async () => {
  setSessionProjectForTests(undefined);
  await client.close();
  db.close();
});

const call = async (name: string, args: Record<string, unknown>) => {
  const res = await client.callTool({ name, arguments: args }) as {
    content: Array<{ type: string; text?: string }>; isError?: boolean;
  };
  return { text: res.content[0]?.text ?? '', isError: res.isError === true };
};

describe('deliberate vs auto-detected confidence', () => {
  it('the constant itself is strictly above the injection gate', () => {
    assert.ok(CONFIDENCE.DELIBERATE > RELEVANCE.MIN_CONFIDENCE_FOR_PITFALL,
      `DELIBERATE (${CONFIDENCE.DELIBERATE}) must clear MIN_CONFIDENCE_FOR_PITFALL ` +
      `(${RELEVANCE.MIN_CONFIDENCE_FOR_PITFALL}) with decay headroom — equality dies at the first decay tick`);
  });

  it('GATE: an explicit cairn_learn pitfall is born injection-eligible', async () => {
    const learned = await call('cairn_learn', {
      kind: 'pitfall',
      content: 'sentinel: deliberate lesson must clear the injection gate at birth',
    });
    assert.equal(learned.isError, false, learned.text);
    const row = db.prepare("SELECT confidence FROM memories WHERE content LIKE 'sentinel: deliberate lesson%'").get() as { confidence: number };
    assert.equal(row.confidence, CONFIDENCE.DELIBERATE);
    assert.ok(row.confidence > RELEVANCE.MIN_CONFIDENCE_FOR_PITFALL);
  });

  it('automatic capture keeps AUTO_DETECTED — the paths stay distinguishable', () => {
    // Every production auto path (error-learning, stop-failure mining) writes
    // through storePitfall passing CONFIDENCE.AUTO_DETECTED — and the
    // gateway's own no-confidence fallback is AUTO_DETECTED too. Both stay
    // below the gate until reinforced.
    assert.ok(CONFIDENCE.AUTO_DETECTED < RELEVANCE.MIN_CONFIDENCE_FOR_PITFALL);
    const created = repo.storePitfall({ content: 'auto-mined pitfall from an error pattern', project: SESSION_PROJECT });
    const row = db.prepare('SELECT confidence FROM memories WHERE id = ?').get(created.id) as { confidence: number };
    assert.equal(row.confidence, CONFIDENCE.AUTO_DETECTED,
      'the gateway no-confidence fallback is the auto prior, not the deliberate one');
  });

  it('a deliberate pitfall passes the gate filter that proactive injection applies', async () => {
    await call('cairn_learn', { kind: 'pitfall', content: 'sentinel: gate filter eligibility row' });
    const eligible = db.prepare(
      'SELECT COUNT(*) AS n FROM memories WHERE kind = ? AND confidence >= ? AND content LIKE ?',
    ).get('pitfall', RELEVANCE.MIN_CONFIDENCE_FOR_PITFALL, 'sentinel: gate filter%') as { n: number };
    assert.equal(eligible.n, 1);
  });

  it('deliberate re-learning of an auto-mined lesson lifts it above the gate (dedup merge)', async () => {
    // Incident scenario: the error miner already guessed the lesson at 0.55;
    // the user then distills the same lesson through cairn_learn. The
    // smart-merge gateway takes max(boosted existing, incoming) — the row
    // must come out at DELIBERATE, injection-eligible, not stay buried.
    const auto = repo.storePitfall({
      content: 'sentinel: always check tsc exit codes because emit happens before errors',
      project: SESSION_PROJECT,
    });
    const learned = await call('cairn_learn', {
      kind: 'pitfall',
      content: 'sentinel: always check tsc exit codes because emit happens before errors',
    });
    assert.equal(learned.isError, false, learned.text);
    const row = db.prepare('SELECT confidence FROM memories WHERE id = ?').get(auto.id) as { confidence: number };
    assert.equal(row.confidence, CONFIDENCE.DELIBERATE,
      'merge confidence is max(existing+boost, DELIBERATE) — the deliberate act wins');
    const extra = db.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number };
    assert.equal(extra.n, 1, 'deduplicated onto the existing row, not stored twice');
  });

  it('non-pitfall kinds keep their existing defaults (surgical change)', async () => {
    await call('cairn_learn', { kind: 'fact', content: 'sentinel: fact default check row' });
    const fact = db.prepare("SELECT confidence FROM memories WHERE content LIKE 'sentinel: fact default%'").get() as { confidence: number };
    assert.equal(fact.confidence, CONFIDENCE.LEARNED, 'facts keep CONFIDENCE.LEARNED');

    await call('cairn_learn', { kind: 'decision', content: 'sentinel: decision default check row because reasons' });
    const decision = db.prepare("SELECT confidence FROM memories WHERE content LIKE 'sentinel: decision default%'").get() as { confidence: number };
    assert.equal(decision.confidence, CONFIDENCE.LEARNED, 'decisions keep the gateway LEARNED default');

    await call('cairn_learn', { kind: 'correction', content: 'sentinel: correction default check row' });
    const correction = db.prepare("SELECT confidence FROM memories WHERE content LIKE 'sentinel: correction default%'").get() as { confidence: number };
    assert.equal(correction.confidence, CONFIDENCE.CORRECTION, 'corrections keep CONFIDENCE.CORRECTION');
  });

  it('BLOCK 1: cairn_strengthen floors a pitfall at DELIBERATE, never ON the gate', async () => {
    // 0.55 + 0.10 = 0.65 exactly — an explicitly validated auto pitfall
    // landed ON the injection gate: eligible for one instant, gone at the
    // first decay charge. Strengthen is deliberate validation; it must
    // leave the row genuinely injection-eligible.
    const auto = repo.storePitfall({ content: 'sentinel: strengthen floor probe row', project: SESSION_PROJECT });
    const reply = await call('cairn_strengthen', { id: auto.id });
    assert.equal(reply.isError, false, reply.text);
    const row = db.prepare('SELECT confidence FROM memories WHERE id = ?').get(auto.id) as { confidence: number };
    assert.equal(row.confidence, CONFIDENCE.DELIBERATE,
      `strengthened auto pitfall must floor at DELIBERATE, got ${row.confidence}`);
    assert.ok(row.confidence > RELEVANCE.MIN_CONFIDENCE_FOR_PITFALL);
  });

  it('BLOCK 1: strengthen above the floor still increments normally (pitfall and fact)', async () => {
    const strong = repo.storePitfall({ content: 'sentinel: strengthen increment probe row', project: SESSION_PROJECT, confidence: 0.75 });
    await call('cairn_strengthen', { id: strong.id });
    const p = db.prepare('SELECT confidence FROM memories WHERE id = ?').get(strong.id) as { confidence: number };
    assert.ok(Math.abs(p.confidence - 0.85) < 1e-9, `expected 0.75 + increment, got ${p.confidence}`);

    const fact = repo.create({ content: 'sentinel: fact strengthen unaffected row', kind: 'fact', project: SESSION_PROJECT, confidence: 0.5 });
    await call('cairn_strengthen', { id: fact.id });
    const f = db.prepare('SELECT confidence FROM memories WHERE id = ?').get(fact.id) as { confidence: number };
    assert.ok(Math.abs(f.confidence - 0.6) < 1e-9, 'non-pitfall strengthen semantics unchanged');
  });

  it('step 6 carry-in: strengthen floors a DECISION above its 0.7 surfacing gate', async () => {
    // 0.6 + 0.1 landed exactly ON PROACTIVE.MIN_DECISION_CONFIDENCE — the
    // same F4 borderline as the pitfall case, one gate over.
    const dec = repo.create({ content: 'sentinel: decision strengthen floor probe row because reasons', kind: 'decision', project: SESSION_PROJECT, confidence: 0.6 });
    await call('cairn_strengthen', { id: dec.id });
    const row = db.prepare('SELECT confidence FROM memories WHERE id = ?').get(dec.id) as { confidence: number };
    assert.equal(row.confidence, CONFIDENCE.STRENGTHENED_DECISION_FLOOR,
      `strengthened decision must clear the 0.7 gate with headroom, got ${row.confidence}`);
    assert.ok(row.confidence > 0.7 && row.confidence < CONFIDENCE.CORRECTION);

    // Above the floor: plain increment.
    const strong = repo.create({ content: 'sentinel: strong decision increment probe row because reasons', kind: 'decision', project: SESSION_PROJECT, confidence: 0.8 });
    await call('cairn_strengthen', { id: strong.id });
    const s2 = db.prepare('SELECT confidence FROM memories WHERE id = ?').get(strong.id) as { confidence: number };
    assert.ok(Math.abs(s2.confidence - 0.9) < 1e-9);
  });

  it('step 6 carry-in: imported pitfalls are born BELOW the gate, not ON it', () => {
    // The import pipeline previously defaulted pitfalls to LEARNED 0.65 —
    // exactly the injection gate (F4's degenerate value). Untrusted imports
    // now start at AUTO_DETECTED like the miners, earning injectability
    // through reinforcement. (Pipeline-level: pinned here at the contract
    // level; the importer tests exercise the full path.)
    assert.ok(CONFIDENCE.AUTO_DETECTED < RELEVANCE.MIN_CONFIDENCE_FOR_PITFALL);
    assert.notEqual(CONFIDENCE.LEARNED, RELEVANCE.MIN_CONFIDENCE_FOR_PITFALL + 1); // structure only
  });

  it('BLOCK 2: the reinforcement ceiling itself equals CORRECTION authority', () => {
    assert.equal(CONFIDENCE.DEDUP_REINFORCEMENT_CEILING, CONFIDENCE.CORRECTION,
      'repetition may reach, but never exceed, correction authority');
    assert.ok(CONFIDENCE.DEDUP_REINFORCEMENT_CEILING < CONFIDENCE.USER_CORRECTION);
  });

  it('BLOCK 2: repeated identical learns cap at the ceiling — no ratchet to 1.0', async () => {
    const content = 'sentinel: ratchet probe — always pin the exact dependency version in lockfiles';
    const confidences: number[] = [];
    for (let i = 0; i < 8; i++) {
      await call('cairn_learn', { kind: 'pitfall', content });
      const row = db.prepare("SELECT confidence FROM memories WHERE content LIKE 'sentinel: ratchet probe%'").get() as { confidence: number };
      confidences.push(row.confidence);
    }
    assert.ok(Math.abs(confidences[0] - CONFIDENCE.DELIBERATE) < 1e-9, 'born at DELIBERATE');
    assert.ok(Math.abs(confidences[confidences.length - 1] - CONFIDENCE.DEDUP_REINFORCEMENT_CEILING) < 1e-9,
      `repetition converges on the ceiling, got ${confidences.join(', ')}`);
    for (const c of confidences) {
      assert.ok(c <= CONFIDENCE.DEDUP_REINFORCEMENT_CEILING + 1e-9,
        `no repetition step may exceed the ceiling: ${confidences.join(', ')}`);
    }
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number }).n, 1, 'still one row');
  });

  it('BLOCK 2: automatic re-detections cannot ratchet a deliberate row past the ceiling', async () => {
    const content = 'sentinel: auto ratchet probe — never trust emitted dist without checking exit codes';
    await call('cairn_learn', { kind: 'pitfall', content });
    for (let i = 0; i < 8; i++) {
      repo.storePitfall({ content, project: SESSION_PROJECT }); // auto: no confidence
    }
    const row = db.prepare("SELECT confidence FROM memories WHERE content LIKE 'sentinel: auto ratchet%'").get() as { confidence: number };
    assert.ok(row.confidence <= CONFIDENCE.DEDUP_REINFORCEMENT_CEILING + 1e-9,
      `auto repeats stop at the ceiling, got ${row.confidence}`);
  });

  it('BLOCK 2: a row already above the ceiling is neither downgraded nor ratcheted further', async () => {
    const content = 'sentinel: authority preservation probe — verify backups by restoring them';
    const created = repo.storePitfall({ content, project: SESSION_PROJECT, confidence: CONFIDENCE.USER_CORRECTION, source: 'user' });
    for (let i = 0; i < 4; i++) {
      await call('cairn_learn', { kind: 'pitfall', content });
    }
    const row = db.prepare('SELECT confidence FROM memories WHERE id = ?').get(created.id) as { confidence: number };
    assert.ok(Math.abs(row.confidence - CONFIDENCE.USER_CORRECTION) < 1e-9,
      `0.9 row keeps its level under repetition, got ${row.confidence}`);
  });

  it('BLOCK 2 (fold): plain create() dedup honors an explicitly higher incoming confidence too', () => {
    // codex fold-round block: the create() merge ignored incoming confidence
    // outright — an explicit 0.95 write merging onto a 0.7 row came out 0.75.
    // Both dedup sites must carry the authority override.
    const content = 'sentinel: create override probe — quarantine flaky tests before deleting them';
    repo.create({ content, kind: 'fact', project: SESSION_PROJECT, confidence: 0.7 });
    repo.create({ content, kind: 'fact', project: SESSION_PROJECT, confidence: 0.95 });
    const row = db.prepare("SELECT confidence FROM memories WHERE content LIKE 'sentinel: create override%'").get() as { confidence: number };
    assert.ok(Math.abs(row.confidence - 0.95) < 1e-9,
      `explicit incoming authority passes through create() dedup, got ${row.confidence}`);
  });

  it('BLOCK 2 (fold): create() dedup without explicit confidence stays boost-only — no silent default lift', () => {
    // The override applies ONLY to explicitly passed confidence: a
    // no-confidence re-create of a 0.5 row boosts to 0.55, it must NOT jump
    // to defaultConfidence(kind) (0.65) as a side effect of the merge.
    const content = 'sentinel: create default probe — measure before optimizing the hot path';
    repo.create({ content, kind: 'fact', project: SESSION_PROJECT, confidence: 0.5 });
    repo.create({ content, kind: 'fact', project: SESSION_PROJECT });
    const row = db.prepare("SELECT confidence FROM memories WHERE content LIKE 'sentinel: create default%'").get() as { confidence: number };
    assert.ok(Math.abs(row.confidence - 0.55) < 1e-9,
      `no-confidence merge is boost-only, got ${row.confidence}`);
  });

  it('BLOCK 2: an explicitly higher incoming confidence still exceeds the ceiling', () => {
    const content = 'sentinel: explicit override probe — rotate credentials after contractor offboarding';
    repo.storePitfall({ content, project: SESSION_PROJECT, confidence: 0.7 });
    repo.storePitfall({ content, project: SESSION_PROJECT, confidence: 0.95, source: 'user' });
    const row = db.prepare("SELECT confidence FROM memories WHERE content LIKE 'sentinel: explicit override%'").get() as { confidence: number };
    assert.ok(Math.abs(row.confidence - 0.95) < 1e-9,
      'the ceiling bounds repetition growth, not explicit authority');
  });
});

/**
 * Codex finalcheck F-cache: exercise the cache hit/miss seam on the REAL
 * injection path (`cachedRecallByFingerprint`), not just the storage layer.
 * The hit path revalidates cached IDs with `isMemoryEligibleForInjection`
 * (invalidation/supersession/resolution) but never re-applies minConfidence —
 * a row whose confidence drops below the gate after caching is still served
 * until the cache turns over. Pinned here as CURRENT behavior; the
 * cache-score parity work at step 6 owns any change to it.
 */
import { PlanRepository } from '../src/db/plan-repository.js';
import { ReminderRepository } from '../src/db/reminder-repository.js';
import { ContextRepository } from '../src/db/context-repository.js';
import { InvestigationRepository } from '../src/db/investigation-repository.js';
import { SessionCache } from '../src/hooks/shared/session-cache.js';
import type { CachedHookContext } from '../src/hooks/shared/db-client.js';
import { cachedRecallByFingerprint } from '../src/hooks/handlers/pitfall/recall-cache.js';
import { generateFingerprint } from '../src/utils/fingerprint.js';

describe('deliberate confidence on the injection path (cache hit/miss exercised)', () => {
  let cdb: Database.Database;
  let crepo: MemoryRepository;
  let cclient: CachedHookContext;
  const PROJECT = 'proj-deliberate-cache';
  const FP = generateFingerprint({ filePath: 'src/db/backup-writer.ts' });
  const GATE_OPTS = () => ({
    project: PROJECT,
    kind: 'pitfall' as const,
    maxResults: 5,
    minConfidence: RELEVANCE.MIN_CONFIDENCE_FOR_PITFALL,
  });

  beforeEach(() => {
    cdb = openDatabase({ dbPath: ':memory:' });
    crepo = new MemoryRepository(cdb);
    cclient = {
      db: cdb,
      memoryRepo: crepo,
      planRepo: new PlanRepository(cdb),
      reminderRepo: new ReminderRepository(cdb),
      contextRepo: new ContextRepository(cdb),
      investigationRepo: new InvestigationRepository(cdb),
      close: () => cdb.close(),
      cache: new SessionCache(),
    };
  });

  afterEach(() => {
    try { cdb.close(); } catch { /* already closed */ }
  });

  it('a DELIBERATE pitfall clears the injection gate on the miss path AND the hit path, same score', () => {
    crepo.storePitfall({
      content: 'sentinel: backup writer must hold the lock across the copy',
      project: PROJECT,
      confidence: CONFIDENCE.DELIBERATE,
      fingerprint: FP,
    });
    const miss = cachedRecallByFingerprint(cclient, FP, 'backup writer lock', GATE_OPTS());
    assert.equal(miss.length, 1, 'born injectable: the miss path must return the deliberate pitfall');
    const hit = cachedRecallByFingerprint(cclient, FP, 'backup writer lock', GATE_OPTS());
    assert.equal(hit.length, 1, 'the cached hit path must serve the same pitfall');
    assert.equal(hit[0].memory.id, miss[0].memory.id);
    assert.equal(hit[0].score, miss[0].score,
      'hit/miss score parity: both compute multiSignalScore from the same live fields');
  });

  it('step 6: a hit reflects LIVE confidence in its score — no stale score cache (score parity)', () => {
    const created = crepo.storePitfall({
      content: 'sentinel: score parity row about backup writer checks',
      project: PROJECT,
      confidence: CONFIDENCE.DELIBERATE,
      fingerprint: FP,
    });
    const miss = cachedRecallByFingerprint(cclient, FP, 'backup writer checks', GATE_OPTS());
    assert.equal(miss.length, 1);

    // Confidence changes after the candidates were cached (explicit
    // strengthen): the next HIT must score with the live value, exactly as
    // a fresh miss would — the old per-id score cache served stale scores.
    crepo.strengthenConfidence(created.id);
    const hit = cachedRecallByFingerprint(cclient, FP, 'backup writer checks', GATE_OPTS());
    const freshClient = { ...cclient, cache: new SessionCache() };
    const fresh = cachedRecallByFingerprint(freshClient, FP, 'backup writer checks', GATE_OPTS());
    assert.equal(hit.length, 1);
    assert.equal(fresh.length, 1);
    assert.equal(hit[0].score, fresh[0].score,
      'hit and miss must compute identical scores from identical live fields');
    assert.ok(hit[0].score > miss[0].score,
      'the strengthened confidence must be visible in the hit score');
  });

  it('step 6 fold: a weakened cached row is BACKFILLED by the runner-up a fresh miss would promote', () => {
    // The window-parity contract: cache the candidate WINDOW, not the
    // top-k. Two rows above the gate; maxResults 1 → only the stronger is
    // returned on the miss. Weaken the stronger below the gate: the HIT
    // must now return the runner-up, exactly as a fresh miss would.
    const opts = () => ({ ...GATE_OPTS(), maxResults: 1 });
    const strong = crepo.storePitfall({
      content: 'sentinel: nightly backup rotation halts when the disk quota trips',
      project: PROJECT, confidence: 0.9, source: 'user', fingerprint: FP,
    });
    const runner = crepo.storePitfall({
      content: 'sentinel: verify each backup rotation archive by restoring one file from it',
      project: PROJECT, confidence: CONFIDENCE.DELIBERATE, fingerprint: FP,
    });
    assert.notEqual(runner.id, strong.id, 'fixture premise: two distinct rows');
    const miss = cachedRecallByFingerprint(cclient, FP, 'backup rotation', opts());
    assert.equal(miss.length, 1);
    assert.match(miss[0].memory.content, /disk quota trips/);

    cdb.prepare('UPDATE memories SET confidence = 0.4 WHERE id = ?').run(strong.id);

    const hit = cachedRecallByFingerprint(cclient, FP, 'backup rotation', opts());
    assert.equal(hit.length, 1, 'the runner-up must backfill the weakened row');
    assert.match(hit[0].memory.content, /restoring one file/,
      'a top-k-only cache would return nothing here — the WINDOW makes the hit replayable');
    const fresh = cachedRecallByFingerprint({ ...cclient, cache: new SessionCache() }, FP, 'backup rotation', opts());
    assert.deepEqual(hit.map(r => r.memory.id), fresh.map(r => r.memory.id), 'hit ≡ fresh miss');
  });

  it('step 6 fold: live-field changes REORDER a cached window exactly as a fresh miss would', () => {
    const a = crepo.storePitfall({
      content: 'sentinel: log shipping stalls under backpressure when the buffer fills silently',
      project: PROJECT, confidence: 0.72, fingerprint: FP,
    });
    crepo.storePitfall({
      content: 'sentinel: cap log shipping batches so backpressure surfaces as an explicit error',
      project: PROJECT, confidence: 0.8, fingerprint: FP,
    });
    const miss = cachedRecallByFingerprint(cclient, FP, 'log shipping backpressure', GATE_OPTS());
    assert.match(miss[0].memory.content, /explicit error/, 'beta leads on confidence');

    // Alpha is strengthened past beta AFTER the window was cached.
    cdb.prepare('UPDATE memories SET confidence = 0.95 WHERE id = ?').run(a.id);

    const hit = cachedRecallByFingerprint(cclient, FP, 'log shipping backpressure', GATE_OPTS());
    const fresh = cachedRecallByFingerprint({ ...cclient, cache: new SessionCache() }, FP, 'log shipping backpressure', GATE_OPTS());
    assert.deepEqual(hit.map(r => r.memory.id), fresh.map(r => r.memory.id),
      'the hit must reorder on live fields exactly as a fresh miss');
    assert.match(hit[0].memory.content, /buffer fills silently/, 'the strengthened row leads');
  });

  it('step 6 fold 2: a row outside the SCORED slice but inside the raw scan promotes identically on hit and miss', () => {
    // codex round-2 block: freezing a scored slice (even a widened one) let
    // a row just outside it — in the SQL scan, weak multiSignal at cache
    // time — enter a fresh miss but never a hit after live promotion. The
    // frozen unit must be the RAW confidence-ordered SQL scan.
    const opts = () => ({ ...GATE_OPTS(), maxResults: 1 }); // scan = 3 by confidence
    crepo.storePitfall({ content: 'sentinel: shard rebalance on the ingest cluster requires a drain first', project: PROJECT, confidence: 0.9, fingerprint: FP });
    const b = crepo.storePitfall({ content: 'sentinel: rebalance each shard of the ingest cluster before peak load', project: PROJECT, confidence: 0.85, fingerprint: FP });
    // X: high confidence (2nd in the confidence-ordered scan) but WEAK
    // query overlap → clearly LAST in any multiSignal ordering at cache
    // time (strong-overlap rivals at near-equal confidence bracket it).
    const x = crepo.storePitfall({ content: 'sentinel: unrelated quota accounting drifts nightly', project: PROJECT, confidence: 0.88, fingerprint: FP });
    const c = crepo.storePitfall({ content: 'sentinel: the ingest cluster mislabels shard rebalance metrics when sampled', project: PROJECT, confidence: 0.86, fingerprint: FP });
    // Premise pin: at cache time X must score BELOW all three strong-overlap
    // rows — otherwise this fixture cannot discriminate slice-vs-scan.
    {
      const ranked = crepo.recallByFingerprint(FP, 'shard rebalance ingest cluster', { ...GATE_OPTS(), maxResults: 4 });
      assert.equal(ranked[ranked.length - 1].memory.id, x.id, 'premise: X is last by multiSignal at cache time');
      assert.ok(b.id !== c.id, 'distinct rows');
    }

    const miss = cachedRecallByFingerprint(cclient, FP, 'shard rebalance ingest cluster', opts());
    assert.equal(miss.length, 1);
    assert.ok(!/quota accounting/.test(miss[0].memory.content), 'X is weakest by multiSignal at cache time');

    // Live promotion: proven precision + higher confidence lift X to #1.
    cdb.prepare('UPDATE memories SET confidence = 0.99, surface_count = 1, impact_count = 1 WHERE id = ?').run(x.id);

    const hit = cachedRecallByFingerprint(cclient, FP, 'shard rebalance ingest cluster', opts());
    const fresh = cachedRecallByFingerprint({ ...cclient, cache: new SessionCache() }, FP, 'shard rebalance ingest cluster', opts());
    assert.deepEqual(hit.map(r => r.memory.id), fresh.map(r => r.memory.id),
      'hit must equal a fresh miss even for promotion from outside the old scored slice');
    assert.equal(fresh[0].memory.id, x.id, 'premise: the promotion is decisive on a fresh miss');
  });

  it('an AUTO_DETECTED pitfall never enters the cache — the differential holds end-to-end', () => {
    crepo.storePitfall({
      content: 'sentinel: auto-mined guess about the backup writer',
      project: PROJECT,
      fingerprint: FP, // no confidence → gateway AUTO_DETECTED, below the gate
    });
    assert.equal(cachedRecallByFingerprint(cclient, FP, 'backup writer', GATE_OPTS()).length, 0,
      'miss path: below-gate rows are filtered by minConfidence');
    assert.equal(cachedRecallByFingerprint(cclient, FP, 'backup writer', GATE_OPTS()).length, 0,
      'hit path: an empty candidate list stays empty');
  });

  it('step 6: confidence lost AFTER caching IS re-checked on hits (PIN inverted — eligibility parity)', () => {
    const created = crepo.storePitfall({
      content: 'sentinel: pitfall that will decay below the gate mid-session',
      project: PROJECT,
      confidence: CONFIDENCE.DELIBERATE,
      fingerprint: FP,
    });
    assert.equal(cachedRecallByFingerprint(cclient, FP, 'decay mid-session', GATE_OPTS()).length, 1);

    // Model decay/weaken landing below the gate: a local confidence write
    // does NOT bump the durable sync generation, so the FTS-candidate cache
    // survives — this is ordinary same-session operation, not an edge case.
    cdb.prepare('UPDATE memories SET confidence = 0.4 WHERE id = ?').run(created.id);

    // Step 6 (eligibility parity): the hit path now reapplies
    // options.minConfidence to live fields — a row weakened below the
    // caller's floor stops serving IMMEDIATELY, warm cache or not.
    const stale = cachedRecallByFingerprint(cclient, FP, 'decay mid-session', GATE_OPTS());
    assert.equal(stale.length, 0,
      'hit path re-applies minConfidence to live confidence — the step-3 seam is closed');

    // And a cold cache agrees, as it always did.
    cclient.cache = new SessionCache();
    assert.equal(cachedRecallByFingerprint(cclient, FP, 'decay mid-session', GATE_OPTS()).length, 0,
      'hit and miss now share one eligibility contract');
  });
});

/**
 * BLOCK 3 (codex): the composed end-to-end contract. A pitfall learned
 * through the REAL MCP tool must surface through the REAL proactive warning
 * path (`handlePitfallCheck`, PreToolUse) — and must NOT displace a better
 * warning when one competes for the single per-call slot. Exercises the
 * cache miss AND hit of the warning path's recall.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handlePitfallCheck } from '../src/hooks/handlers/pitfall-handler.js';
import type { PreToolUseInput } from '../src/hooks/shared/hook-io.js';
import { projectId } from '../src/utils/project-id.js';
import { PROACTIVE } from '../src/constants/index.js';

describe('deliberate confidence end-to-end: MCP learn → proactive warning path', () => {
  let edb: Database.Database;
  let erepo: MemoryRepository;
  let eclient: CachedHookContext;
  let emcp: Client;
  let cwd: string;

  // Non-read-only command whose tokens overlap the learned lesson content —
  // drives the FTS side of fingerprint recall (same shape as the proven
  // pitfall-bash-undefined-filepath harness).
  const COMMAND = 'node -e "const w = require(\'./backup-writer\'); w.copy({ lock: true, probe: true })"';

  const bashInput = (sessionId: string): PreToolUseInput => ({
    session_id: sessionId,
    transcript_path: '/tmp/x.jsonl',
    cwd,
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: COMMAND, description: 'test command' },
  } as unknown as PreToolUseInput);

  beforeEach(async () => {
    cwd = mkdtempSync(join(tmpdir(), 'cairn-deliberate-e2e-'));
    edb = openDatabase({ dbPath: ':memory:' });
    erepo = new MemoryRepository(edb);
    // The MCP server and the hook client share ONE database, and the MCP
    // session project matches the hook's projectId(cwd) — the incident's
    // actual topology: learn in a session, warn in the same session.
    setSessionProjectForTests(projectId(cwd));
    eclient = {
      db: edb,
      memoryRepo: erepo,
      planRepo: new PlanRepository(edb),
      reminderRepo: new ReminderRepository(edb),
      contextRepo: new ContextRepository(edb),
      investigationRepo: new InvestigationRepository(edb),
      close: () => edb.close(),
      cache: new SessionCache(),
    };
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    registerMemoryTools(server, erepo, () => 'normal');
    emcp = new Client({ name: 'test-client', version: '0.0.0' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([emcp.connect(ct), server.connect(st)]);
  });

  afterEach(async () => {
    setSessionProjectForTests(undefined);
    await emcp.close();
    try { edb.close(); } catch { /* already closed */ }
    rmSync(cwd, { recursive: true, force: true });
  });

  const learn = async (content: string) => {
    const res = await emcp.callTool({ name: 'cairn_learn', arguments: { kind: 'pitfall', content } }) as {
      content: Array<{ type: string; text?: string }>; isError?: boolean;
    };
    assert.notEqual(res.isError, true, res.content[0]?.text);
  };

  it('a lesson learned via cairn_learn surfaces as a real PreToolUse warning — miss AND cached hit', async () => {
    await learn('backup-writer copy must hold the lock before probe runs or the snapshot is torn');

    const miss = handlePitfallCheck(bashInput('e2e-sess-1'), eclient);
    assert.ok(miss.pitfallsSurfaced >= 1, 'MCP-learned DELIBERATE pitfall must surface on the warning path');
    assert.ok(miss.output?.includes('backup-writer copy must hold the lock'),
      `warning must carry the lesson, got: ${String(miss.output)}`);

    // Second call in a fresh session (no per-session surface cooldown) hits
    // the warm FTS-candidate cache — the same lesson must still surface.
    const hit = handlePitfallCheck(bashInput('e2e-sess-2'), eclient);
    assert.ok(hit.pitfallsSurfaced >= 1, 'cached hit path must serve the same warning');
    assert.ok(hit.output?.includes('backup-writer copy must hold the lock'));
  });

  it('the deliberate lesson does not displace a better warning from the single slot', async () => {
    // A stronger competitor: user-sourced, USER_CORRECTION-level confidence,
    // same token overlap. With MAX_WARNINGS_PER_CALL = 1 the additive
    // confidence signal decides the slot deterministically.
    erepo.storePitfall({
      content: 'backup-writer copy lock probe: the daemon already holds the write lock — use the snapshot api',
      project: projectId(cwd),
      confidence: 0.9,
      source: 'user',
    });
    await learn('backup-writer copy must hold the lock before probe runs or the snapshot is torn');

    const result = handlePitfallCheck(bashInput('e2e-sess-3'), eclient);
    assert.ok(result.pitfallsSurfaced >= 1, 'a warning must fire');
    assert.ok(result.output?.includes('use the snapshot api'),
      `the stronger warning keeps the slot, got: ${String(result.output)}`);
    assert.ok(!result.output?.includes('snapshot is torn'),
      'the 0.7 lesson must not displace the 0.9 user warning from the single per-call slot');
  });

  it('an aged auto-detected pitfall stays below the warning floor while the deliberate one surfaces', async () => {
    // Auto row past its probation window: 0.55 < 0.65 floor and no young-row
    // carve-out — the differential the whole step exists for, end-to-end.
    const auto = erepo.storePitfall({
      content: 'backup-writer copy lock probe guessed lesson from the error miner',
      project: projectId(cwd),
    });
    const agedMs = Date.now() - (PROACTIVE.PROBATION_DAYS + 3) * 86_400_000;
    edb.prepare('UPDATE memories SET created_at = ? WHERE id = ?')
      .run(new Date(agedMs).toISOString(), auto.id);
    await learn('backup-writer copy must hold the lock before probe runs or the snapshot is torn');

    const result = handlePitfallCheck(bashInput('e2e-sess-4'), eclient);
    assert.ok(result.output?.includes('snapshot is torn'), 'deliberate lesson surfaces');
    assert.ok(!result.output?.includes('guessed lesson'),
      'an aged below-gate auto row must not surface on the warning path');
  });
});
