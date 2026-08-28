/**
 * Round-trip format v2 (W4 v3.1 §6) — export→restore field-exact equality
 * over the twelve portable fields into an EMPTY store (all kinds, module
 * fingerprints, multiline context, ##/data:-bearing and fenced content),
 * learn-vs-restore divergence, v1 backward compatibility, and the
 * out-of-scope guarantees (revision restarts, telemetry zeroed,
 * inactive/superseded/task_state rows never export).
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type Database from 'better-sqlite3';
import { openDatabase } from '../src/db/connection.js';
import { MemoryRepository } from '../src/db/memory-repository.js';
import { memoriesWithoutEmbeddings } from '../src/db/memory-repository/reads.js';
import {
  assertPortableFilePath, buildFileSection, buildRecordSection, canonicalJson,
  parseExportDocument, validateFingerprintShape, validateRecordPayload,
  type PortableRecord,
} from '../src/memory-tool/round-trip.js';
import { getEmbeddingModelConfig } from '../src/utils/embeddings.js';

let db: Database.Database;
let repo: MemoryRepository;
beforeEach(() => {
  db = openDatabase({ dbPath: ':memory:' });
  repo = new MemoryRepository(db);
});
afterEach(() => { db.close(); });

const uid = (n: number): string => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;

function seedRow(row: Record<string, unknown>): void {
  db.prepare(`
    INSERT INTO memories (id, content, kind, project, tags, confidence, source, created_at,
                          expires_at, fingerprint, context, anchor,
                          recall_count, invalidated, surface_count, impact_count, last_recalled)
    VALUES (@id, @content, @kind, @project, @tags, @confidence, @source, @created_at,
            @expires_at, @fingerprint, @context, @anchor,
            @recall_count, @invalidated, @surface_count, @impact_count, @last_recalled)
  `).run({
    project: null, tags: '[]', confidence: 0.6, source: 'learned',
    created_at: '2026-01-02T03:04:05.000Z', expires_at: null, fingerprint: null,
    context: null, anchor: null, recall_count: 0, invalidated: 0,
    surface_count: 0, impact_count: 0, last_recalled: null, ...row,
  });
}

/** Hostile corpus: every learnable kind, delimiter-bearing content,
 *  multiline context, module fingerprint arrays, unicode scope. */
const HOSTILE = '## fake heading\ndata: {"x":1}\n```ts\nconst a = 1;\n```\nplain tail';
function seedHostileCorpus(): void {
  const kinds = ['pitfall', 'decision', 'correction', 'fact', 'user_profile', 'reference', 'pattern', 'goal'];
  kinds.forEach((kind, i) => {
    seedRow({
      id: uid(i + 1),
      kind,
      content: `${kind} record ${i}: ${HOSTILE}`,
      project: kind === 'user_profile' ? null : 'proj-α',
      tags: JSON.stringify([`tag-${i}`, 'shared']),
      confidence: 0.5 + i * 0.05,
      source: 'corrected',
      created_at: `2026-01-0${(i % 8) + 1}T03:04:05.000Z`,
      expires_at: i % 2 === 0 ? '2027-06-01T00:00:00.000Z' : null,
      fingerprint: JSON.stringify({ framework: ['react'], lang: ['ts'], module: [`src/m${i}.ts`, 'src/shared.ts'] }),
      context: JSON.stringify({ why: `multi\nline\nwhy ${i}`, how_to_apply: `apply\nacross lines ${i}` }),
      anchor: JSON.stringify({ file: `src/m${i}.ts`, line: i + 1 }),
      recall_count: 7 + i, surface_count: 3, impact_count: 2,
      last_recalled: '2026-02-01T00:00:00.000Z',
    });
  });
}

describe('canonical JSON', () => {
  it('sorts object keys recursively and drops undefined values', () => {
    assert.equal(
      canonicalJson({ b: 1, a: { d: [2, { z: 1, y: null }], c: 'x' }, skip: undefined }),
      '{"a":{"c":"x","d":[2,{"y":null,"z":1}]},"b":1}',
    );
  });
});

describe('export→restore field-exact equality (empty target store)', () => {
  it('reproduces the twelve portable fields for every kind and hostile shape', () => {
    seedHostileCorpus();
    const exported = repo.exportPortable();
    assert.equal(exported.length, 8, 'all eight learnable kinds export');

    const text = exported.flatMap(r => [...buildRecordSection(r), '']).join('\n');
    const parsed = parseExportDocument(text);
    assert.deepEqual(parsed.errors, []);
    assert.equal(parsed.records.length, 8);

    const target = openDatabase({ dbPath: ':memory:' });
    try {
      const targetRepo = new MemoryRepository(target);
      for (const record of parsed.records) {
        assert.equal(targetRepo.restore(record as PortableRecord & { id: string }), 'inserted');
      }
      // Field-exact over exactly the enumerated portable set.
      assert.equal(canonicalJson(targetRepo.exportPortable()), canonicalJson(exported));

      // Out-of-scope by contract: revision restarts, telemetry zeroed.
      const stats = target.prepare(`
        SELECT MAX(revision) AS rev, MAX(recall_count) AS rc, MAX(surface_count) AS sc,
               MAX(impact_count) AS ic, COUNT(last_recalled) AS lr
        FROM memories
      `).get() as { rev: number; rc: number; sc: number; ic: number; lr: number };
      assert.deepEqual(stats, { rev: 1, rc: 0, sc: 0, ic: 0, lr: 0 });
    } finally {
      target.close();
    }
  });

  it('round-trips fenced free-form files through File sections', () => {
    const file = { path: '/memories/notes/guide.md', content: '# Guide\n```bash\nrm -rf ./dist\n```\n## data: not a payload', revision: 4 };
    const text = buildFileSection(file).join('\n');
    const parsed = parseExportDocument(text);
    assert.deepEqual(parsed.errors, []);
    assert.equal(parsed.records.length, 0);
    assert.deepEqual(parsed.files, [file]);

    repo.restoreFile(parsed.files[0]);
    const row = db.prepare('SELECT content, revision FROM memory_files WHERE path = ?').get(file.path) as { content: string; revision: number };
    assert.equal(row.content, file.content);
    assert.equal(row.revision, 1, 'file revision restarts — out of the portable contract');
  });

  it('restore overwrites an existing id in place and reactivates it', () => {
    seedRow({ id: uid(1), kind: 'fact', content: 'original content here', invalidated: 1 });
    const outcome = repo.restore({
      id: uid(1), kind: 'fact', content: 'restored replacement content', confidence: 0.7,
      source: 'user', tags: ['restored'], context: null, fingerprint: null,
      project: 'proj-r', expires_at: null, anchor: null, created_at: '2026-03-01T00:00:00.000Z',
    });
    assert.equal(outcome, 'updated');
    const row = db.prepare('SELECT content, project, invalidated FROM memories WHERE id = ?').get(uid(1)) as { content: string; project: string; invalidated: number };
    assert.deepEqual(row, { content: 'restored replacement content', project: 'proj-r', invalidated: 0 });
  });
});

describe('learn vs restore divergence', () => {
  const payload = (id: string): PortableRecord & { id: string } => ({
    id, kind: 'fact', content: 'the ingestion pipeline batches records every five minutes',
    confidence: 0.9, source: 'learned', tags: ['pipeline'], context: null, fingerprint: null,
    project: null, expires_at: null, anchor: null, created_at: '2026-01-01T00:00:00.000Z',
  });

  it('learn merges into the existing record; restore reproduces a distinct exact row', () => {
    const first = repo.create({ content: payload(uid(1)).content, kind: 'fact', project: null, confidence: 0.6 });

    // learn: same content → dedup/merge, no new row, confidence boosted.
    const learned = repo.create({ content: payload(uid(1)).content, kind: 'fact', project: null });
    assert.equal(learned.deduplicated, true);
    assert.equal(learned.id, first.id);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number }).n, 1);
    const boosted = (db.prepare('SELECT confidence FROM memories WHERE id = ?').get(first.id) as { confidence: number }).confidence;
    assert.ok(boosted > 0.6, 'learn mode boosts confidence on merge');

    // restore: same content, explicit id → id-preserving new row, no merge,
    // no boost, field-exact.
    assert.equal(repo.restore(payload(uid(9))), 'inserted');
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number }).n, 2);
    const restored = db.prepare('SELECT confidence, source FROM memories WHERE id = ?').get(uid(9)) as { confidence: number; source: string };
    assert.deepEqual(restored, { confidence: 0.9, source: 'learned' });
  });
});

describe('export scope and parser strictness', () => {
  it('never exports invalidated, superseded, or task_state rows', () => {
    seedRow({ id: uid(1), kind: 'fact', content: 'active exportable record' });
    seedRow({ id: uid(2), kind: 'fact', content: 'invalidated record', invalidated: 1 });
    seedRow({ id: uid(3), kind: 'fact', content: 'superseded record' });
    db.prepare('UPDATE memories SET superseded_by = ? WHERE id = ?').run(uid(1), uid(3));
    seedRow({ id: uid(4), kind: 'task_state', content: 'ephemeral task state' });

    const exported = repo.exportPortable();
    assert.deepEqual(exported.map(r => r.id), [uid(1)]);
  });

  it('splits mixed documents: v2 by payload, v1 remainder to the legacy parser', () => {
    const text = [
      '# Cairn Export v2',
      `## Fact: mixed doc [confidence: 0.80]`,
      `data: ${canonicalJson({ kind: 'fact', content: 'v2 half of the mixed document', confidence: 0.8, source: 'learned', tags: [], context: null, fingerprint: null, project: null, expires_at: null, anchor: null, created_at: '2026-01-01T00:00:00.000Z' })}`,
      '',
      '## Pitfall: legacy section heading',
      'tags: legacy',
      'v1 half of the mixed document.',
    ].join('\n');
    const parsed = parseExportDocument(text);
    assert.equal(parsed.records.length, 1);
    assert.equal(parsed.records[0].id, undefined, 'v2 record without id parses (learn-mode legal)');
    assert.match(parsed.v1Markdown ?? '', /## Pitfall: legacy section heading/);
    assert.match(parsed.v1Markdown ?? '', /v1 half of the mixed document\./);
    assert.deepEqual(parsed.errors, []);
  });

  it('a malformed v2 payload is an error — never silently reparsed as v1', () => {
    const parsed = parseExportDocument('## Fact: broken [confidence: 0.50]\ndata: {not json at all');
    assert.equal(parsed.records.length, 0);
    assert.equal(parsed.v1Markdown, null);
    assert.equal(parsed.errors.length, 1);
  });

  it('file restore enforces the VFS boundary — only exact canonical free-form paths', () => {
    const hostile: Array<[string, RegExp]> = [
      ['/memories/global/facts.md', /materialized paths are reserved/],
      ['/memories/p-4KC_/plan.md', /materialized paths are reserved/],
      ['/memories/global', /directory paths are reserved/],
      ['/memories', /root paths are reserved/],
      ['/memories/../escape.md', /invalid path/],
      ['/memories/%2e%2e%2fescape.md', /invalid path/],
      ['/memories//notes/alias.md', /not canonical/],
      ['/tmp/outside.md', /invalid path/],
    ];
    for (const [path, pattern] of hostile) {
      assert.throws(() => assertPortableFilePath(path), pattern, `path ${path} must reject`);
      // Parse-level: a File section with this path is a section ERROR.
      const parsed = parseExportDocument(`## File: ${path}\ndata: ${canonicalJson({ path, content: 'x', revision: 1 })}`);
      assert.equal(parsed.files.length, 0, `File section for ${path} must not parse`);
      assert.equal(parsed.errors.length, 1);
      // Write-level: the facade rejects with zero writes.
      assert.throws(() => repo.restoreFile({ path, content: 'x', revision: 1 }), pattern);
    }
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM memory_files').get() as { n: number }).n, 0, 'no hostile path may write');
    assertPortableFilePath('/memories/notes/legit.md'); // exact canonical free-form passes
  });

  it('restore overwrite clears the stale embedding — the row becomes a backfill candidate', () => {
    const activeModel = getEmbeddingModelConfig().key;
    seedRow({ id: uid(1), kind: 'fact', content: 'original embedded content' });
    db.prepare('UPDATE memories SET embedding = ?, embedding_model = ? WHERE id = ?')
      .run(Buffer.alloc(1536, 1), activeModel, uid(1));
    assert.equal(memoriesWithoutEmbeddings(db, 10).length, 0, 'freshly embedded row is not a candidate');

    repo.restore({
      id: uid(1), kind: 'fact', content: 'replacement content needing a new vector', confidence: 0.7,
      source: 'user', tags: [], context: null, fingerprint: null,
      project: null, expires_at: null, anchor: null, created_at: '2026-03-01T00:00:00.000Z',
    });
    const row = db.prepare('SELECT embedding, embedding_model FROM memories WHERE id = ?').get(uid(1)) as { embedding: Buffer | null; embedding_model: string | null };
    assert.equal(row.embedding, null, 'stale vector must not describe the new content');
    assert.equal(row.embedding_model, null);
    assert.deepEqual(memoriesWithoutEmbeddings(db, 10).map(m => m.id), [uid(1)], 'restored row must be a backfill candidate');
  });

  it('restoreDocument is atomic — a late file-cap failure rolls back the records', () => {
    const record: PortableRecord & { id: string } = {
      id: uid(1), kind: 'fact', content: 'record that must not survive the rollback', confidence: 0.5,
      source: 'learned', tags: [], context: null, fingerprint: null,
      project: null, expires_at: null, anchor: null, created_at: '2026-01-01T00:00:00.000Z',
    };
    const oversized = { path: '/memories/notes/big.md', content: 'x'.repeat(65_537), revision: 1 };
    assert.throws(() => repo.restoreAll([record], [oversized]), /64KB memory-file limit/);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number }).n, 0, 'record write must roll back');
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM memory_files').get() as { n: number }).n, 0);
  });

  it('corrupt stored JSON fails the export with the record id and field name', () => {
    seedRow({ id: uid(1), kind: 'fact', content: 'row with corrupt tags', tags: 'not json {' });
    assert.throws(() => repo.exportPortable(), new RegExp(`record ${uid(1)}: stored tags is corrupt JSON`));
    db.prepare('DELETE FROM memories').run();

    seedRow({ id: uid(2), kind: 'fact', content: 'row with corrupt context', context: '{broken' });
    assert.throws(() => repo.exportPortable(), new RegExp(`record ${uid(2)}: stored context is corrupt JSON`));
    db.prepare('DELETE FROM memories').run();

    seedRow({ id: uid(3), kind: 'fact', content: 'row with misshapen fingerprint', fingerprint: '{"lang":"ts"}' });
    assert.throws(() => repo.exportPortable(), new RegExp(`record ${uid(3)}: fingerprint\\.lang must be an array of strings`));
  });

  it('fingerprints require own lang/framework/module facets, each an array of strings', () => {
    const complete = { lang: ['ts'], framework: [], module: ['src/a.ts'] };
    validateFingerprintShape(complete, 'fingerprint');
    validateFingerprintShape({ ...complete, future_facet: ['x'] }, 'fingerprint');
    validateFingerprintShape(null, 'fingerprint');

    assert.throws(() => validateFingerprintShape({}, 'fingerprint'), /fingerprint\.lang is required/);
    assert.throws(() => validateFingerprintShape({ lang: [], framework: [] }, 'fingerprint'), /fingerprint\.module is required/);
    assert.throws(() => validateFingerprintShape({ lang: [], module: [] }, 'fingerprint'), /fingerprint\.framework is required/);
    // Inherited facets must NOT satisfy the requirement.
    const inherited = Object.create({ lang: ['ts'] }) as Record<string, unknown>;
    inherited.framework = [];
    inherited.module = [];
    assert.throws(() => validateFingerprintShape(inherited, 'fingerprint'), /fingerprint\.lang is required/);
    // A {} payload must reject at parse too — it used to crash consumers.
    assert.throws(
      () => validateRecordPayload({ kind: 'fact', content: 'c', confidence: 0.5, source: 'learned', tags: [], context: null, fingerprint: {}, project: null, expires_at: null, anchor: null, created_at: 'x' }),
      /fingerprint\.lang is required/,
    );
  });

  it('active rows with corrupt non-JSON portable fields fail the export with the record id', () => {
    seedRow({ id: uid(1), kind: 'fact', content: 'row with null source', source: null });
    assert.throws(() => repo.exportPortable(), new RegExp(`record ${uid(1)}: unsupported source null`));
    db.prepare('DELETE FROM memories').run();

    // NULL confidence must fail VISIBLY on an unfiltered export — not be
    // silently swallowed by a SQL confidence predicate.
    seedRow({ id: uid(2), kind: 'fact', content: 'row with null confidence', confidence: null });
    assert.throws(() => repo.exportPortable(), new RegExp(`record ${uid(2)}: confidence must be a number in \\[0, 1\\]`));
    db.prepare('DELETE FROM memories').run();

    seedRow({ id: uid(3), kind: 'fact', content: 'row with out-of-range confidence', confidence: 1.5 });
    assert.throws(() => repo.exportPortable(), new RegExp(`record ${uid(3)}: confidence must be a number in \\[0, 1\\]`));
    db.prepare('DELETE FROM memories').run();

    seedRow({ id: uid(4), kind: 'fact', content: '' });
    assert.throws(() => repo.exportPortable(), new RegExp(`record ${uid(4)}: content must be a non-empty string`));
    db.prepare('DELETE FROM memories').run();

    // An EXPLICIT confidence filter still excludes rows in SQL (no error).
    seedRow({ id: uid(5), kind: 'fact', content: 'weak but well-formed row', confidence: 0.1 });
    assert.deepEqual(repo.exportPortable({ minConfidence: 0.5 }), []);
  });

  it('invariant: a successful export reparses with zero errors', () => {
    seedHostileCorpus();
    repo.restoreFile({ path: '/memories/notes/invariant.md', content: '# body\n```\nfenced\n```', revision: 1 });
    const records = repo.exportPortable();
    const files = repo.exportPortableFiles();
    const text = [
      ...records.flatMap(r => [...buildRecordSection(r), '']),
      ...files.flatMap(f => [...buildFileSection(f), '']),
    ].join('\n');
    const parsed = parseExportDocument(text);
    assert.deepEqual(parsed.errors, [], 'an emitted document must reparse cleanly');
    assert.equal(parsed.records.length, records.length);
    assert.equal(parsed.files.length, files.length);
  });

  it('rejects payloads violating the portable field contract', () => {
    const base = { kind: 'fact', content: 'c', confidence: 0.5, source: 'learned', tags: [], context: null, fingerprint: null, project: null, expires_at: null, anchor: null, created_at: 'x' };
    assert.throws(() => validateRecordPayload({ ...base, kind: 'task_state' }), /unsupported kind/);
    assert.throws(() => validateRecordPayload({ ...base, id: 'ABCDEF01-0000-4000-8000-000000000000' }), /canonical lowercase UUID/);
    assert.throws(() => validateRecordPayload({ ...base, confidence: 1.5 }), /confidence must be a number in \[0, 1\]/);
    assert.throws(() => validateRecordPayload({ ...base, source: 'imagined' }), /unsupported source/);
    assert.throws(() => validateRecordPayload({ ...base, tags: 'solo' }), /tags must be an array of strings/);
  });
});
