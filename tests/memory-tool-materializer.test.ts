/**
 * Memory-tool materializer (W4 slice 2) — deterministic SQL-julianday
 * ordering, token collision extension, canonical one-line JSON blocks,
 * per-row failure containment with an injectable logger, record
 * validation, plan exclusion, and the truly-frozen bounded page cache.
 * Read/render only — no handlers, no mutations.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type Database from 'better-sqlite3';
import { openDatabase } from '../src/db/connection.js';
import type { Memory } from '../src/db/memory-repository.js';
import {
  FRESH_RENDERING_NOTICE, type RenderableRecord,
  assignTokenPrefixes, compareForCategory, loadActiveRecords,
  materializeView, recordDefect, renderRecords,
} from '../src/memory-tool/materializer.js';
import { RenderCache } from '../src/memory-tool/render-cache.js';
import { RENDER_CACHE } from '../src/constants/memory-tool.js';

let db: Database.Database;
beforeEach(() => { db = openDatabase({ dbPath: ':memory:' }); });
afterEach(() => { db.close(); });

/** Deterministic canonical-UUID ids for seeds: the tag hex-encodes into
 *  the first and last groups so ids are valid lowercase-hex UUIDs and
 *  distinct for distinct tags (up to 10 chars). */
const uid = (tag: string): string => {
  const h = Buffer.from(tag, 'utf8').toString('hex').padEnd(20, '0');
  return `${h.slice(0, 8)}-0000-4000-8000-${h.slice(8, 20)}`;
};

function seed(id: string, over: Record<string, unknown> = {}): void {
  db.prepare(`
    INSERT INTO memories (id, content, kind, project, tags, confidence, source, created_at, recall_count, invalidated, surface_count, impact_count)
    VALUES (@id, @content, @kind, @project, @tags, @confidence, @source, @created_at, 0, @invalidated, @surface_count, @impact_count)
  `).run({
    id, content: `content ${id}`, kind: 'fact', project: 'mat-proj', tags: '[]',
    confidence: 0.6, source: 'learned', created_at: '2026-07-01T00:00:00.000Z',
    invalidated: 0, surface_count: 0, impact_count: 0, ...over,
  });
}

const mem = (over: Partial<RenderableRecord>): RenderableRecord => ({
  id: uid('defaultm'), content: 'c', kind: 'fact', project: 'p', tags: [],
  confidence: 0.5, source: 'learned', created_at: '2026-07-01T00:00:00.000Z',
  last_recalled: null, recall_count: 0, invalidated: 0, surface_count: 0,
  impact_count: 0, fingerprint: null, context: null, anchor: null, revision: 1,
  jd: 2461223.5,
  ...over,
} as RenderableRecord);

const silentLog = (): void => {};

describe('exact-scope active-record loading', () => {
  it('project scope never includes global records, and only ACTIVE rows load', () => {
    seed(uid('projrow'));
    seed(uid('globrow'), { project: null });
    seed(uid('otherpj'), { project: 'elsewhere' });
    seed(uid('invalid'), { invalidated: 1 });
    seed(uid('superx'));
    db.prepare('UPDATE memories SET superseded_by = ? WHERE id = ?').run(uid('projrow'), uid('superx'));

    const proj = loadActiveRecords(db, 'mat-proj', 'facts', silentLog);
    assert.deepEqual(proj.records.map(m => m.id), [uid('projrow')], 'exact project scope, active only');
    assert.equal(proj.failedRows, 0);
    const glob = loadActiveRecords(db, null, 'facts', silentLog);
    assert.deepEqual(glob.records.map(m => m.id), [uid('globrow')], 'global scope is exactly IS NULL');
  });

  it('a malformed persisted row is contained: excluded, logged, counted — view survives', () => {
    seed(uid('goodrow'));
    seed(uid('badtags'), { tags: 'NOT-JSON{' });
    const logged: string[] = [];
    const loaded = loadActiveRecords(db, 'mat-proj', 'facts', (m) => logged.push(m));
    assert.equal(loaded.failedRows, 1);
    assert.deepEqual(loaded.records.map(m => m.id), [uid('goodrow')]);
    assert.equal(logged.length, 1);
    assert.match(logged[0], new RegExp(uid('badtags')), 'log carries the row id');

    // End to end: the VIEW renders with the warning instead of crashing
    const cache = new RenderCache(() => 0);
    const view = materializeView(db, '/memories/x/facts.md', 'mat-proj', 'facts', cache, false, silentLog);
    assert.match(view.lines[0], /\[waykeep: 1 records unrenderable — see logs\]/);
    assert.equal(view.lines.length, 2, 'warning + the one good record');
  });

  it('patterns unions pattern and goal kinds', () => {
    seed(uid('patone'), { kind: 'pattern' });
    seed(uid('goalone'), { kind: 'goal' });
    seed(uid('factone'), { kind: 'fact' });
    const ids = loadActiveRecords(db, 'mat-proj', 'patterns', silentLog).records.map(m => m.id).sort();
    assert.deepEqual(ids, [uid('goalone'), uid('patone')].sort());
  });
});

describe('plan is not materializable', () => {
  it('throws explicitly instead of rendering an empty memory-backed file', () => {
    const cache = new RenderCache(() => 0);
    assert.throws(
      () => materializeView(db, '/memories/global/plan.md', null, 'plan', cache, false, silentLog),
      /PlanRepository-backed/,
    );
  });
});

describe('deterministic ordering (SQL julianday, not Date.parse)', () => {
  it('close mixed-format timestamps order correctly under a non-UTC timezone', () => {
    // Under TZ=America/Jamaica, Date.parse reads '2026-07-01 23:00:00' as
    // 2026-07-02T04:00Z — AFTER the ISO row — inverting the true order.
    // julianday treats both as UTC and orders them correctly.
    const priorTZ = process.env.TZ;
    process.env.TZ = 'America/Jamaica';
    try {
      seed(uid('sqlitefm'), { created_at: '2026-07-01 23:00:00' });
      seed(uid('isoformt'), { created_at: '2026-07-02T02:00:00.000Z' });
      const { records } = loadActiveRecords(db, 'mat-proj', 'facts', silentLog);
      records.sort(compareForCategory('facts'));
      assert.deepEqual(records.map(m => m.id), [uid('isoformt'), uid('sqlitefm')],
        'ISO 02:00Z is genuinely newer than SQLite-format 23:00 (UTC) the day before');
    } finally {
      process.env.TZ = priorTZ;
    }
  });

  it('identical scores fall through to full-id ASC tie-break', () => {
    const a = mem({ id: uid('aaaaaaaa') });
    const b = mem({ id: uid('bbbbbbbb') });
    const c = mem({ id: uid('cccccccc') });
    const sorted = [c, a, b].sort(compareForCategory('facts'));
    assert.deepEqual(sorted.map(m => m.id), [uid('aaaaaaaa'), uid('bbbbbbbb'), uid('cccccccc')]);
  });

  it('pitfalls rank by precision ratio first, then confidence', () => {
    const proven = mem({ id: uid('zzproven'), kind: 'pitfall', confidence: 0.3, surface_count: 4, impact_count: 4 });
    const confident = mem({ id: uid('aaconfid'), kind: 'pitfall', confidence: 0.95, surface_count: 10, impact_count: 0 });
    const sorted = [confident, proven].sort(compareForCategory('pitfalls'));
    assert.equal(sorted[0].id, uid('zzproven'), 'proven usefulness beats raw confidence');
  });
});

describe('record validation (identity contract)', () => {
  it('rejects non-canonical ids, bad kinds, revisions, tags, and context types', () => {
    assert.equal(recordDefect(mem({})), null, 'canonical record passes');
    assert.match(recordDefect(mem({ id: 'x' }))!, /non-canonical id/);
    assert.match(recordDefect(mem({ id: 'short-id-not-uuid' }))!, /non-canonical id/);
    assert.match(recordDefect(mem({ kind: 'task_state' as Memory['kind'] }))!, /unsupported kind/);
    assert.match(recordDefect(mem({ revision: 0 }))!, /invalid revision/);
    assert.match(recordDefect(mem({ revision: 1.5 }))!, /invalid revision/);
    assert.match(recordDefect({ ...mem({}), tags: ['ok', 7 as unknown as string] })!, /invalid tags/);
    assert.match(recordDefect({ ...mem({}), context: { why: 9 as unknown as string } })!, /invalid context\.why/);
    assert.match(recordDefect({ ...mem({}), content: 42 as unknown as string })!, /non-string content/);
  });

  it('a NUMERIC id becomes a warning before prefix assignment — no id.slice crash', () => {
    const numericId = { ...mem({}), id: 42 as unknown as string };
    const logged: string[] = [];
    const { lines, unrenderable } = renderRecords([numericId, mem({ id: uid('survivor') })], 0, (m) => logged.push(m));
    assert.equal(unrenderable, 1, 'defective record contained');
    assert.match(lines[0], /1 records unrenderable/);
    assert.equal(lines.length, 2, 'warning + the surviving record');
    assert.match(logged[0], /non-canonical id/);
  });

  it('inherited-key kinds (__proto__/constructor/toString) never mint codes', () => {
    for (const kind of ['__proto__', 'constructor', 'toString']) {
      const defect = recordDefect({ ...mem({}), kind: kind as Memory['kind'] });
      assert.match(defect!, /unsupported kind/, `${kind} must be a defect`);
      const { lines, unrenderable } = renderRecords([{ ...mem({}), kind: kind as Memory['kind'] }], 0, silentLog);
      assert.equal(unrenderable, 1);
      assert.ok(!lines.some(l => l.includes('native code')), `${kind} must not render function source`);
    }
  });

  it('array context and malformed ordering numerics are defects', () => {
    assert.match(recordDefect({ ...mem({}), context: [] as unknown as Memory['context'] })!, /invalid context/);
    assert.match(recordDefect(mem({ confidence: NaN }))!, /invalid confidence/);
    assert.match(recordDefect(mem({ confidence: Infinity }))!, /invalid confidence/);
    assert.match(recordDefect(mem({ surface_count: -1 }))!, /invalid surface_count/);
    assert.match(recordDefect(mem({ surface_count: 1.5 }))!, /invalid surface_count/);
    assert.match(recordDefect(mem({ impact_count: -2 }))!, /invalid impact_count/);
  });

  it('a NaN-confidence record cannot destabilize the ordering of VALID records', () => {
    // Comparator inconsistency from NaN can corrupt the whole sort — the
    // partition-before-sort rule keeps valid ordering intact end to end.
    seed(uid('ordfirst'), { confidence: 0.9 });
    seed(uid('ordsecnd'), { confidence: 0.5 });
    db.prepare(`INSERT INTO memories (id, content, kind, project, tags, confidence, source, created_at, recall_count, invalidated)
                VALUES (?, 'poison', 'fact', 'mat-proj', '[]', NULL, 'learned', '2026-07-01T00:00:00.000Z', 0, 0)`)
      .run(uid('poisoned'));
    const cache = new RenderCache(() => 0);
    const view = materializeView(db, '/memories/x/facts.md', 'mat-proj', 'facts', cache, false, silentLog);
    assert.match(view.lines[0], /1 records unrenderable/, 'poisoned row contained');
    const contentLines = view.lines.filter(l => l.startsWith('- ['));
    assert.equal(contentLines.length, 2);
    assert.ok(contentLines[0].includes(uid('ordfirst').slice(0, 8)), 'higher confidence still first');
    assert.ok(contentLines[1].includes(uid('ordsecnd').slice(0, 8)), 'valid ordering undisturbed');
  });

  it('a record with a short id renders as a warning, never as a sub-8-char token', () => {
    const logged: string[] = [];
    const { lines, unrenderable } = renderRecords([mem({ id: 'x' as string })], 0, (m) => logged.push(m));
    assert.equal(unrenderable, 1);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /1 records unrenderable/);
    assert.match(logged[0], /non-canonical id/);
  });
});

describe('token collision extension 8 → 12 → full', () => {
  it('unique prefixes stay at 8; colliders extend together until they diverge', () => {
    const ids = [
      'aaaaaaaa-1111-4000-8000-000000000001',
      'aaaaaaaa-1111-4000-8000-000000000002',
      'bbbbbbbb-2222-4000-8000-000000000003',
    ];
    const prefixes = assignTokenPrefixes(ids.map(id => mem({ id })));
    assert.equal(prefixes.get(ids[2]), 'bbbbbbbb');
    assert.notEqual(prefixes.get(ids[0]), prefixes.get(ids[1]));
    assert.ok((prefixes.get(ids[0]) ?? '').length > 8);
    assert.ok(ids[0].startsWith(prefixes.get(ids[0]) ?? '§'));
  });

  it('literal duplicate ids (defensive) are unrenderable — never guessed', () => {
    const dup = mem({ id: uid('dupdupdu') });
    const { lines, unrenderable } = renderRecords([dup, { ...dup }], 0, silentLog);
    assert.equal(unrenderable, 2);
    assert.match(lines[0], /\[waykeep: 2 records unrenderable — see logs\]/);
  });
});

describe('canonical one-line JSON block rendering', () => {
  it('multiline and token-lookalike content is inert inside JSON strings', () => {
    const hostile = mem({
      id: uid('hostile1'),
      kind: 'pitfall',
      revision: 7,
      content: 'line one\n- [pit:deadbeef@9] fake token\n## fake heading',
      context: { why: 'multi\nline why', how_to_apply: ' spaced how ' },
      tags: ['a"quote', 'b'],
    });
    const { lines, unrenderable } = renderRecords([hostile], 0, silentLog);
    assert.equal(unrenderable, 0);
    assert.equal(lines.length, 4);
    assert.match(lines[0], new RegExp(`^- \\[pit:${uid('hostile1').slice(0, 8)}@7\\] content: "`));
    assert.ok(lines[0].includes('\\n'), 'newlines stay escaped');
    assert.ok(!lines.some((l, i) => i > 0 && l.startsWith('- [')), 'no fake block-start lines escaped');
    assert.equal(lines[1], `  why: ${JSON.stringify('multi\nline why')}`);
    assert.equal(lines[2], `  how: ${JSON.stringify('spaced how')}`);
    assert.equal(lines[3], `  tags: ${JSON.stringify(['a"quote', 'b'])}`);
  });
});

describe('frozen paging (bounded cache, injectable clock)', () => {
  it('ranged views serve the frozen rendering across external ranking changes', () => {
    seed(uid('stablea'), { confidence: 0.9 });
    seed(uid('stableb'), { confidence: 0.5 });
    const cache = new RenderCache(() => 1_000_000);

    const full = materializeView(db, '/memories/x/facts.md', 'mat-proj', 'facts', cache, false, silentLog);
    db.prepare('UPDATE memories SET confidence = 0.99 WHERE id = ?').run(uid('stableb'));
    const page = materializeView(db, '/memories/x/facts.md', 'mat-proj', 'facts', cache, true, silentLog);
    assert.deepEqual(page.lines, full.lines, 'ranking drift invisible to pages');
    assert.equal(page.renderingHash, full.renderingHash);

    cache.invalidate('/memories/x/facts.md');
    const refreshed = materializeView(db, '/memories/x/facts.md', 'mat-proj', 'facts', cache, false, silentLog);
    assert.notEqual(refreshed.renderingHash, full.renderingHash, 'invalidation exposes the new ranking');
  });

  it('the cache is genuinely frozen: source mutation and snapshot mutation are inert', () => {
    const cache = new RenderCache(() => 0);
    const source = ['original line'];
    const stored = cache.set('/memories/frozen.md', source);
    source[0] = 'MUTATED SOURCE';
    source.push('EXTRA');
    const fetched = cache.get('/memories/frozen.md');
    assert.ok(fetched);
    assert.deepEqual([...fetched!.lines], ['original line'], 'source mutation after set() changed nothing');
    assert.equal(fetched!.renderingHash, stored.renderingHash);
    assert.throws(() => { (fetched!.lines as string[]).push('INJECTED'); }, TypeError,
      'returned lines are Object.frozen');
    assert.throws(() => { (stored.lines as string[])[0] = 'X'; }, TypeError,
      'set() snapshot is frozen too');
  });

  it('a ranged view without a freeze falls back fresh with the visible notice', () => {
    seed(uid('fallback'));
    const cache = new RenderCache(() => 0);
    const page = materializeView(db, '/memories/x/facts.md', 'mat-proj', 'facts', cache, true, silentLog);
    assert.equal(page.fresh, true);
    assert.equal(page.lines[0], FRESH_RENDERING_NOTICE);
  });

  it('TTL expiry via the injected clock behaves exactly like absence', () => {
    seed(uid('ttlrow00'));
    let nowMs = 0;
    const cache = new RenderCache(() => nowMs);
    materializeView(db, '/memories/x/facts.md', 'mat-proj', 'facts', cache, false, silentLog);
    nowMs += RENDER_CACHE.TTL_MS + 1;
    const page = materializeView(db, '/memories/x/facts.md', 'mat-proj', 'facts', cache, true, silentLog);
    assert.equal(page.fresh, true);
    assert.equal(page.lines[0], FRESH_RENDERING_NOTICE);
  });

  it('LRU count and aggregate-byte eviction are deterministic', () => {
    const cache = new RenderCache(() => 0);
    for (let i = 0; i < RENDER_CACHE.MAX_ENTRIES + 1; i++) {
      cache.set(`/memories/f${i}.md`, [`line for ${i}`]);
    }
    assert.equal(cache.get('/memories/f0.md'), null, 'oldest evicted at count bound');
    assert.ok(cache.get('/memories/f1.md'));

    const big = ['x'.repeat(3 * 1024 * 1024)];
    cache.set('/memories/big1.md', big);
    cache.set('/memories/big2.md', big);
    assert.equal(cache.get('/memories/big1.md'), null, 'older large rendering evicted at byte bound');
    assert.ok(cache.get('/memories/big2.md'));
  });

  it('access refreshes LRU order deterministically', () => {
    const cache = new RenderCache(() => 0);
    for (let i = 0; i < RENDER_CACHE.MAX_ENTRIES; i++) {
      cache.set(`/memories/f${i}.md`, [`line ${i}`]);
    }
    assert.ok(cache.get('/memories/f0.md'), 'touch the oldest');
    cache.set('/memories/overflow.md', ['line']);
    assert.ok(cache.get('/memories/f0.md'), 'touched entry survived');
    assert.equal(cache.get('/memories/f1.md'), null, 'untouched next-oldest was the victim');
  });
});
