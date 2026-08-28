/**
 * Schema v26 embedding-model isolation (roadmap W2 slice 2) — every vector
 * WRITE stamps the active model, every vector READ filters on it, the
 * backfill query selects mismatched rows for re-embedding, the migration
 * backfills pre-v26 vectors as minilm-l6, and the context-vector worker
 * discards (never blends) a stale-model rolling vector. No model downloads —
 * synthetic vectors + injected embed fns only.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { openDatabase } from '../src/db/connection.js';
import { stripV27Surface } from './helpers/schema-rewind.js';
import { MemoryRepository } from '../src/db/memory-repository.js';
import { buildEmbeddingSimilarityMap } from '../src/db/maintenance.js';
import { vectorSearch } from '../src/db/memory-repository/vector-search.js';
import { processContextVectors } from '../src/mcp/context-vector-worker.js';
import { embeddingToBuffer, getEmbeddingModelConfig } from '../src/utils/embeddings.js';

const ACTIVE = getEmbeddingModelConfig().key; // 'minilm-l6' in tests
const FOREIGN = 'nomic-v1.5';
const DIM = getEmbeddingModelConfig().dim;

function vec(seed: number): Buffer {
  const v = new Float32Array(DIM);
  for (let i = 0; i < DIM; i++) v[i] = Math.sin(seed * (i + 1) * 0.1);
  let norm = 0;
  for (let i = 0; i < DIM; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm);
  for (let i = 0; i < DIM; i++) v[i] /= norm;
  return embeddingToBuffer(v);
}

let db: Database.Database;
let repo: MemoryRepository;

beforeEach(() => {
  db = openDatabase({ dbPath: ':memory:' });
  repo = new MemoryRepository(db);
});

afterEach(() => {
  db.close();
});

const modelOf = (id: string): string | null =>
  (db.prepare('SELECT embedding_model FROM memories WHERE id = ?').get(id) as { embedding_model: string | null }).embedding_model;

describe('v26 writes — every embedding write stamps the active model', () => {
  it('create() with embedding stamps; without embedding leaves NULL', () => {
    const withEmb = repo.create({ content: 'stamped on create', kind: 'fact', embedding: vec(1), skipDedup: true });
    const without = repo.create({ content: 'no embedding here', kind: 'fact', skipDedup: true });
    assert.equal(modelOf(withEmb.id), ACTIVE);
    assert.equal(modelOf(without.id), null);
  });

  it('storeEmbedding() stamps (the backfill write path)', () => {
    const m = repo.create({ content: 'backfilled later', kind: 'fact', skipDedup: true });
    assert.equal(modelOf(m.id), null);
    repo.storeEmbedding(m.id, vec(2));
    assert.equal(modelOf(m.id), ACTIVE);
  });
});

describe('v26 reads — vector search sees only active-model vectors', () => {
  it('vectorSearch excludes foreign-model rows in the sqlite-vec path', () => {
    const active = repo.create({ content: 'alpha kayak sunrise', kind: 'fact', embedding: vec(1), skipDedup: true });
    const foreign = repo.create({ content: 'omega glacier moonlight', kind: 'fact', embedding: vec(1), skipDedup: true });
    db.prepare('UPDATE memories SET embedding_model = ? WHERE id = ?').run(FOREIGN, foreign.id);

    const ids = vectorSearch(db, vec(1), {}, 10);
    assert.ok(ids.includes(active.id), 'active-model vector retrieved');
    assert.ok(!ids.includes(foreign.id), 'foreign-model vector filtered out');
  });

  it('searchByProxyEmbedding returns nothing for a foreign-model proxy', () => {
    const proxy = repo.create({ content: 'proxy memory anchor', kind: 'fact', embedding: vec(3), skipDedup: true });
    repo.create({ content: 'distant beacon flare', kind: 'fact', embedding: vec(3), skipDedup: true });
    db.prepare('UPDATE memories SET embedding_model = ? WHERE id = ?').run(FOREIGN, proxy.id);

    const results = repo.searchByProxyEmbedding(proxy.id, new Set());
    assert.equal(results.length, 0, 'stale-model proxy embedding is unusable');
  });

  it('consolidation similarity map skips pairs with a foreign-model side', () => {
    const a = repo.create({ content: 'violet harbor lanterns', kind: 'fact', embedding: vec(4), skipDedup: true });
    const b = repo.create({ content: 'copper meadow thunder', kind: 'fact', embedding: vec(4), skipDedup: true });
    const c = repo.create({ content: 'ivory canyon whispers', kind: 'fact', embedding: vec(4), skipDedup: true });
    db.prepare('UPDATE memories SET embedding_model = ? WHERE id = ?').run(FOREIGN, c.id);

    const memories = [a.id, b.id, c.id].map(id => repo.findById(id)!);
    const map = buildEmbeddingSimilarityMap(db, memories);
    const key = (x: string, y: string): string => (x < y ? `${x}:${y}` : `${y}:${x}`);
    assert.ok(map.has(key(a.id, b.id)), 'active-model pair compared');
    assert.ok(!map.has(key(a.id, c.id)), 'foreign-model side never compared');
    assert.ok(!map.has(key(b.id, c.id)));
  });
});

describe('v26 backfill — mismatched rows are re-embedding candidates', () => {
  it('memoriesWithoutEmbeddings selects null-embedding and foreign-model rows, not active ones', () => {
    const current = repo.create({ content: 'saffron orbit dune', kind: 'fact', embedding: vec(5), skipDedup: true });
    const none = repo.create({ content: 'quartz ripple ember', kind: 'fact', skipDedup: true });
    const foreign = repo.create({ content: 'jade summit drizzle', kind: 'fact', embedding: vec(6), skipDedup: true });
    db.prepare('UPDATE memories SET embedding_model = ? WHERE id = ?').run(FOREIGN, foreign.id);

    const ids = repo.memoriesWithoutEmbeddings(10).map(r => r.id);
    assert.ok(ids.includes(none.id), 'null-embedding row queued');
    assert.ok(ids.includes(foreign.id), 'foreign-model row queued for re-embed');
    assert.ok(!ids.includes(current.id), 'active-model row not re-embedded');
  });
});

describe('v26 migration — pre-v26 vectors backfilled as minilm-l6', () => {
  it('adds columns and stamps existing vectors on upgrade from a v25 store', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cairn-v26-migration-'));
    const dbPath = join(dir, 'store.db');
    try {
      // Build a v26 store, then rewind it to v25 shape (drop the new
      // columns, reset the version) so reopening exercises the migration.
      const setup = openDatabase({ dbPath });
      const repoSetup = new MemoryRepository(setup);
      const withVec = repoSetup.create({ content: 'maple comet lagoon', kind: 'fact', embedding: vec(7), skipDedup: true });
      const noVec = repoSetup.create({ content: 'cobalt prairie echo', kind: 'fact', skipDedup: true });
      stripV27Surface(setup);
      setup.exec('ALTER TABLE memories DROP COLUMN embedding_model');
      setup.exec('ALTER TABLE context_vectors DROP COLUMN embedding_model');
      setup.prepare("INSERT INTO context_vectors (project, embedding, updated_at) VALUES ('proj', ?, datetime('now'))").run(vec(8));
      setup.prepare('UPDATE schema_version SET version = 25').run();
      setup.close();

      const migrated = openDatabase({ dbPath });
      try {
        const rowWith = migrated.prepare('SELECT embedding_model FROM memories WHERE id = ?').get(withVec.id) as { embedding_model: string | null };
        const rowWithout = migrated.prepare('SELECT embedding_model FROM memories WHERE id = ?').get(noVec.id) as { embedding_model: string | null };
        const ctx = migrated.prepare("SELECT embedding_model FROM context_vectors WHERE project = 'proj'").get() as { embedding_model: string | null };
        assert.equal(rowWith.embedding_model, 'minilm-l6', 'pre-v26 vector stamped as minilm-l6');
        assert.equal(rowWithout.embedding_model, null, 'vector-less row stays NULL');
        assert.equal(ctx.embedding_model, 'minilm-l6', 'context vector stamped too');
      } finally {
        migrated.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('v26 dedup + merge + edge paths — foreign vectors never compared, always replaced', () => {
  it('identical bytes under a foreign model tag cannot cause embedding-only dedup', () => {
    // Shares exactly one token ('zenith') — an FTS candidate, but far below
    // the token-overlap dedup threshold, so only the cosine path could
    // merge. Identical vector bytes under a FOREIGN tag must not.
    const existing = repo.create({ content: 'zenith crater bloom emberfall', kind: 'fact', embedding: vec(1), skipDedup: true });
    db.prepare('UPDATE memories SET embedding_model = ? WHERE id = ?').run(FOREIGN, existing.id);

    const incoming = repo.create({ content: 'zenith orchard tide moonpetal', kind: 'fact', embedding: vec(1) });
    assert.equal(incoming.deduplicated, false, 'foreign-tagged candidate must not cosine-dedup');
    assert.notEqual(incoming.id, existing.id);
    assert.equal(modelOf(existing.id), FOREIGN, 'foreign row untouched');
    assert.equal(modelOf(incoming.id), ACTIVE);

    // Positive control — the SAME setup with an active-model candidate DOES
    // cosine-dedup, proving this test exercises the embedding path.
    const activeCand = repo.create({ content: 'quiver lantern zephyrine dusk', kind: 'fact', embedding: vec(2), skipDedup: true });
    const dup = repo.create({ content: 'quiver harvest brimstone glow', kind: 'fact', embedding: vec(2) });
    assert.equal(dup.deduplicated, true, 'active-model identical vector still dedups');
    assert.equal(dup.id, activeCand.id);
  });

  it('getEmbedding() returns null for a foreign-model row (cross-kind edges cannot compare it)', () => {
    const m = repo.create({ content: 'lattice pigment aurora', kind: 'fact', embedding: vec(3), skipDedup: true });
    assert.ok(repo.getEmbedding(m.id), 'active-model embedding readable');
    db.prepare('UPDATE memories SET embedding_model = ? WHERE id = ?').run(FOREIGN, m.id);
    assert.equal(repo.getEmbedding(m.id), null, 'foreign-model embedding is not comparable');
  });

  it('smart merge replaces a foreign embedding with the incoming active one', () => {
    const first = repo.storePitfall({ content: 'always sanitize shell arguments before exec', project: null, embedding: vec(4) });
    db.prepare('UPDATE memories SET embedding_model = ? WHERE id = ?').run(FOREIGN, first.id);

    const merged = repo.storePitfall({ content: 'always sanitize shell arguments before spawn', project: null, embedding: vec(5) });
    assert.equal(merged.deduplicated, true, 'token overlap merges into the existing row');
    assert.equal(merged.id, first.id);

    const row = db.prepare('SELECT embedding, embedding_model FROM memories WHERE id = ?').get(first.id) as { embedding: Buffer; embedding_model: string };
    assert.equal(row.embedding_model, ACTIVE, 'foreign tag replaced by active model');
    assert.deepEqual([...row.embedding], [...vec(5)], 'incoming active vector stored, stale bytes gone');
  });
});

describe('v26 context-vector worker — stale-model vectors discarded, never blended', () => {
  const fresh = (): Float32Array => {
    const v = new Float32Array(DIM);
    v[0] = 1;
    return v;
  };
  const deps = { embedQueryText: async () => fresh(), isReady: () => true };

  it('same-model previous vector is blended; result stays stamped', async () => {
    db.prepare(`INSERT INTO context_vectors (project, embedding, embedding_model, pending_prompt, updated_at)
                VALUES ('proj', ?, ?, 'new prompt', datetime('now'))`).run(vec(9), ACTIVE);
    await processContextVectors(db, new Map(), deps);
    const row = db.prepare("SELECT embedding, embedding_model, pending_prompt FROM context_vectors WHERE project = 'proj'")
      .get() as { embedding: Buffer; embedding_model: string; pending_prompt: string | null };
    assert.equal(row.embedding_model, ACTIVE);
    assert.equal(row.pending_prompt, null, 'pending prompt consumed');
    assert.notDeepEqual([...new Float32Array(row.embedding.buffer, row.embedding.byteOffset, DIM)].slice(0, 2),
      [...fresh()].slice(0, 2), 'previous vector contributed (blended, not replaced)');
  });

  it('foreign-model previous vector is discarded — fresh embedding wins outright', async () => {
    db.prepare(`INSERT INTO context_vectors (project, embedding, embedding_model, pending_prompt, updated_at)
                VALUES ('proj', ?, ?, 'new prompt', datetime('now'))`).run(vec(9), FOREIGN);
    await processContextVectors(db, new Map(), deps);
    const row = db.prepare("SELECT embedding, embedding_model FROM context_vectors WHERE project = 'proj'")
      .get() as { embedding: Buffer; embedding_model: string };
    assert.equal(row.embedding_model, ACTIVE, 're-stamped to the active model');
    const stored = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, DIM);
    assert.deepEqual([...stored], [...fresh()], 'stale vector contributed nothing');
  });
});
