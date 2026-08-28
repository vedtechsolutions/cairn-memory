/**
 * Command handlers (W4 v3.1 §5, §6, §8) — proves the six review
 * properties: transaction-wide staleness checks, mixed-command rollback,
 * strict block grammar at the handler boundary, shared-plan
 * preflight/execution, successful-write-only cache invalidation, and zero
 * mutation on every error path. Contract behaviors (numbering, ranges,
 * truncation, listings, plan read-only, free-form caps) ride along.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { openDatabase } from '../src/db/connection.js';
import { PlanRepository } from '../src/db/plan-repository.js';
import { MemoryCommandHandlers } from '../src/memory-tool/command-handlers.js';
import { RenderCache } from '../src/memory-tool/render-cache.js';
import { encodeProjectSegment } from '../src/memory-tool/path-router.js';

class SpyCache extends RenderCache {
  invalidations: string[] = [];
  wipes = 0;
  override invalidate(path: string): void { this.invalidations.push(path); super.invalidate(path); }
  override invalidateAll(): void { this.wipes++; super.invalidateAll(); }
}

let db: Database.Database;
let planRepo: PlanRepository;
let cache: SpyCache;
let h: MemoryCommandHandlers;

beforeEach(() => {
  db = openDatabase({ dbPath: ':memory:' });
  planRepo = new PlanRepository(db);
  cache = new SpyCache();
  h = new MemoryCommandHandlers({ db, planRepo, cache, log: () => {} });
});
afterEach(() => { db.close(); });

const GLOBAL_FACTS = '/memories/global/facts.md';
const PROJ = 'handler-proj';
const PROJ_DIR = `/memories/${encodeProjectSegment(PROJ)}`;

/** Deterministic canonical-UUID ids (hex-encoded tag → valid lowercase
 *  hex). Tags used together in one scope must differ within their first
 *  FOUR characters — those become the token's 8-char hex prefix, and a
 *  collision makes the renderer extend prefixes past what blockLine
 *  searches for. */
const uid = (tag: string): string => {
  const hex = Buffer.from(tag, 'utf8').toString('hex').padEnd(20, '0');
  return `${hex.slice(0, 8)}-0000-4000-8000-${hex.slice(8, 20)}`;
};

function seed(id: string, over: Record<string, unknown> = {}): void {
  db.prepare(`
    INSERT INTO memories (id, content, kind, project, tags, confidence, source, created_at, recall_count, invalidated, surface_count, impact_count)
    VALUES (@id, @content, @kind, @project, @tags, @confidence, @source, @created_at, 0, @invalidated, @surface_count, @impact_count)
  `).run({
    id, content: `content ${id}`, kind: 'fact', project: null, tags: '[]',
    confidence: 0.6, source: 'learned', created_at: '2026-07-01T00:00:00.000Z',
    invalidated: 0, surface_count: 0, impact_count: 0, ...over,
  });
}

/** Full persistent-state fingerprint for zero-mutation assertions. */
const snapshot = (): string => JSON.stringify({
  memories: db.prepare(`
    SELECT id, content, kind, project, tags, confidence, source, context, anchor,
           invalidated, expires_at, superseded_by, superseded_at, revision
    FROM memories ORDER BY id
  `).all(),
  files: db.prepare('SELECT path, content FROM memory_files ORDER BY path').all(),
  edges: db.prepare('SELECT source_id, target_id, relation FROM memory_edges ORDER BY source_id, target_id, relation').all(),
});

/** Assert fn throws matching pattern (no `Error: ` prefix) AND left the
 *  database byte-identical. */
const failsClean = (fn: () => void, pattern: RegExp): void => {
  const before = snapshot();
  assert.throws(fn, (err: Error) => {
    assert.match(err.message, pattern);
    assert.doesNotMatch(err.message, /^Error: /);
    return true;
  });
  assert.equal(snapshot(), before, 'state mutated on an error path');
};

/** Rendered content lines of a view (header dropped, numbering stripped). */
const contentLines = (path: string): string[] =>
  h.view(path).split('\n').slice(1).map(l => l.replace(/^ *\d+\t/, ''));

const blockLine = (path: string, id: string): string => {
  const line = contentLines(path).find(l => l.includes(`:${id.slice(0, 8)}@`));
  assert.ok(line, `no rendered block for ${id}`);
  return line as string;
};

/** Full canonical block: token line plus its continuation lines — what
 *  str_replace's canonical verification requires as old_str. */
const fullBlockOf = (path: string, id: string): string => {
  const lines = contentLines(path);
  const start = lines.findIndex(l => l.startsWith('- [') && l.includes(`:${id.slice(0, 8)}`));
  assert.ok(start >= 0, `no rendered block for ${id}`);
  let end = start + 1;
  while (end < lines.length && lines[end].startsWith('  ')) end++;
  return lines.slice(start, end).join('\n');
};

const rowOf = (id: string): { content: string; revision: number; invalidated: number } =>
  db.prepare('SELECT content, revision, invalidated FROM memories WHERE id = ?').get(id) as never;

// ------------------------------------------------------------------------------

describe('transaction-wide staleness checks', () => {
  it('one stale token fails the WHOLE edit — the fresh record is untouched too', () => {
    const a = uid('a-stal');
    const b = uid('b-stal');
    seed(a, { content: 'alpha uses widget framework for rendering' });
    seed(b, { content: 'beta queue consumes events from broker' });
    const oldA = blockLine(GLOBAL_FACTS, a);
    const oldB = blockLine(GLOBAL_FACTS, b);

    // Out-of-band edit bumps b's revision: the @1 token in old_str is now stale.
    db.prepare('UPDATE memories SET content = ? WHERE id = ?').run('beta queue drained by new worker', b);
    assert.equal(rowOf(b).revision, 2);

    const newA = `- [fac:${a.slice(0, 8)}@1] content: "alpha rewritten content"`;
    const newB = `- [fac:${b.slice(0, 8)}@1] content: "beta rewritten content"`;
    failsClean(
      () => h.strReplace(GLOBAL_FACTS, `${oldA}\n${oldB}`, `${newA}\n${newB}`),
      new RegExp(`stale record \\[fac:${b.slice(0, 8)}@1\\] — its current revision is 2`),
    );
    assert.equal(rowOf(a).content, 'alpha uses widget framework for rendering');
    assert.equal(rowOf(a).revision, 1);
  });

  it('resolution happens inside the transaction: ambiguous prefixes fail closed', () => {
    seed('aabbccdd-0000-4000-8000-000000000001', { content: 'first twin record here' });
    seed('aabbccdd-0000-4000-8000-000000000002', { content: 'second twin record there' });
    failsClean(
      () => h.strReplace(GLOBAL_FACTS, '- [fac:aabbccdd@1] content: "first twin record here"'),
      /token prefix aabbccdd is ambiguous/,
    );
  });

  it('a token for a record of the wrong kind is rejected for the file', () => {
    const a = uid('kindmix');
    seed(a, { kind: 'pitfall', content: 'never trust the cached handle' });
    failsClean(
      () => h.strReplace(GLOBAL_FACTS, `- [pit:${a.slice(0, 8)}@1] content: "never trust the cached handle"`),
      /does not belong in \/memories\/global\/facts\.md/,
    );
  });

  it('a token matching no active record names the path in its error', () => {
    seed(uid('present'), { content: 'some existing fact content' });
    failsClean(
      () => h.strReplace(GLOBAL_FACTS, '- [fac:deadbeef@1] content: "phantom"'),
      /no record matches token \[fac:deadbeef@1\]/,
    );
  });
});

describe('mixed-command rollback', () => {
  it('update + delete + failing create in one edit: the applied update rolls back', () => {
    const a = uid('a-upd');
    const b = uid('b-del');
    const x = uid('x-dup');
    seed(a, { content: 'gateway timeout raised to ninety seconds' });
    seed(b, { content: 'billing worker retries thrice on failure' });
    seed(x, { content: 'exports bucket lives in the frankfurt region' });
    const oldA = blockLine(GLOBAL_FACTS, a);
    const oldB = blockLine(GLOBAL_FACTS, b);

    // new_str: update a (processed first), then a token-less create that
    // trips the duplicate preflight; b's omission would delete it.
    const newStr = [
      `- [fac:${a.slice(0, 8)}@1] content: "gateway timeout raised to thirty seconds"`,
      '- content: "exports bucket lives in the frankfurt region"',
    ].join('\n');
    failsClean(
      () => h.strReplace(GLOBAL_FACTS, `${oldA}\n${oldB}`, newStr),
      new RegExp(`matches existing record \\[fac:${x.slice(0, 8)}@1\\]`),
    );
    assert.equal(rowOf(a).content, 'gateway timeout raised to ninety seconds');
    assert.equal(rowOf(b).invalidated, 0);
  });

  it('a failure at the LAST statement (induced) rolls back everything before it', () => {
    const a = uid('a-late');
    const b = uid('b-late');
    seed(a, { content: 'scheduler runs compaction every night' });
    seed(b, { content: 'archiver prunes stale snapshots weekly' });
    const oldA = blockLine(GLOBAL_FACTS, a);
    const oldB = blockLine(GLOBAL_FACTS, b);
    db.exec(`
      CREATE TRIGGER test_induced_fail BEFORE UPDATE OF invalidated ON memories
      WHEN NEW.id = '${b}' AND NEW.invalidated = 1
      BEGIN SELECT RAISE(ABORT, 'induced failure'); END
    `);
    try {
      // a's update applies inside the transaction; b's delete (the final
      // statement) aborts — the applied update must roll back.
      failsClean(
        () => h.strReplace(GLOBAL_FACTS, `${oldA}\n${oldB}`, `- [fac:${a.slice(0, 8)}@1] content: "scheduler compacts hourly now"`),
        /induced failure/,
      );
      assert.equal(rowOf(a).content, 'scheduler runs compaction every night');
      assert.equal(rowOf(a).revision, 1);
      assert.equal(rowOf(b).invalidated, 0);
    } finally {
      db.exec('DROP TRIGGER test_induced_fail');
    }
  });
});

describe('strict block grammar at the handler boundary', () => {
  it('create rejects tokened blocks, malformed lines, and confidence edits', () => {
    failsClean(() => h.create(GLOBAL_FACTS, '- [fac:0123abcd@1] content: "x"'), /token-less blocks only/);
    failsClean(() => h.create(GLOBAL_FACTS, 'not a block'), /malformed record block/);
    failsClean(() => h.create(GLOBAL_FACTS, '- content: "x"\n  confidence: 0.9'), /confidence is system-managed/);
  });

  it('str_replace rejects token-less old_str blocks and malformed new_str', () => {
    const a = uid('gramma');
    seed(a, { content: 'parser target record content' });
    failsClean(() => h.strReplace(GLOBAL_FACTS, '- content: "parser target record content"'), /old_str must contain only rendered \(tokened\) record blocks/);
    failsClean(() => h.strReplace(GLOBAL_FACTS, blockLine(GLOBAL_FACTS, a), '  why: "orphan"'), /continuation line before any block start/);
  });

  it('new_str tokens must match old_str tokens exactly — kind, id, and revision', () => {
    const a = uid('exactok');
    seed(a, { content: 'exact match target record' });
    const oldA = blockLine(GLOBAL_FACTS, a);
    failsClean(
      () => h.strReplace(GLOBAL_FACTS, oldA, `- [fac:${a.slice(0, 8)}@2] content: "wrong revision"`),
      /does not match any old_str token exactly/,
    );
    failsClean(
      () => h.strReplace(GLOBAL_FACTS, oldA, '- [fac:ffffffff@1] content: "wrong id"'),
      /does not match any old_str token exactly/,
    );
  });

  it('insert accepts only token-less blocks', () => {
    seed(uid('insbase'), { content: 'insert baseline record content' });
    failsClean(
      () => h.insert(GLOBAL_FACTS, 0, '- [fac:0123abcd@1] content: "x"'),
      /token-less blocks only/,
    );
  });
});

describe('shared-plan preflight/execution', () => {
  it('a duplicate create is rejected with the existing record token', () => {
    const x = uid('dupbase');
    seed(x, { content: 'ingestion pipeline batches records every five minutes' });
    failsClean(
      () => h.insert(GLOBAL_FACTS, 0, '- content: "ingestion pipeline batches records every five minutes"'),
      new RegExp(`matches existing record \\[fac:${x.slice(0, 8)}@1\\] — view ${GLOBAL_FACTS.replace(/\//g, '\\/')} and edit that record`),
    );
  });

  it('a create that would supersede rolls back and reports a usable CAS token', () => {
    const x = uid('superb');
    seed(x, { content: 'api server uses redis version 6.2.1 for caching' });
    // The token must be canonical and POST-rollback: prefix as rendered,
    // revision 1 (the trial insert's supersession bump was unwound).
    failsClean(
      () => h.insert(GLOBAL_FACTS, 0, '- content: "api server uses redis version 7.0.4 for caching"'),
      new RegExp(`would supersede existing record \\[fac:${x.slice(0, 8)}@1\\]`),
    );
    assert.equal(rowOf(x).invalidated, 0);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number }).n, 1);
  });

  it('a standing contradiction is allowed: edge added, both records stay active', () => {
    const x = uid('contra');
    seed(x, { content: 'always run migrations before deploying the api service' });
    const result = h.insert(GLOBAL_FACTS, 0, '- content: "never run migrations before deploying the api service"');
    assert.match(result, /has been edited/);
    assert.equal(rowOf(x).invalidated, 0);
    assert.equal(rowOf(x).revision, 1);
    const rows = db.prepare("SELECT COUNT(*) AS n FROM memory_edges WHERE relation = 'contradicts'").get() as { n: number };
    assert.equal(rows.n, 1);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM memories WHERE invalidated = 0').get() as { n: number }).n, 2);
  });

  it('file-level create runs every block through the shared planner', () => {
    const x = uid('crdupe');
    seed(x, { content: 'search index rebuilds nightly at two', kind: 'decision' });
    // facts.md is empty (x is a decision) so create is legal — but its
    // second block duplicates nothing while the first must still insert.
    const out = h.create(GLOBAL_FACTS, '- content: "cache invalidation happens on write commit"\n- content: "replica lag alarm fires at five seconds"');
    assert.equal(out, `File created successfully at: ${GLOBAL_FACTS}`);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM memories WHERE kind = 'fact' AND invalidated = 0").get() as { n: number }).n, 2);
  });
});

describe('successful-write-only cache invalidation', () => {
  it('no invalidation fires on ANY failed mutation, and the frozen view survives', () => {
    const a = uid('cachea');
    seed(a, { content: 'frozen rendering baseline record' });
    const frozen = h.view(GLOBAL_FACTS);
    cache.invalidations = [];

    assert.throws(() => h.strReplace(GLOBAL_FACTS, `- [fac:${a.slice(0, 8)}@9] content: "frozen rendering baseline record"`));
    assert.throws(() => h.create(GLOBAL_FACTS, '- content: "x"'));
    assert.throws(() => h.insert(GLOBAL_FACTS, 99, '- content: "y"'));
    assert.equal(cache.invalidations.length, 0);
    assert.equal(cache.wipes, 0);

    // The pre-edit frozen rendering still serves ranged views verbatim.
    assert.equal(h.view(GLOBAL_FACTS, [1, -1]), h.view(GLOBAL_FACTS, [1, -1]));
    assert.equal(h.view(GLOBAL_FACTS), frozen);
  });

  it('each successful mutation invalidates exactly its own path, after commit', () => {
    const a = uid('cacheb');
    seed(a, { content: 'cache invalidation subject record' });
    const oldA = blockLine(GLOBAL_FACTS, a);
    cache.invalidations = [];

    h.strReplace(GLOBAL_FACTS, oldA, `- [fac:${a.slice(0, 8)}@1] content: "cache invalidation subject rewritten"`);
    assert.deepEqual(cache.invalidations, [GLOBAL_FACTS]);

    cache.invalidations = [];
    h.insert(GLOBAL_FACTS, 0, '- content: "another unrelated stored observation"');
    assert.deepEqual(cache.invalidations, [GLOBAL_FACTS]);

    cache.invalidations = [];
    h.delete(GLOBAL_FACTS);
    assert.deepEqual(cache.invalidations, [GLOBAL_FACTS]);
  });

  it('rename invalidates both endpoints; directory delete wipes the cache', () => {
    const a = uid('cachec');
    seed(a, { content: 'record that will move projects', project: PROJ });
    cache.invalidations = [];
    const dest = '/memories/global/facts.md';
    h.rename(`${PROJ_DIR}/facts.md`, dest);
    assert.deepEqual(cache.invalidations, [`${PROJ_DIR}/facts.md`, dest]);

    assert.equal(cache.wipes, 0);
    h.delete('/memories/global');
    assert.equal(cache.wipes, 1);
  });
});

describe('zero mutation on every error path (sweep)', () => {
  it('read-only plan.md rejects every mutating command', () => {
    planRepo.create({ project: PROJ, name: 'Guarded plan', steps: [{ description: 'step one' }] });
    const plan = `${PROJ_DIR}/plan.md`;
    failsClean(() => h.create(plan, '- content: "x"'), /read-only — manage the plan via the cairn_plan tool/);
    failsClean(() => h.strReplace(plan, '- [fac:0123abcd@1] content: "x"'), /read-only/);
    failsClean(() => h.insert(plan, 0, '- content: "x"'), /read-only/);
    failsClean(() => h.delete(plan), /read-only/);
    failsClean(() => h.rename(plan, `${PROJ_DIR}/facts.md`), /read-only/);
    failsClean(() => h.delete(PROJ_DIR), /contains read-only plan\.md/);
  });

  it('root and structural rejections', () => {
    seed(uid('rooted'), { content: 'structural rejection baseline' });
    failsClean(() => h.delete('/memories'), /cannot delete the \/memories directory itself/);
    failsClean(() => h.rename('/memories', '/memories/global'), /cannot rename the \/memories directory itself/);
    failsClean(() => h.create('/memories/global', '- content: "x"'), /is a directory/);
    failsClean(() => h.strReplace('/memories/global', 'a', 'b'), /does not exist/);
  });

  it('nonexistent targets reject without mutation', () => {
    failsClean(() => h.view(`${PROJ_DIR}/facts.md`), /does not exist/);
    failsClean(() => h.delete(GLOBAL_FACTS), /does not exist/);
    failsClean(() => h.delete('/memories/notes/missing.md'), /does not exist/);
    failsClean(() => h.insert('/memories/notes/missing.md', 0, 'text'), /does not exist/);
    failsClean(() => h.rename(GLOBAL_FACTS, `${PROJ_DIR}/facts.md`), /does not exist/);
  });

  it('rename shape violations reject without mutation', () => {
    seed(uid('renmix'), { content: 'rename source record content' });
    seed(uid('rendst'), { content: 'rename destination record content', project: PROJ });
    failsClean(() => h.rename(GLOBAL_FACTS, `${PROJ_DIR}/facts.md`), /already exists/);
    failsClean(() => h.rename(GLOBAL_FACTS, '/memories/global/decisions.md'), /cannot rename across memory categories/);
    failsClean(() => h.rename(GLOBAL_FACTS, '/memories/notes/free.md'), /cannot rename across memory domains/);
  });

  it('free-form caps and misses reject without mutation', () => {
    db.prepare("INSERT INTO memory_files (path, content, created_at, updated_at) VALUES ('/memories/notes/a.md', 'alpha beta alpha', datetime('now'), datetime('now'))").run();
    failsClean(() => h.create('/memories/notes/big.md', 'x'.repeat(65_537)), /64KB memory-file limit/);
    failsClean(() => h.strReplace('/memories/notes/a.md', 'gamma', 'delta'), /did not appear verbatim/);
    failsClean(() => h.strReplace('/memories/notes/a.md', 'alpha', 'delta'), /Multiple occurrences of old_str/);
    failsClean(() => h.insert('/memories/notes/a.md', 9, 'x'), /Invalid `insert_line` parameter: 9/);

    const stmt = db.prepare("INSERT INTO memory_files (path, content, created_at, updated_at) VALUES (?, 'x', datetime('now'), datetime('now'))");
    for (let i = 1; i < 256; i++) stmt.run(`/memories/notes/f${i}.md`);
    failsClean(() => h.create('/memories/notes/overflow.md', 'y'), /memory store is full \(256 files\)/);
    // Overwrites of existing paths stay legal at the count cap.
    assert.match(h.create('/memories/notes/a.md', 'replacement body'), /File created successfully/);
  });

  it('invalid view_range shapes reject with the contract error', () => {
    db.prepare("INSERT INTO memory_files (path, content, created_at, updated_at) VALUES ('/memories/notes/r.md', 'l1\nl2\nl3', datetime('now'), datetime('now'))").run();
    failsClean(() => h.view('/memories/notes/r.md', [0, 2]), /Invalid `view_range` parameter: \[0, 2\]\. It should be within the range of lines of the file: \[1, 3\]/);
    failsClean(() => h.view('/memories/notes/r.md', [4, 5]), /Invalid `view_range` parameter/);
    failsClean(() => h.view('/memories/notes/r.md', [2, 1]), /Invalid `view_range` parameter/);
  });
});

describe('contract behaviors', () => {
  it('views number lines 6-wide right-aligned with a tab, 1-indexed', () => {
    db.prepare("INSERT INTO memory_files (path, content, created_at, updated_at) VALUES ('/memories/notes/n.md', 'first\nsecond', datetime('now'), datetime('now'))").run();
    const lines = h.view('/memories/notes/n.md').split('\n');
    assert.equal(lines[0], "Here's the content of /memories/notes/n.md with line numbers:");
    assert.equal(lines[1], '     1\tfirst');
    assert.equal(lines[2], '     2\tsecond');
    assert.equal(h.view('/memories/notes/n.md', [2, 2]).split('\n')[1], '     2\tsecond');
  });

  it('long files truncate at a whole line with a paging marker; ranges page past it', () => {
    const body = Array.from({ length: 2_000 }, (_, i) => `line number ${i + 1} padding padding`).join('\n');
    db.prepare("INSERT INTO memory_files (path, content, created_at, updated_at) VALUES ('/memories/notes/big.md', ?, datetime('now'), datetime('now'))").run(body);
    const out = h.view('/memories/notes/big.md');
    assert.ok(out.length <= 16_000 + 200, 'truncated view stayed near the cap');
    assert.match(out, /\[view truncated at line \d+ of 2000 — use view_range to page\]/);
    const paged = h.view('/memories/notes/big.md', [1_990, 2_000]);
    assert.match(paged, /  1990\tline number 1990/);
    assert.doesNotMatch(paged, /truncated/);
  });

  it('round trip: create → tokens @1 → field edit bumps CAS → edit at new revision → delete by omission', () => {
    h.create(GLOBAL_FACTS, '- content: "deploys pause during the release freeze"\n- content: "the audit log is immutable by policy"');
    const lines = contentLines(GLOBAL_FACTS).filter(l => l.startsWith('- ['));
    assert.equal(lines.length, 2);
    for (const line of lines) assert.match(line, /^- \[fac:[0-9a-f]{8}@1\] content: "/);

    // Field-only edit: content unchanged, why/tags set → one CAS bump (@2).
    const target = lines.find(l => l.includes('audit log')) as string;
    const token = /\[fac:([0-9a-f]{8})@1\]/.exec(target)?.[1] as string;
    h.strReplace(GLOBAL_FACTS, target, `- [fac:${token}@1] content: "the audit log is immutable by policy"\n  why: "compliance requirement"\n  tags: ["audit"]`);
    assert.match(blockLine(GLOBAL_FACTS, token), new RegExp(`\\[fac:${token}@2\\]`));
    assert.match(h.view(GLOBAL_FACTS), /why: "compliance requirement"/);
    assert.match(h.view(GLOBAL_FACTS), /tags: \["audit"\]/);

    // The old @1 token is now stale — CAS rejects it.
    assert.throws(
      () => h.strReplace(GLOBAL_FACTS, `- [fac:${token}@1] content: "x"`),
      /stale record .* current revision is 2/,
    );

    // Content + clear edit at the CURRENT revision, old_str = the FULL
    // canonical block (token line + why + tags): content bump then field
    // bump (@4 — two trigger firings, monotonic is what CAS needs).
    h.strReplace(GLOBAL_FACTS, fullBlockOf(GLOBAL_FACTS, token),
      `- [fac:${token}@2] content: "the audit log is immutable and append-only"\n  why: null\n  tags: []`);
    assert.match(blockLine(GLOBAL_FACTS, token), new RegExp(`\\[fac:${token}@4\\] content: "the audit log is immutable and append-only"`));
    assert.doesNotMatch(h.view(GLOBAL_FACTS), /why: "compliance requirement"/);

    // Delete by omission: keep only the other record.
    const all = contentLines(GLOBAL_FACTS).filter(l => l.startsWith('- ['));
    const keep = all.filter(l => !l.includes(token));
    const out = h.strReplace(GLOBAL_FACTS, all.join('\n'), keep.join('\n'));
    assert.match(out, /The memory file has been edited\./);
    assert.doesNotMatch(h.view(GLOBAL_FACTS), new RegExp(token));
    assert.equal((db.prepare('SELECT invalidated FROM memories WHERE id LIKE ?').get(`${token}%`) as { invalidated: number }).invalidated, 1);
  });

  it('category delete reports the invalidated count; the file then reads nonexistent', () => {
    seed(uid('delone'), { content: 'first deletable stored fact' });
    seed(uid('deltwo'), { content: 'second deletable stored fact' });
    const out = h.delete(GLOBAL_FACTS);
    assert.equal(out, `Successfully deleted ${GLOBAL_FACTS}\n(2 records invalidated)`);
    assert.throws(() => h.view(GLOBAL_FACTS), /does not exist/);
  });

  it('rename moves records across scopes within the same category', () => {
    const a = uid('mover');
    seed(a, { content: 'record migrating between scopes' });
    const out = h.rename(GLOBAL_FACTS, `${PROJ_DIR}/facts.md`);
    assert.equal(out, `Successfully renamed ${GLOBAL_FACTS} to ${PROJ_DIR}/facts.md`);
    assert.equal((db.prepare('SELECT project FROM memories WHERE id = ?').get(a) as { project: string }).project, PROJ);
    assert.throws(() => h.view(GLOBAL_FACTS), /does not exist/);
    assert.match(h.view(`${PROJ_DIR}/facts.md`), /record migrating between scopes/);
  });

  it('root and directory listings show existing files with sizes, including plan.md', () => {
    seed(uid('lstglb'), { content: 'global listing subject fact' });
    seed(uid('lstprj'), { content: 'project listing subject fact', project: PROJ, kind: 'pitfall' });
    planRepo.create({ project: PROJ, name: 'Listed plan', steps: [{ description: 'only step' }] });
    db.prepare("INSERT INTO memory_files (path, content, created_at, updated_at) VALUES ('/memories/notes/free.md', 'free body', datetime('now'), datetime('now'))").run();

    const root = h.view('/memories');
    assert.match(root, /^Here're the files and directories up to 2 levels deep in \/memories, excluding hidden items and node_modules:/);
    assert.match(root, /\t\/memories\/global\/facts\.md/);
    assert.match(root, new RegExp(`\\t${PROJ_DIR.replace(/\//g, '\\/')}\\/pitfalls\\.md`));
    assert.match(root, new RegExp(`\\t${PROJ_DIR.replace(/\//g, '\\/')}\\/plan\\.md`));
    assert.match(root, /\t\/memories\/notes\/free\.md/);
    assert.match(root, /\d+(\.\d+)?[BKM]\t/);

    const dir = h.view(PROJ_DIR);
    assert.match(dir, new RegExp(`in ${PROJ_DIR.replace(/\//g, '\\/')},`));
    assert.match(dir, /pitfalls\.md/);
    assert.doesNotMatch(dir, /facts\.md/);
  });

  it('plan.md views render read-only, token-less, and vanish with no active plan', () => {
    planRepo.create({ project: PROJ, name: 'Visible plan', steps: [{ description: 'do the thing' }] });
    const out = h.view(`${PROJ_DIR}/plan.md`);
    assert.match(out, /# Plan: Visible plan \[active\]/);
    assert.match(out, /read-only — manage via the cairn_plan tool/);
    assert.match(out, /- \[ \] 1\. do the thing/);
    assert.doesNotMatch(out, /@\d+\]/);
    assert.throws(() => h.view('/memories/global/plan.md'), /does not exist/);
  });

  it('free-form files round trip through create, replace, insert, rename, delete', () => {
    assert.equal(h.create('/memories/notes/scratch.md', 'alpha\nbeta'), 'File created successfully at: /memories/notes/scratch.md');
    assert.match(h.strReplace('/memories/notes/scratch.md', 'beta', 'gamma'), /The memory file has been edited\./);
    assert.equal(h.insert('/memories/notes/scratch.md', 1, 'inserted'), 'The file /memories/notes/scratch.md has been edited.');
    assert.match(h.view('/memories/notes/scratch.md'), /1\talpha\n\s+2\tinserted\n\s+3\tgamma/);
    assert.equal(h.rename('/memories/notes/scratch.md', '/memories/notes/kept.md'), 'Successfully renamed /memories/notes/scratch.md to /memories/notes/kept.md');
    assert.equal(h.delete('/memories/notes/kept.md'), 'Successfully deleted /memories/notes/kept.md');
    assert.throws(() => h.view('/memories/notes/kept.md'), /does not exist/);
  });
});

describe('adversarial probe regressions', () => {
  const seedFile = (path: string, content: string): void => {
    db.prepare("INSERT INTO memory_files (path, content, created_at, updated_at) VALUES (?, ?, datetime('now'), datetime('now'))").run(path, content);
  };

  it('directory delete matches LIKE wildcards literally — sibling projects survive', () => {
    // '࠿' (U+083F) encodes to p-4KC_; 'ࠀ' (U+0800) to p-4KCA. An
    // unescaped `_` would make p-4KC_/% swallow p-4KCA files.
    assert.equal(encodeProjectSegment('࠿'), 'p-4KC_');
    assert.equal(encodeProjectSegment('ࠀ'), 'p-4KCA');
    seed(uid('wildus'), { content: 'record in the underscore project', project: '࠿' });
    seedFile('/memories/p-4KC_/own.md', 'belongs to the underscore project');
    seedFile('/memories/p-4KCA/data.md', 'belongs to the sibling project');

    const out = h.delete('/memories/p-4KC_');
    assert.equal(out, 'Successfully deleted /memories/p-4KC_\n(1 records invalidated, 1 files deleted)');
    const sibling = db.prepare("SELECT COUNT(*) AS n FROM memory_files WHERE path = '/memories/p-4KCA/data.md'").get() as { n: number };
    assert.equal(sibling.n, 1, 'sibling project file must survive');
  });

  it('old_str must equal the canonical rendered block — an invented block is rejected', () => {
    const a = uid('canon');
    seed(a, { content: 'canonical verification target record' });
    failsClean(
      () => h.strReplace(GLOBAL_FACTS,
        `- [fac:${a.slice(0, 8)}@1] content: "invented content the model never saw"`,
        `- [fac:${a.slice(0, 8)}@1] content: "attacker replacement"`),
      /does not match the rendered record exactly/,
    );
  });

  it('duplicate record identities are rejected in old_str and in new_str', () => {
    const a = uid('dupids');
    seed(a, { content: 'duplicate identity target record' });
    const block = blockLine(GLOBAL_FACTS, a);
    failsClean(() => h.strReplace(GLOBAL_FACTS, `${block}\n${block}`), /lists record .* more than once/);
    failsClean(
      () => h.strReplace(GLOBAL_FACTS, block,
        `- [fac:${a.slice(0, 8)}@1] content: "duplicate identity target record"\n- [fac:${a.slice(0, 8)}@1] content: "second copy wins otherwise"`),
      /lists record .* more than once/,
    );
    assert.equal(rowOf(a).revision, 1);
  });

  it('corrupt active rows keep the file existing, listed, movable, and deletable', () => {
    const good = uid('a-ok');
    const bad = uid('b-bad');
    seed(good, { content: 'healthy neighbouring record' });
    // Unparseable tags: the row fails row→domain MAPPING entirely — the
    // strictest corruption class, invisible to mapped-record existence.
    seed(bad, { content: 'corrupt row content', tags: 'not valid json {' });

    assert.match(h.view(GLOBAL_FACTS), /1 records unrenderable/);
    assert.match(h.view('/memories/global'), /facts\.md/);
    failsClean(() => h.create(GLOBAL_FACTS, '- content: "should be refused"'), /already exists/);

    h.rename(GLOBAL_FACTS, `${PROJ_DIR}/facts.md`);
    assert.equal((db.prepare('SELECT project FROM memories WHERE id = ?').get(bad) as { project: string }).project, PROJ);

    const out = h.delete(`${PROJ_DIR}/facts.md`);
    assert.match(out, /2 records invalidated/);
    assert.equal(rowOf(bad).invalidated, 1);
  });

  it('a destination holding only a corrupt row still blocks rename', () => {
    seed(uid('a-src'), { content: 'source record in good shape' });
    seed(uid('b-dst'), { content: 'corrupt destination row', project: PROJ, tags: 'not json at all' });
    failsClean(() => h.rename(GLOBAL_FACTS, `${PROJ_DIR}/facts.md`), /already exists/);
  });

  it('a file whose ONLY row is corrupt still views as a warning, not nonexistent', () => {
    seed(uid('onlyko'), { content: 'sole corrupt row', tags: '{"not":"array"}' });
    assert.match(h.view(GLOBAL_FACTS), /1 records unrenderable/);
  });

  it('path aliases and the canonical spelling share one cache entry', () => {
    const a = uid('alias');
    seed(a, { content: 'alias cache subject record' });
    const alias = '/memories//global/facts.md';
    h.view(alias); // freezes under the CANONICAL key despite the alias
    cache.invalidations = [];

    h.strReplace(GLOBAL_FACTS, blockLine(GLOBAL_FACTS, a),
      `- [fac:${a.slice(0, 8)}@1] content: "alias cache subject rewritten"`);
    assert.deepEqual(cache.invalidations, [GLOBAL_FACTS]);
    const ranged = h.view(alias, [1, 1]);
    assert.doesNotMatch(ranged, /alias cache subject record/);
  });

  it('free-form replace is atomic — an induced write failure leaves the file unchanged', () => {
    seedFile('/memories/notes/atomic.md', 'before text stays intact');
    db.exec("CREATE TRIGGER test_ff_fail BEFORE UPDATE ON memory_files BEGIN SELECT RAISE(ABORT, 'induced ff failure'); END");
    try {
      failsClean(() => h.strReplace('/memories/notes/atomic.md', 'before', 'after'), /induced ff failure/);
    } finally {
      db.exec('DROP TRIGGER test_ff_fail');
    }
  });

  it('range ends beyond EOF are rejected, not clamped', () => {
    seedFile('/memories/notes/two.md', 'one\ntwo');
    failsClean(() => h.view('/memories/notes/two.md', [1, 99]), /Invalid `view_range` parameter: \[1, 99\]\. It should be within the range of lines of the file: \[1, 2\]/);
  });

  it('a single line beyond the view cap truncates to zero content lines', () => {
    seedFile('/memories/notes/huge.md', 'x'.repeat(65_000));
    const out = h.view('/memories/notes/huge.md');
    assert.ok(out.length < 300, `expected a tiny truncated view, got ${out.length} chars`);
    assert.match(out, /\[view truncated — line 1 alone exceeds the 16,000-character view limit\]/);
  });

  it('directory delete never touches unmapped task_state records', () => {
    const ghost = uid('a-ts');
    seed(ghost, { content: 'hidden ephemeral task state', kind: 'task_state', project: PROJ });
    // A task_state-only project owns nothing in the VFS: the directory is
    // nonexistent, and the hidden record must stay untouched.
    failsClean(() => h.delete(PROJ_DIR), /does not exist/);

    const fact = uid('b-fct');
    seed(fact, { content: 'visible fact beside the task state', project: PROJ });
    const out = h.delete(PROJ_DIR);
    assert.match(out, /1 records invalidated, 0 files deleted/);
    assert.equal(rowOf(ghost).invalidated, 0, 'task_state must never be invalidated');
    assert.equal(rowOf(fact).invalidated, 1);
  });

  it('insert validation happens inside the write transaction (lock-boundary proof)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cairn-lock-'));
    const db1 = openDatabase({ dbPath: join(dir, 'lock.db') });
    const db2 = openDatabase({ dbPath: join(dir, 'lock.db') });
    try {
      db1.pragma('busy_timeout = 0');
      const h1 = new MemoryCommandHandlers({ db: db1, planRepo: new PlanRepository(db1), log: () => {} });
      db2.exec('BEGIN IMMEDIATE');
      // With checks inside the immediate transaction, the FIRST observable
      // act is acquiring the write lock → SQLITE_BUSY. The pre-fix code
      // validated first and threw the nonexistent-path contract error.
      assert.throws(
        () => h1.insert(GLOBAL_FACTS, 0, '- content: "boundary probe"'),
        (err: Error & { code?: string }) => err.code === 'SQLITE_BUSY',
      );
      db2.exec('ROLLBACK');
    } finally {
      db2.close();
      db1.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('blocks duplicating another NEW block get a dedicated tokenless error', () => {
    failsClean(
      () => h.create(GLOBAL_FACTS, '- content: "identical twin block payload here"\n- content: "identical twin block payload here"'),
      /duplicates another new block in the same command — merge them into one record/,
    );
  });

  it('blocks superseding another NEW block get a dedicated tokenless error — no phantom identity', () => {
    const before = snapshot();
    // Version drift between two blocks of ONE command: the second block
    // supersedes the first NEW block, which the rollback then erases —
    // any token or raw id in the error would name a nonexistent record.
    assert.throws(
      () => h.create(GLOBAL_FACTS,
        '- content: "api server uses redis version 6.2.1 for caching"\n- content: "api server uses redis version 7.0.4 for caching"'),
      (err: Error) => {
        assert.match(err.message, /these new blocks supersede one another — submit one final record/);
        assert.doesNotMatch(err.message, /\[fac:/, 'no token for an ephemeral record');
        assert.doesNotMatch(err.message, /[0-9a-f]{8}-[0-9a-f]{4}/, 'no raw uuid for an ephemeral record');
        assert.doesNotMatch(err.message, /^Error: /);
        return true;
      },
    );
    assert.equal(snapshot(), before, 'state mutated on an error path');
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number }).n, 0);
  });

  it('a duplicate of a record UPDATED earlier in the command reports the restored revision', () => {
    const x = uid('x-mix');
    seed(x, { content: 'record updated before the duplicate create' });
    const oldX = blockLine(GLOBAL_FACTS, x);
    // The update bumps x transiently (rev 2 in-transaction); the token in
    // the error must show the RESTORED revision 1 after rollback.
    failsClean(
      () => h.strReplace(GLOBAL_FACTS, oldX,
        `- [fac:${x.slice(0, 8)}@1] content: "completely rewritten unique payload"\n- content: "completely rewritten unique payload"`),
      new RegExp(`matches existing record \\[fac:${x.slice(0, 8)}@1\\]`),
    );
  });

  it('uppercase-hex ids are unrenderable — never rendered as uneditable tokens', () => {
    seed('ABCDEF01-0000-4000-8000-000000000000', { content: 'uppercase identity row' });
    const out = h.view(GLOBAL_FACTS);
    assert.match(out, /1 records unrenderable/);
    assert.doesNotMatch(out, /ABCDEF01/);
  });

  it('gateway duplicate errors carry the collision-extended token, usable as-is', () => {
    const id1 = 'aabbccdd-0000-4000-8000-000000000001';
    const id2 = 'aabbccdd-0000-4000-8000-000000000002';
    seed(id1, { content: 'colliding record first version here' });
    seed(id2, { content: 'unrelated second colliding sibling entry' });
    // Prefixes extend to the FULL id (the pair differs only at the last
    // character) — an 8-char token would be ambiguous and unusable.
    failsClean(
      () => h.insert(GLOBAL_FACTS, 0, '- content: "colliding record first version here"'),
      new RegExp(`matches existing record \\[fac:${id1}@1\\]`),
    );
  });
});

// --- Frozen paging across ranking changes (design §7, adapter level) -----------

describe('frozen paging across ranking changes', () => {
  /** Six facts with strictly descending confidence — the rendered order
   *  is deterministic and every record is a single block line. */
  const seedRanked = (): string[] => {
    const words = ['alpha', 'bravo', 'carol', 'delta', 'eagle', 'fanta'];
    return words.map((word, i) => {
      const id = uid(`${word.slice(0, 4)}`);
      seed(id, { content: `${word} ranked record body`, confidence: 0.9 - i * 0.1 });
      return id;
    });
  };
  const stripNumbers = (view: string): string[] =>
    view.split('\n').slice(1).filter(l => !l.startsWith('[')).map(l => l.replace(/^ *\d+\t/, ''));

  it('pages never duplicate or omit records when the ranking changes between pages', () => {
    const ids = seedRanked();
    const frozen = stripNumbers(h.view(GLOBAL_FACTS));
    assert.equal(frozen.length, 6);

    const pageOne = stripNumbers(h.view(GLOBAL_FACTS, [1, 3]));

    // OUT-OF-BAND ranking change between pages: decay/feedback writes
    // bypass the adapter and do NOT invalidate its cache. A fresh
    // re-render would move the last record to the top, shifting every
    // page boundary (duplicating one record, omitting another).
    db.prepare('UPDATE memories SET confidence = 0.99 WHERE id = ?').run(ids[5]);

    const pageTwo = stripNumbers(h.view(GLOBAL_FACTS, [4, -1]));
    assert.deepEqual([...pageOne, ...pageTwo], frozen, 'pages must serve ONE frozen rendering');

    const tokens = [...pageOne, ...pageTwo].map(l => /\[fac:([0-9a-f]+)@/.exec(l)?.[1]);
    assert.equal(new Set(tokens).size, 6, 'every record exactly once across pages');
  });

  it('an expired freeze falls back statelessly: visible notice + the NEW ranking', () => {
    let now = 0;
    const ttlCache = new RenderCache(() => now);
    const ttlHandlers = new MemoryCommandHandlers({ db, planRepo, cache: ttlCache, log: () => {} });
    const ids = seedRanked();

    ttlHandlers.view(GLOBAL_FACTS); // freeze at t=0
    db.prepare('UPDATE memories SET confidence = 0.99 WHERE id = ?').run(ids[5]);

    now = 5 * 60_000 + 1; // past the 5-minute TTL
    const paged = ttlHandlers.view(GLOBAL_FACTS, [1, -1]);
    const lines = paged.split('\n').slice(1);
    assert.match(lines[0], /^ *1\t\[fresh rendering — line numbers may differ from any earlier view\]$/);
    assert.match(lines[1], /fanta ranked record body/, 'fresh rendering must show the NEW ranking first');
  });

  it('a successful mutation unfreezes: the next pages serve the new rendering', () => {
    seedRanked();
    h.view(GLOBAL_FACTS, [1, 3]); // ranged after full view inside view() freezes
    const target = blockLine(GLOBAL_FACTS, uid('fant'));
    h.strReplace(GLOBAL_FACTS, target, target.replace('fanta ranked record body', 'fanta rewritten and re-ranked'));
    const afterEdit = stripNumbers(h.view(GLOBAL_FACTS, [1, -1]));
    assert.ok(afterEdit.some(l => l.includes('fanta rewritten and re-ranked')), 'post-commit pages must see the edit');
  });
});
