/**
 * Truth maintenance — contradiction detection, supersession, and claim decay.
 * Synthetic fixtures only (no real DB data). Tests BOTH sides: true conflicts
 * are caught/suppressed AND adjacent-compatible memories both survive.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type Database from 'better-sqlite3';
import { openDatabase } from '../src/db/connection.js';
import { MemoryRepository } from '../src/db/memory-repository.js';
import {
  classifyClaim,
  classifyClaimStaleness,
  detectConflict,
  subjectTokens,
  valuesDiverge,
} from '../src/db/memory-repository/truth.js';
import { enrichWithGraphNeighbors } from '../src/db/memory-repository/graph.js';
import * as reads from '../src/db/memory-repository/reads.js';
import type { Memory } from '../src/db/memory-repository.js';

const PROJECT = 'truth-test';
const DAY_MS = 86_400_000;

function isSuperseded(db: Database.Database, id: string): boolean {
  const row = db.prepare('SELECT superseded_by FROM memories WHERE id = ?').get(id) as { superseded_by: string | null } | undefined;
  return !!row?.superseded_by;
}

function synthMemory(over: Partial<Memory> = {}): Memory {
  return {
    id: over.id ?? 'x', content: over.content ?? '', kind: over.kind ?? 'fact',
    project: over.project ?? null, tags: [], confidence: over.confidence ?? 0.6,
    source: over.source ?? 'learned', created_at: over.created_at ?? new Date().toISOString(),
    last_recalled: null, recall_count: 0, invalidated: 0, surface_count: 0, impact_count: 0, revision: 1,
    fingerprint: null, context: null, anchor: null,
  };
}

describe('claim classification', () => {
  it('classifies version, metric, date, volatile claims and ignores durable ones', () => {
    assert.equal(classifyClaim('app uses Postgres 15.2 in production'), 'version');
    assert.equal(classifyClaim('the suite has 1487 passing tests'), 'metric');
    assert.equal(classifyClaim('migration completed on 2026-04-10'), 'date');
    assert.equal(classifyClaim('we are currently on the feature branch'), 'volatile');
    assert.equal(classifyClaim('the auth logic lives in the hooks module'), null);
  });

  it('subjectTokens strips numeric/version values and stopwords', () => {
    const toks = subjectTokens('app uses Postgres 15.2');
    assert.ok(toks.has('postgres'));
    assert.ok(!toks.has('15.2'));
    assert.ok(!toks.has('the'));
  });
});

describe('claim staleness (read-time, non-destructive)', () => {
  it('flags an aged version claim past its half-life and leaves fresh ones alone', () => {
    const old = synthMemory({ content: 'runtime is Node 18.1', created_at: new Date(Date.now() - 150 * DAY_MS).toISOString() }); // version, 90d half-life
    const fresh = synthMemory({ content: 'runtime is Node 18.1' });
    assert.equal(classifyClaimStaleness(old)?.stale, true);
    assert.equal(classifyClaimStaleness(fresh)?.stale, false);
  });

  it('is claim-type aware — same age, different verdict by half-life', () => {
    const at = new Date(Date.now() - 100 * DAY_MS).toISOString();
    const version = synthMemory({ content: 'runtime is Node 18.1', created_at: at }); // 90d half-life → stale at 100d
    const metric = synthMemory({ content: 'the suite has 1487 tests', created_at: at }); // 120d half-life → fresh at 100d
    assert.equal(classifyClaimStaleness(version)?.stale, true);
    assert.equal(classifyClaimStaleness(metric)?.stale, false);
  });

  it('never decays finalized/historical records (completion cue veto)', () => {
    // A completed event-log's numbers are frozen — flagging "verify" is noise.
    const done = synthMemory({ content: 'KJO migration COMPLETED 2026-05-21, final scope 580 partners', created_at: new Date(Date.now() - 300 * DAY_MS).toISOString() });
    assert.equal(classifyClaimStaleness(done), null);
  });

  it('never decays durable claims or non-claim kinds', () => {
    const durable = synthMemory({ content: 'the auth module owns token refresh', created_at: new Date(Date.now() - 999 * DAY_MS).toISOString() });
    const pitfall = synthMemory({ kind: 'pitfall', content: 'app uses Postgres 15', created_at: new Date(Date.now() - 999 * DAY_MS).toISOString() });
    assert.equal(classifyClaimStaleness(durable), null);
    assert.equal(classifyClaimStaleness(pitfall), null);
  });
});

describe('detectConflict — structural gates', () => {
  const a = (content: string, over: Partial<Memory> = {}) => synthMemory({ id: 'a', content, ...over });
  const b = (content: string, over: Partial<Memory> = {}) => synthMemory({ id: 'b', content, ...over });

  it('flags semver version drift as supersession (newer, equal authority wins)', () => {
    const c = detectConflict(a('app runtime is node 18.1'), b('app runtime is node 20.3'));
    assert.equal(c?.type, 'supersession');
    assert.equal(c?.loserId, 'a');
  });

  it('flags bare-number metric drift as contradiction, never supersession (identifier ambiguity)', () => {
    // A 2-digit number may be a magnitude OR a distinct entity (error code, port,
    // key size). Since supersession HIDES a memory, metric drift only flags both.
    for (const [x, y] of [['error code 42 means timeout', 'error code 99 means refused'],
                          ['staging runs on port 8080', 'staging runs on port 9090'],
                          ['the rsa key is 2048 bit', 'the rsa key is 4096 bit']]) {
      const c = detectConflict(a(x), b(y));
      assert.equal(c?.type, 'contradiction', `${x} vs ${y} must flag, not supersede`);
    }
  });

  it('flags negation parity as standing contradiction', () => {
    const c = detectConflict(a('always enable retries on the client'), b('never enable retries on the client'));
    assert.equal(c?.type, 'contradiction');
  });

  it('flags antonym flip as standing contradiction', () => {
    const c = detectConflict(a('enable the cache layer'), b('disable the cache layer'));
    assert.equal(c?.type, 'contradiction');
  });

  it('does NOT flag adjacent memories with different scope (the bcrypt trap)', () => {
    // Same subject + negation, but different prepositional scope → coexist.
    const c = detectConflict(a('use bcrypt for passwords'), b('avoid bcrypt for tokens'));
    assert.equal(c, null);
  });

  it('does NOT flag topically-unrelated memories', () => {
    const c = detectConflict(a('the parser reads jsonl transcripts'), b('never disable the retry backoff'));
    assert.equal(c, null);
  });

  it('does NOT flag list-addition as contradiction', () => {
    const c = detectConflict(a('provider supports stripe and paypal'), b('provider supports stripe and adyen'));
    assert.equal(c, null, `list addition must not be flagged, got ${c?.type}`);
  });

  it('lower-authority version drift flags for review instead of superseding', () => {
    const c = detectConflict(a('app runtime is node 18.1', { source: 'user' }), b('app runtime is node 20.3', { source: 'learned' }));
    assert.equal(c?.type, 'contradiction');
  });

  it('valuesDiverge distinguishes supersession pairs from true duplicates', () => {
    assert.equal(valuesDiverge('app uses Postgres 15', 'app uses Postgres 16'), true);
    assert.equal(valuesDiverge('app uses Postgres 15', 'app runs on Postgres 15'), false);
  });

  it('does NOT flag the same value in different units as a drift (unit veto)', () => {
    // "30 seconds" and "30000 milliseconds" are the same value — different unit,
    // not a supersession. (Calibration fix from real-data adversarial probes.)
    const c = detectConflict(a('the request timeout is 30 seconds'), b('the request timeout is 30000 milliseconds'));
    assert.equal(c, null);
  });

  it('flags metric drift on verbose content sharing a context word (contradiction)', () => {
    // Detection reaches the value via the shared context word ("tests"); the
    // disposition is a non-destructive flag, not a supersession.
    const c = detectConflict(a('the test suite currently has 775 tests passing'), b('the test suite now has 1487 tests passing'));
    assert.equal(c?.type, 'contradiction');
  });

  it('does NOT flag divergent numbers with no shared context (different subjects)', () => {
    const c = detectConflict(a('the retry limit is 30'), b('the cache holds 5000 entries'));
    assert.equal(c, null);
  });
});

describe('write-time application (end to end)', () => {
  let db: Database.Database;
  let repo: MemoryRepository;
  beforeEach(() => { db = openDatabase({ dbPath: ':memory:' }); repo = new MemoryRepository(db); });
  afterEach(() => db.close());

  it('supersedes the older claim on semver version drift and excludes it from recall', () => {
    const oldRes = repo.create({ content: 'the app runtime is node 18.1', kind: 'fact', project: PROJECT });
    const newRes = repo.create({ content: 'the app runtime is node 20.3', kind: 'fact', project: PROJECT });

    assert.equal(newRes.supersededId, oldRes.id, 'new write reports it superseded the old (observability)');
    assert.ok(isSuperseded(db, oldRes.id), 'old memory is retired');
    assert.ok(!isSuperseded(db, newRes.id), 'new memory is active');

    const hits = repo.search('app runtime node', { project: PROJECT, maxResults: 10 });
    assert.ok(hits.some(h => h.memory.id === newRes.id), 'new surfaces');
    assert.ok(!hits.some(h => h.memory.id === oldRes.id), 'retired old is excluded from recall');
  });

  it('records a contradicts edge for standing conflicts, both sides survive', () => {
    repo.create({ content: 'always enable request retries in the client', kind: 'decision', project: PROJECT });
    const second = repo.create({ content: 'never enable request retries in the client', kind: 'decision', project: PROJECT });

    assert.ok(second.contradictionWith, 'second write reports the conflict (observability)');
    const pairs = repo.getContradictions(PROJECT);
    assert.equal(pairs.length, 1, 'one unresolved contradiction pair');
    // Neither side is retired — both keep surfacing until the user resolves.
    const active = repo.search('enable request retries client', { project: PROJECT, maxResults: 10 });
    assert.equal(active.length, 2, 'both conflicting decisions still surface');
  });

  it('does NOT supersede a higher-authority claim on a lower-authority observation', () => {
    const userFact = repo.create({ content: 'the runtime is node 18.1', kind: 'fact', project: PROJECT, source: 'user' });
    const learned = repo.create({ content: 'the runtime is node 20.3', kind: 'fact', project: PROJECT, source: 'learned' });

    assert.ok(!isSuperseded(db, userFact.id), 'user fact is never silently retired by a learned observation');
    assert.ok(learned.contradictionWith, 'flagged for the user to resolve instead');
  });

  it('adjacent-but-compatible memories both survive with no conflict', () => {
    const p = repo.create({ content: 'use bcrypt for password hashing', kind: 'decision', project: PROJECT });
    const t = repo.create({ content: 'avoid bcrypt for session tokens', kind: 'decision', project: PROJECT });
    assert.equal(t.supersededId ?? null, null);
    assert.equal(t.contradictionWith ?? null, null);
    assert.ok(!isSuperseded(db, p.id) && !isSuperseded(db, t.id));
    assert.equal(repo.getContradictions(PROJECT).length, 0);
  });

  it('graph-neighbor enrichment does not resurface a superseded memory', () => {
    const oldRes = repo.create({ content: 'the app runtime is node 18.1', kind: 'fact', project: PROJECT });
    const newRes = repo.create({ content: 'the app runtime is node 20.3', kind: 'fact', project: PROJECT });
    // Link new→old via refines so neighbor expansion could pull the retired one.
    db.prepare("INSERT OR IGNORE INTO memory_edges (source_id, target_id, relation, weight, created_at) VALUES (?, ?, 'refines', 1.0, datetime('now'))")
      .run(newRes.id, oldRes.id);
    const seed = [{ memory: reads.findById(db, newRes.id)!, score: 1 }];
    const enriched = enrichWithGraphNeighbors(db, seed, 5);
    assert.ok(!enriched.some(r => r.memory.id === oldRes.id), 'retired memory not resurfaced via graph neighbor');
  });

  it('graph-neighbor enrichment does not expand across a contradicts edge', () => {
    repo.create({ content: 'always enable request retries in the client', kind: 'decision', project: PROJECT });
    const second = repo.create({ content: 'never enable request retries in the client', kind: 'decision', project: PROJECT });
    // A contradicts edge now links the pair; enriching from one must not pull the other.
    const seed = [{ memory: reads.findById(db, second.id)!, score: 1 }];
    const enriched = enrichWithGraphNeighbors(db, seed, 5);
    assert.equal(enriched.length, 1, 'contradicts edge is not a neighbor-expansion path');
  });
});
