/**
 * Schema v27 (roadmap W4 preparatory) — structural revision counter +
 * memory_files. Assertions run against BOTH a fresh database and a
 * v26→v27 migrated database, and (where trigger interaction matters)
 * under BOTH recursive_triggers settings: the design is pragma-
 * independent because the revision trigger's inner update mentions only
 * `revision`, which appears in no trigger's UPDATE OF list.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import type Database from 'better-sqlite3';
import { openDatabase } from '../src/db/connection.js';
import { MemoryRepository } from '../src/db/memory-repository.js';
import { applyConfidenceDecay } from '../src/db/decay.js';
import { SCHEMA_VERSION } from '../src/db/schema.js';
import { stripV27Surface } from './helpers/schema-rewind.js';

const DAY = 86_400_000;
const iso = (msAgo: number): string => new Date(Date.now() - msAgo).toISOString();

function seed(db: Database.Database, id: string, over: Record<string, unknown> = {}): void {
  db.prepare(`
    INSERT INTO memories (id, content, kind, project, tags, confidence, source, created_at, recall_count, invalidated)
    VALUES (@id, @content, @kind, @project, @tags, @confidence, @source, @created_at, 0, 0)
  `).run({
    id, content: `seed content ${id}`, kind: 'fact', project: 'v27-proj', tags: '[]',
    confidence: 0.6, source: 'learned', created_at: iso(10 * DAY), ...over,
  });
}

const revisionOf = (db: Database.Database, id: string): number =>
  (db.prepare('SELECT revision FROM memories WHERE id = ?').get(id) as { revision: number }).revision;

/** The full v27 behavioral contract, asserted against any open database. */
function assertV27Behavior(db: Database.Database, label: string): void {
  for (const pragma of ['OFF', 'ON'] as const) {
    db.pragma(`recursive_triggers = ${pragma}`);
    const tag = `${label}/recursive_triggers=${pragma}`;
    const id = `rev-${label}-${pragma}`.toLowerCase();
    seed(db, id);
    assert.equal(revisionOf(db, id), 1, `${tag}: fresh row starts at revision 1`);

    // Every rendered-semantic column bumps revision exactly once per UPDATE
    const semanticUpdates: Array<[string, unknown[]]> = [
      ['content = ?', [`updated content ${id} zebra`]],
      ['kind = ?', ['decision']],
      ['project = ?', ['other-proj']],
      ["tags = ?", ['["a"]']],
      ['confidence = ?', [0.7]],
      ["source = ?", ['confirmed']],
      ["context = ?", ['{"why":"w"}']],
      ["anchor = ?", ['{"file":"x"}']],
      ['invalidated = ?', [0]],
      ['expires_at = ?', [null]],
      ['superseded_by = ?', [null]],
      ['superseded_at = ?', [null]],
    ];
    let expected = 1;
    for (const [setClause, params] of semanticUpdates) {
      db.prepare(`UPDATE memories SET ${setClause} WHERE id = ?`).run(...params, id);
      expected++;
      assert.equal(revisionOf(db, id), expected, `${tag}: SET ${setClause} bumps revision`);
    }

    // Embedding + telemetry writes must NOT bump
    db.prepare('UPDATE memories SET embedding = ?, embedding_model = ? WHERE id = ?')
      .run(Buffer.from(new Float32Array(4).buffer), 'minilm-l6', id);
    db.prepare('UPDATE memories SET last_recalled = ?, recall_count = recall_count + 1 WHERE id = ?')
      .run(iso(0), id);
    db.prepare('UPDATE memories SET surface_count = 3, impact_count = 1, last_decayed_at = ? WHERE id = ?')
      .run(iso(0), id);
    assert.equal(revisionOf(db, id), expected, `${tag}: embedding/telemetry writes do not bump`);

    // FTS trigger ACTIVITY — measured by an invocation counter, not by
    // final index state (review-verified vacuous: a defective broad
    // double-firing trigger nets back to a consistent index, identical
    // fts5vocab instance counts, and a passing integrity-check). The
    // INSTALLED memories_au SQL is read from sqlite_master and recreated
    // verbatim with ONE added audit INSERT, so the counted firing
    // condition is exactly the shipped one — a regressed broad trigger
    // would fire (and be counted) on non-content writes.
    const suffix = `${label}${pragma}`.toLowerCase();
    const ftsId = `fts-${suffix}`;
    seed(db, ftsId, { content: `aardwolf${suffix} sentinel original` });

    // Main-schema audit table: a main-schema trigger body cannot reference
    // TEMP objects (cross-database references are rejected at execution).
    db.exec('CREATE TABLE IF NOT EXISTS fts_trigger_audit (fired INTEGER)');
    db.exec('DELETE FROM fts_trigger_audit');
    const installedAu = (db.prepare(
      "SELECT sql FROM sqlite_master WHERE type='trigger' AND name='memories_au'").get() as { sql: string }).sql;
    db.exec('DROP TRIGGER memories_au');
    db.exec(installedAu.replace('BEGIN', 'BEGIN INSERT INTO fts_trigger_audit VALUES (1);'));
    const fired = (): number =>
      (db.prepare('SELECT COUNT(*) AS n FROM fts_trigger_audit').get() as { n: number }).n;
    try {
      db.prepare('UPDATE memories SET content = ? WHERE id = ?').run(`replacement quokka${suffix} sentinel`, ftsId);
      assert.equal(fired(), 1, `${tag}: content update fires memories_au exactly once`);
      db.prepare("UPDATE memories SET tags = '[\"t\"]' WHERE id = ?").run(ftsId);
      assert.equal(fired(), 2, `${tag}: tag update fires memories_au exactly once`);
      db.prepare('UPDATE memories SET confidence = 0.9 WHERE id = ?').run(ftsId);
      assert.equal(fired(), 2, `${tag}: confidence update must NOT fire memories_au`);
      db.prepare('UPDATE memories SET revision = revision + 1 WHERE id = ?').run(ftsId);
      assert.equal(fired(), 2, `${tag}: direct revision update must NOT fire memories_au`);
    } finally {
      // Restore the pristine installed trigger for everything downstream
      db.exec('DROP TRIGGER memories_au');
      db.exec(installedAu);
      db.exec('DROP TABLE fts_trigger_audit');
    }

    // Index-CONSISTENCY coverage (final state only — not activity proof)
    db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS temp.fts_vocab USING fts5vocab(main, 'memories_fts', 'instance')");
    const hits = (term: string): number =>
      (db.prepare("SELECT COUNT(*) AS n FROM memories_fts WHERE memories_fts MATCH ?").get(term) as { n: number }).n;
    const instances = (term: string): number =>
      (db.prepare('SELECT COUNT(*) AS n FROM temp.fts_vocab WHERE term = ?').get(term) as { n: number }).n;
    assert.equal(hits(`aardwolf${suffix}`), 0, `${tag}: old term absent (consistency)`);
    assert.equal(hits(`quokka${suffix}`), 1, `${tag}: new term present (consistency)`);
    assert.equal(instances(`aardwolf${suffix}`), 0, `${tag}: no stale postings (consistency)`);
    assert.equal(instances(`quokka${suffix}`), 1, `${tag}: single posting instance (consistency)`);
    assert.doesNotThrow(
      () => db.exec("INSERT INTO memories_fts(memories_fts) VALUES('integrity-check')"),
      `${tag}: FTS index agrees with the content table (consistency)`,
    );
  }
  db.pragma('recursive_triggers = OFF');
}

describe('v27 — fresh database', () => {
  let db: Database.Database;
  beforeEach(() => { db = openDatabase({ dbPath: ':memory:' }); });
  afterEach(() => { db.close(); });

  it('behavioral contract holds under both recursive_triggers settings', () => {
    assertV27Behavior(db, 'fresh');
  });

  it('decay and supersession paths bump revision (non-repository writers)', () => {
    // Decay: a 60-day-old fact charges confidence → semantic write → bump
    seed(db, 'decayed', { created_at: iso(60 * DAY) });
    applyConfidenceDecay(db);
    assert.ok(revisionOf(db, 'decayed') > 1, 'decay confidence write bumps revision');

    // Supersession via truth maintenance: an opposing version claim retires
    // the older record (superseded_by write on the OLD row)
    const repo = new MemoryRepository(db);
    const oldRec = repo.create({ content: 'The api gateway runs version 18.1 in production.', kind: 'fact', project: 'v27-proj' });
    const before = revisionOf(db, oldRec.id);
    const newRec = repo.create({ content: 'The api gateway runs version 19.2 in production.', kind: 'fact', project: 'v27-proj' });
    const superseded = (db.prepare('SELECT superseded_by FROM memories WHERE id = ?').get(oldRec.id) as { superseded_by: string | null }).superseded_by;
    assert.equal(superseded, newRec.id, 'precondition: supersession fired');
    assert.ok(revisionOf(db, oldRec.id) > before, 'supersession write bumps the old record');
  });

  it('memory_files: byte-cap CHECK on multibyte content, revision trigger, PK', () => {
    const insert = db.prepare(
      "INSERT INTO memory_files (path, content, created_at, updated_at) VALUES (?, ?, datetime('now'), datetime('now'))");
    // '€' is 3 UTF-8 bytes: 21845 chars = 65535 bytes (fits), 21846 = 65538 (rejected)
    insert.run('/memories/ok.md', '€'.repeat(21845));
    assert.throws(() => insert.run('/memories/too-big.md', '€'.repeat(21846)), /CHECK|constraint/i,
      'byte cap enforced on multibyte content (length(TEXT) would have passed it)');
    assert.throws(() => insert.run('/memories/ok.md', 'x'), /UNIQUE|PRIMARY/i, 'path is the primary key');

    const rev = (): number => (db.prepare("SELECT revision FROM memory_files WHERE path = '/memories/ok.md'").get() as { revision: number }).revision;
    assert.equal(rev(), 1);
    db.prepare("UPDATE memory_files SET content = 'changed' WHERE path = '/memories/ok.md'").run();
    assert.equal(rev(), 2, 'content update bumps memory_files revision');
    db.prepare("UPDATE memory_files SET updated_at = datetime('now') WHERE path = '/memories/ok.md'").run();
    assert.equal(rev(), 2, 'non-content update does not bump');
  });

  it('exact-scope partial index: full ACTIVE predicate and query-plan use', () => {
    const idx = db.prepare(
      "SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_memories_project_kind_active'").get() as { sql: string } | undefined;
    assert.ok(idx, 'idx_memories_project_kind_active present');
    assert.match(idx!.sql, /invalidated = 0 AND superseded_by IS NULL/,
      'active means neither invalidated NOR superseded — both predicates required');

    // INDEXED BY makes SQLite ITSELF verify predicate subsumption: if the
    // exact-scope query could not be served by the partial index (e.g. the
    // WHERE clause didn't imply the index predicate), prepare() throws
    // "no query solution". A plain EXPLAIN check is planner-dependent on
    // an empty table.
    const plan = db.prepare(`
      EXPLAIN QUERY PLAN
      SELECT id FROM memories INDEXED BY idx_memories_project_kind_active
      WHERE project = ? AND kind = ? AND invalidated = 0 AND superseded_by IS NULL
    `).all('v27-proj', 'fact') as Array<{ detail: string }>;
    assert.ok(plan.some(r => r.detail.includes('idx_memories_project_kind_active')),
      `plan under INDEXED BY must name the index; plan: ${plan.map(r => r.detail).join(' | ')}`);
    assert.throws(
      () => db.prepare('SELECT id FROM memories INDEXED BY idx_memories_project_kind_active WHERE project = ?').all('v27-proj'),
      /no query solution/,
      'a query NOT implying the full active predicate cannot use the index — proves the predicate is real',
    );
  });
});

describe('v27 — migration from v26', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cairn-v27-mig-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  /** Build a v26-shaped store: create fresh, strip the v27 surface. */
  function rewindToV26(dbPath: string, mutate?: (db: Database.Database) => void): void {
    const setup = openDatabase({ dbPath });
    seed(setup, 'pre-existing', { content: 'survives migration intact' });
    stripV27Surface(setup);
    setup.prepare('UPDATE schema_version SET version = 26').run();
    mutate?.(setup);
    setup.close();
  }

  it('migrates: backfills revision 1, narrows memories_au, and the full contract holds', () => {
    const dbPath = join(dir, 'store.db');
    rewindToV26(dbPath);
    const db = openDatabase({ dbPath });
    try {
      const version = (db.prepare('SELECT version FROM schema_version').get() as { version: number }).version;
      assert.equal(version, SCHEMA_VERSION);
      assert.equal(revisionOf(db, 'pre-existing'), 1, 'existing rows backfilled to revision 1');
      const au = db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='memories_au'").get() as { sql: string };
      assert.match(au.sql, /AFTER UPDATE OF content, tags/, 'memories_au narrowed by the migration');
      assertV27Behavior(db, 'migrated');
    } finally {
      db.close();
    }
  });

  it('rolls back atomically on a LATE mid-migration failure', () => {
    const dbPath = join(dir, 'store.db');
    // Induce a failure AFTER several migration statements have succeeded:
    // a pre-existing VIEW named memory_files makes CREATE TABLE IF NOT
    // EXISTS no-op, then CREATE TRIGGER ... ON memory_files fails (AFTER
    // UPDATE triggers cannot target a view). By that point the ALTER, the
    // memories_au swap, and the revision trigger have all executed — the
    // rollback must undo every one of them.
    rewindToV26(dbPath, (db) => {
      db.exec('CREATE VIEW memory_files AS SELECT 1 AS x');
    });
    assert.throws(() => openDatabase({ dbPath }), /view|trigger/i, 'migration must fail on the view');
    const raw: Database.Database = new BetterSqlite3(dbPath);
    try {
      const version = (raw.prepare('SELECT version FROM schema_version').get() as { version: number }).version;
      assert.equal(version, 26, 'failed migration leaves schema version unchanged');

      const cols = raw.prepare('PRAGMA table_info(memories)').all() as Array<{ name: string }>;
      assert.ok(!cols.some(c => c.name === 'revision'), 'rollback removed the revision column');

      const revTrigger = raw.prepare(
        "SELECT name FROM sqlite_master WHERE type='trigger' AND name='memories_revision_au'").get();
      assert.equal(revTrigger, undefined, 'rollback removed memories_revision_au');

      const au = raw.prepare(
        "SELECT sql FROM sqlite_master WHERE type='trigger' AND name='memories_au'").get() as { sql: string };
      assert.ok(!/AFTER UPDATE OF/.test(au.sql), 'rollback restored the BROAD v26 memories_au');

      const filesTable = raw.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='memory_files'").get();
      assert.equal(filesTable, undefined, 'no partial memory_files table survives');
    } finally {
      raw.close();
    }
  });
});
