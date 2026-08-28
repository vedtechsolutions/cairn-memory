/**
 * Tier 1 Foundation tests — schema v10, embeddings, hybrid search, edges, consolidation.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, isSqliteVecAvailable } from '../src/db/connection.js';
import { MemoryRepository } from '../src/db/memory-repository.js';
import { EdgeRepository } from '../src/db/edge-repository.js';
import { cosineSimilarity } from '../src/utils/similarity.js';
import { findConsolidationCandidates, computeAffinity, mergedConfidence, mergedTags } from '../src/utils/consolidation.js';
import { embeddingToBuffer, bufferToEmbedding, getEmbeddingModelConfig } from '../src/utils/embeddings.js';
import { runConsolidation } from '../src/db/maintenance.js';
import type Database from 'better-sqlite3';
import type { Memory } from '../src/db/memory-repository.js';

const EMBEDDING_DIM = getEmbeddingModelConfig().dim;

let db: Database.Database;
let repo: MemoryRepository;
let edgeRepo: EdgeRepository;

beforeEach(() => {
  db = openDatabase({ dbPath: ':memory:' });
  repo = new MemoryRepository(db);
  edgeRepo = new EdgeRepository(db);
});

afterEach(() => {
  db.close();
});

// --- Schema v10 -----------------------------------------------------------

describe('Schema v10', () => {
  it('should have embedding column on memories table', () => {
    const columns = db.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>;
    const names = columns.map(c => c.name);
    assert.ok(names.includes('embedding'), 'memories table should have embedding column');
  });

  it('should have memory_edges table', () => {
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='memory_edges'"
    ).all();
    assert.equal(tables.length, 1, 'memory_edges table should exist');
  });

  it('should have edge indexes', () => {
    const indexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_edges_%'"
    ).all() as Array<{ name: string }>;
    assert.ok(indexes.length >= 3, `Should have 3+ edge indexes, got ${indexes.length}`);
  });

  it('should store current schema version', () => {
    const row = db.prepare('SELECT version FROM schema_version').get() as { version: number };
    assert.ok(row.version >= 10, `schema version should be >= 10, got ${row.version}`);
  });
});

// --- Embedding Storage -----------------------------------------------------

describe('Embedding Storage', () => {
  it('should store and retrieve embedding as BLOB', () => {
    const emb = new Float32Array(EMBEDDING_DIM);
    emb[0] = 0.5; emb[1] = -0.3; emb[383] = 0.99;
    const buf = embeddingToBuffer(emb);

    const result = repo.create({
      content: 'test with embedding',
      kind: 'fact',
      embedding: buf,
    });

    const row = db.prepare('SELECT embedding FROM memories WHERE id = ?').get(result.id) as { embedding: Buffer };
    assert.ok(row.embedding, 'embedding should be stored');
    assert.equal(row.embedding.length, EMBEDDING_DIM * 4, 'embedding should be 384 * 4 bytes');

    const recovered = bufferToEmbedding(row.embedding);
    assert.ok(Math.abs(recovered[0] - 0.5) < 0.001, 'first value should be ~0.5');
    assert.ok(Math.abs(recovered[383] - 0.99) < 0.001, 'last value should be ~0.99');
  });

  it('should store null embedding by default', () => {
    const result = repo.create({ content: 'no embedding', kind: 'fact' });
    const row = db.prepare('SELECT embedding FROM memories WHERE id = ?').get(result.id) as { embedding: Buffer | null };
    assert.equal(row.embedding, null);
  });

  it('should update embedding via storeEmbedding()', () => {
    const result = repo.create({ content: 'initially no embedding', kind: 'fact' });

    const emb = new Float32Array(EMBEDDING_DIM);
    emb[0] = 1.0;
    const ok = repo.storeEmbedding(result.id, embeddingToBuffer(emb));
    assert.ok(ok, 'storeEmbedding should succeed');

    const row = db.prepare('SELECT embedding FROM memories WHERE id = ?').get(result.id) as { embedding: Buffer };
    assert.ok(row.embedding, 'embedding should be stored');
  });

  it('should list memories without embeddings', () => {
    repo.create({ content: 'has embedding', kind: 'fact', embedding: embeddingToBuffer(new Float32Array(EMBEDDING_DIM)) });
    repo.create({ content: 'no embedding 1', kind: 'fact' });
    repo.create({ content: 'no embedding 2', kind: 'decision' });

    const without = repo.memoriesWithoutEmbeddings(10);
    assert.equal(without.length, 2, 'should find 2 memories without embeddings');
  });
});

// --- Cosine Similarity -----------------------------------------------------

describe('Cosine Similarity', () => {
  it('should return 1 for identical vectors', () => {
    const a = new Float32Array([1, 2, 3]);
    assert.ok(Math.abs(cosineSimilarity(a, a) - 1.0) < 0.001);
  });

  it('should return 0 for orthogonal vectors', () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([0, 1, 0]);
    assert.ok(Math.abs(cosineSimilarity(a, b)) < 0.001);
  });

  it('should return ~-1 for opposite vectors', () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([-1, 0, 0]);
    assert.ok(Math.abs(cosineSimilarity(a, b) - (-1.0)) < 0.001);
  });

  it('should handle zero vectors gracefully', () => {
    const a = new Float32Array([0, 0, 0]);
    const b = new Float32Array([1, 2, 3]);
    assert.equal(cosineSimilarity(a, b), 0);
  });
});

// --- sqlite-vec Integration ------------------------------------------------

describe('sqlite-vec', () => {
  it('should load sqlite-vec extension', () => {
    assert.ok(isSqliteVecAvailable(), 'sqlite-vec should be loaded');
  });

  it('should compute vec_distance_cosine in SQL', () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([0, 1, 0]);
    const bufA = Buffer.from(a.buffer);
    const bufB = Buffer.from(b.buffer);

    const row = db.prepare('SELECT vec_distance_cosine(?, ?) as d').get(bufA, bufB) as { d: number };
    assert.ok(Math.abs(row.d - 1.0) < 0.001, 'orthogonal distance should be ~1');
  });
});

// --- Hybrid Search ---------------------------------------------------------

describe('Hybrid Search', () => {
  function makeEmbedding(seed: number): Buffer {
    const emb = new Float32Array(EMBEDDING_DIM);
    for (let i = 0; i < EMBEDDING_DIM; i++) {
      emb[i] = Math.sin(seed * (i + 1) * 0.1);
    }
    // Normalize
    let norm = 0;
    for (let i = 0; i < EMBEDDING_DIM; i++) norm += emb[i] * emb[i];
    norm = Math.sqrt(norm);
    for (let i = 0; i < EMBEDDING_DIM; i++) emb[i] /= norm;
    return embeddingToBuffer(emb);
  }

  it('should find results via keyword match (FTS path)', () => {
    repo.create({ content: 'always validate user input before processing', kind: 'pitfall' });
    repo.create({ content: 'use connection pooling for databases', kind: 'fact' });

    const results = repo.recallHybrid('validate user input', null, { maxResults: 5 });
    assert.ok(results.length >= 1, 'should find at least 1 result via FTS');
    assert.ok(results[0].memory.content.includes('validate'), 'first result should match keyword');
  });

  it('should find results via vector path when embeddings exist', () => {
    const emb1 = makeEmbedding(1);
    const emb2 = makeEmbedding(2);
    const queryEmb = makeEmbedding(1); // similar to emb1

    repo.create({ content: 'alpha topic one', kind: 'fact', embedding: emb1 });
    repo.create({ content: 'beta topic two', kind: 'fact', embedding: emb2 });

    const results = repo.recallHybrid('unrelated query text', queryEmb, { maxResults: 5 });
    // Vector path should find emb1 as closest
    assert.ok(results.length >= 1, 'should find results via vector search');
  });

  it('should boost items appearing in both FTS and vector results', () => {
    const emb1 = makeEmbedding(1);
    const queryEmb = makeEmbedding(1);

    repo.create({ content: 'validate database connections always', kind: 'pitfall', embedding: emb1 });
    repo.create({ content: 'validate user input before processing', kind: 'pitfall' }); // FTS only
    repo.create({ content: 'unrelated memory about something else', kind: 'fact', embedding: makeEmbedding(2) }); // vector only

    const results = repo.recallHybrid('validate database', queryEmb, { maxResults: 5 });
    assert.ok(results.length >= 1, 'should find results');
    // The memory with BOTH keyword match AND vector match should rank highest
    assert.ok(results[0].memory.content.includes('validate database'),
      'item in both FTS + vector should rank first');
  });

  it('should fall back gracefully with null embedding', () => {
    repo.create({ content: 'test memory for recall', kind: 'fact' });
    const results = repo.recallHybrid('test memory', null, { maxResults: 5 });
    assert.ok(results.length >= 1, 'should work without embedding');
  });

  it('should update recall stats on hybrid search', () => {
    const { id } = repo.create({ content: 'recalled memory test', kind: 'fact' });
    repo.recallHybrid('recalled memory', null, { maxResults: 5 });
    const mem = repo.findById(id);
    assert.ok(mem && mem.recall_count > 0, 'recall_count should increment');
  });
});

// --- Edge Repository -------------------------------------------------------

describe('Edge Repository', () => {
  let mem1Id: string;
  let mem2Id: string;
  let mem3Id: string;

  beforeEach(() => {
    mem1Id = repo.create({ content: 'memory one', kind: 'fact' }).id;
    mem2Id = repo.create({ content: 'memory two', kind: 'fact' }).id;
    mem3Id = repo.create({ content: 'memory three', kind: 'fact' }).id;
  });

  it('should create an edge', () => {
    const ok = edgeRepo.createEdge(mem1Id, mem2Id, 'supersedes');
    assert.ok(ok, 'edge creation should succeed');
  });

  it('should not create duplicate edges', () => {
    edgeRepo.createEdge(mem1Id, mem2Id, 'supersedes');
    const ok = edgeRepo.createEdge(mem1Id, mem2Id, 'supersedes');
    assert.ok(ok, 'duplicate edge should be ignored (OR IGNORE)');
    const edges = edgeRepo.edgesFrom(mem1Id);
    assert.equal(edges.length, 1, 'should have exactly 1 edge');
  });

  it('should allow multiple relations between same memories', () => {
    edgeRepo.createEdge(mem1Id, mem2Id, 'supersedes');
    edgeRepo.createEdge(mem1Id, mem2Id, 'refines');
    const edges = edgeRepo.edgesFrom(mem1Id);
    assert.equal(edges.length, 2, 'should have 2 edges with different relations');
  });

  it('should get edges from and to a memory', () => {
    edgeRepo.createEdge(mem1Id, mem2Id, 'supersedes');
    edgeRepo.createEdge(mem3Id, mem1Id, 'refines');

    const from = edgeRepo.edgesFrom(mem1Id);
    assert.equal(from.length, 1);
    assert.equal(from[0].target_id, mem2Id);

    const to = edgeRepo.edgesTo(mem1Id);
    assert.equal(to.length, 1);
    assert.equal(to[0].source_id, mem3Id);
  });

  it('should get 1-hop neighbors', () => {
    edgeRepo.createEdge(mem1Id, mem2Id, 'supersedes');
    edgeRepo.createEdge(mem3Id, mem1Id, 'refines');

    const neighbors = edgeRepo.neighbors(mem1Id);
    assert.equal(neighbors.length, 2);
    assert.ok(neighbors.includes(mem2Id));
    assert.ok(neighbors.includes(mem3Id));
  });

  it('should traverse reachable nodes via CTE', () => {
    edgeRepo.createEdge(mem1Id, mem2Id, 'supersedes');
    edgeRepo.createEdge(mem2Id, mem3Id, 'refines');

    const reachable = edgeRepo.reachable(mem1Id, 2);
    assert.ok(reachable.length >= 2, 'should reach both mem2 and mem3');
    assert.ok(reachable.some(r => r.id === mem2Id && r.depth === 1));
    assert.ok(reachable.some(r => r.id === mem3Id && r.depth === 2));
  });

  it('should handle cycles in traversal', () => {
    edgeRepo.createEdge(mem1Id, mem2Id, 'refines');
    edgeRepo.createEdge(mem2Id, mem3Id, 'refines');
    edgeRepo.createEdge(mem3Id, mem1Id, 'refines'); // cycle

    const reachable = edgeRepo.reachable(mem1Id, 3);
    // Should not infinite loop — cycle prevention via path check
    assert.ok(reachable.length >= 2, 'should find reachable nodes without infinite loop');
  });

  it('does not skip nodes whose id is a substring of an earlier id (M11)', () => {
    // The old cycle guard used substring LIKE on the concatenated path:
    // visiting 'node' made target 'no' look already-visited. The guard must
    // be delimiter-exact. Raw inserts because edge FKs require the ids to
    // exist in memories and repo.create() generates its own ids.
    const insert = db.prepare(
      "INSERT INTO memories (id, content, kind, created_at) VALUES (?, ?, 'fact', datetime('now'))",
    );
    for (const id of ['start', 'node', 'no']) insert.run(id, `crafted ${id}`);
    edgeRepo.createEdge('start', 'node', 'refines');
    edgeRepo.createEdge('node', 'no', 'refines');

    const reachable = edgeRepo.reachable('start', 2);
    assert.ok(reachable.some(r => r.id === 'node' && r.depth === 1));
    assert.ok(reachable.some(r => r.id === 'no' && r.depth === 2), "id 'no' must not be masked by 'node' in the path");
  });

  it('should delete edges for a memory', () => {
    edgeRepo.createEdge(mem1Id, mem2Id, 'supersedes');
    edgeRepo.createEdge(mem3Id, mem1Id, 'refines');

    const deleted = edgeRepo.deleteEdgesFor(mem1Id);
    assert.equal(deleted, 2);

    assert.equal(edgeRepo.edgesFrom(mem1Id).length, 0);
    assert.equal(edgeRepo.edgesTo(mem1Id).length, 0);
  });

  it('should cascade delete edges when memory is deleted', () => {
    edgeRepo.createEdge(mem1Id, mem2Id, 'supersedes');
    repo.delete(mem1Id);

    const edges = edgeRepo.edgesFrom(mem1Id);
    assert.equal(edges.length, 0, 'edges should be cascade-deleted');
  });

  it('should count edges', () => {
    edgeRepo.createEdge(mem1Id, mem2Id, 'supersedes');
    edgeRepo.createEdge(mem3Id, mem1Id, 'refines');
    assert.equal(edgeRepo.edgeCount(mem1Id), 2);
  });

  it('should prune old co_occurred edges', () => {
    edgeRepo.createEdge(mem1Id, mem2Id, 'co_occurred');
    // Manually backdate the edge
    db.prepare("UPDATE memory_edges SET created_at = datetime('now', '-100 days') WHERE relation = 'co_occurred'").run();
    const pruned = edgeRepo.pruneOldCoOccurrences(90);
    assert.equal(pruned, 1);
  });
});

// --- Consolidation ---------------------------------------------------------

describe('Memory Consolidation', () => {
  function makeMem(content: string, confidence: number = 0.7, daysAgo: number = 0): Memory {
    const created = new Date();
    created.setDate(created.getDate() - daysAgo);
    return {
      id: `test-${Math.random().toString(36).slice(2)}`,
      revision: 1,
      content,
      kind: 'pitfall',
      project: 'test',
      tags: [],
      confidence,
      source: 'learned',
      created_at: created.toISOString(),
      last_recalled: null,
      recall_count: 0,
      invalidated: 0,
      surface_count: 0,
      impact_count: 0,
      fingerprint: null,
      context: null,
      anchor: null,
    };
  }

  it('should compute affinity for similar content', () => {
    const a = makeMem('always validate user input before saving to database');
    const b = makeMem('validate user input before database operations');
    const affinity = computeAffinity(a, b);
    assert.ok(affinity > 0.3, `affinity should be significant, got ${affinity}`);
  });

  it('should compute low affinity for dissimilar content', () => {
    const a = makeMem('always validate user input');
    const b = makeMem('use connection pooling for performance');
    const affinity = computeAffinity(a, b);
    assert.ok(affinity <= 0.35, `affinity should be low, got ${affinity}`);
  });

  it('should temporal proximity boost affinity', () => {
    const a = makeMem('validate input', 0.7, 0);
    const b = makeMem('validate input', 0.7, 0); // same day
    const c = makeMem('validate input', 0.7, 60); // 60 days ago

    const closeAffinity = computeAffinity(a, b);
    const farAffinity = computeAffinity(a, c);
    assert.ok(closeAffinity > farAffinity, 'temporal proximity should boost affinity');
  });

  it('should find consolidation candidates', () => {
    const memories = [
      makeMem('always validate user input before saving to database'),
      makeMem('validate user input before database operations'),
      makeMem('use connection pooling for performance'),
    ];

    const clusters = findConsolidationCandidates(memories, 0.3);
    assert.ok(clusters.length >= 1, 'should find at least 1 cluster');
    assert.ok(clusters[0].members.length >= 2, 'cluster should have 2+ members');
  });

  it('should not cluster dissimilar memories', () => {
    const memories = [
      makeMem('validate user input'),
      makeMem('use connection pooling'),
      makeMem('enable compression for responses'),
    ];

    const clusters = findConsolidationCandidates(memories, 0.7);
    assert.equal(clusters.length, 0, 'no clusters should form at high threshold');
  });

  it('should compute merged confidence correctly', () => {
    const cluster = {
      representative: makeMem('rep', 0.8),
      members: [makeMem('a', 0.8), makeMem('b', 0.6), makeMem('c', 0.5)],
    };
    const conf = mergedConfidence(cluster);
    assert.ok(Math.abs(conf - 0.9) < 0.001, `expected 0.9 (0.8 + 2*0.05), got ${conf}`);
  });

  it('should cap merged confidence at 1.0', () => {
    const cluster = {
      representative: makeMem('rep', 0.95),
      members: Array(5).fill(null).map((_, i) => makeMem(`m${i}`, 0.95)),
    };
    const conf = mergedConfidence(cluster);
    assert.equal(conf, 1.0, 'should cap at 1.0');
  });

  it('should merge tags from all members', () => {
    const cluster = {
      representative: makeMem('rep'),
      members: [
        { ...makeMem('a'), tags: ['python', 'validation'] },
        { ...makeMem('b'), tags: ['python', 'security'] },
      ],
    };
    const tags = mergedTags(cluster);
    assert.ok(tags.includes('python'));
    assert.ok(tags.includes('validation'));
    assert.ok(tags.includes('security'));
    assert.equal(tags.filter(t => t === 'python').length, 1, 'should deduplicate');
  });
});

describe('Embedding-Enhanced Consolidation', () => {
  function makeMem(content: string, confidence: number = 0.7, daysAgo: number = 0): Memory {
    const created = new Date();
    created.setDate(created.getDate() - daysAgo);
    return {
      id: `emb-${Math.random().toString(36).slice(2)}`,
      revision: 1,
      content,
      kind: 'pitfall',
      project: 'test',
      tags: [],
      confidence,
      source: 'learned',
      created_at: created.toISOString(),
      last_recalled: null,
      recall_count: 0,
      invalidated: 0,
      surface_count: 0,
      impact_count: 0,
      fingerprint: null,
      context: null,
      anchor: null,
    };
  }

  it('should use embedding similarity when provided', () => {
    const a = makeMem('avoid raw SQL in controllers');
    const b = makeMem('use parameterized queries instead of string concatenation');

    // Without embeddings: low token overlap → low affinity
    const withoutEmb = computeAffinity(a, b);

    // With embeddings: high cosine similarity → should boost affinity
    const withEmb = computeAffinity(a, b, 0.85);
    assert.ok(withEmb > withoutEmb, `embedding path (${withEmb.toFixed(3)}) should exceed token-only (${withoutEmb.toFixed(3)})`);
  });

  it('should cluster semantically similar memories when embeddings provided', () => {
    const memories = [
      makeMem('avoid raw SQL in controllers'),
      makeMem('use parameterized queries instead of string concatenation'),
      makeMem('enable gzip compression for API responses'),
    ];

    // Without embeddings: first two are lexically different, won't cluster at 0.5
    const withoutEmb = findConsolidationCandidates(memories, 0.5);
    assert.equal(withoutEmb.length, 0, 'should NOT cluster without embeddings (low token overlap)');

    // With embeddings: high similarity between first two
    const embMap = new Map<string, number>();
    const [idA, idB, idC] = memories.map(m => m.id);
    const keyAB = idA < idB ? `${idA}:${idB}` : `${idB}:${idA}`;
    const keyAC = idA < idC ? `${idA}:${idC}` : `${idC}:${idA}`;
    const keyBC = idB < idC ? `${idB}:${idC}` : `${idC}:${idB}`;
    embMap.set(keyAB, 0.88); // semantically similar
    embMap.set(keyAC, 0.15); // dissimilar
    embMap.set(keyBC, 0.12); // dissimilar

    const withEmb = findConsolidationCandidates(memories, 0.5, embMap);
    assert.ok(withEmb.length >= 1, `should find cluster with embeddings, got ${withEmb.length}`);
    assert.ok(withEmb[0].members.length === 2, 'cluster should have exactly 2 SQL-related members');
  });

  it('should fall back to token overlap when no embedding similarity exists', () => {
    const a = makeMem('validate user input before database operations');
    const b = makeMem('validate user input before saving to database');

    // Empty map — no embedding data for this pair
    const emptyMap = new Map<string, number>();
    const withEmpty = computeAffinity(a, b, undefined);
    const withMap = findConsolidationCandidates([a, b], 0.3, emptyMap);

    assert.ok(withEmpty > 0.3, 'token overlap should still work');
    assert.ok(withMap.length >= 1, 'should cluster via token overlap fallback');
  });
});

describe('Consolidation Integration', () => {
  it('should merge similar memories in DB and create edges', () => {
    // Create similar memories with old enough timestamps
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 10);
    const oldIso = oldDate.toISOString();

    const id1 = repo.create({ content: 'always validate user input before saving to database', kind: 'pitfall' }).id;
    const id2 = repo.create({ content: 'validate user input before database save operations', kind: 'pitfall' }).id;
    const id3 = repo.create({ content: 'use connection pooling for better performance', kind: 'fact' }).id;

    // Backdate to pass MIN_AGE_DAYS
    db.prepare('UPDATE memories SET created_at = ? WHERE id IN (?, ?, ?)').run(oldIso, id1, id2, id3);

    const result = runConsolidation(db);

    // Check that the pitfalls were consolidated (similar content)
    if (result.clustersFound > 0) {
      assert.ok(result.merged > 0, 'should have merged some memories');

      // At least one should be invalidated
      const invalidated = db.prepare(
        'SELECT COUNT(*) as cnt FROM memories WHERE invalidated = 1 AND id IN (?, ?)'
      ).get(id1, id2) as { cnt: number };
      assert.ok(invalidated.cnt > 0, 'at least one should be invalidated');

      // Should have refines edge(s)
      const edges = db.prepare(
        "SELECT COUNT(*) as cnt FROM memory_edges WHERE relation = 'refines'"
      ).get() as { cnt: number };
      assert.ok(edges.cnt > 0, 'should create refines edges');
    }

    // The unrelated fact should be untouched
    const fact = repo.findById(id3);
    assert.ok(fact && fact.invalidated === 0, 'unrelated memory should not be consolidated');
  });

  it('should not consolidate memories younger than MIN_AGE_DAYS', () => {
    // Create memories with current timestamp (too young)
    repo.create({ content: 'fresh memory about validation', kind: 'pitfall' });
    repo.create({ content: 'fresh memory about validation rules', kind: 'pitfall' });

    const result = runConsolidation(db);
    assert.equal(result.merged, 0, 'should not consolidate young memories');
  });
});

// --- Graph-Enhanced Recall -------------------------------------------------

describe('Graph-Enhanced Recall', () => {
  it('should enrich results with 1-hop neighbors', () => {
    const id1 = repo.create({ content: 'validate user input always', kind: 'pitfall' }).id;
    const id2 = repo.create({ content: 'sanitize HTML output carefully', kind: 'pitfall' }).id;
    const id3 = repo.create({ content: 'unrelated database optimization tip', kind: 'fact' }).id;

    // Create edge: id1 --refines--> id2
    edgeRepo.createEdge(id1, id2, 'refines');

    // Recall finds id1 via keyword
    const baseResults = repo.recall('validate user input', { maxResults: 1 });
    assert.equal(baseResults.length, 1);
    assert.equal(baseResults[0].memory.id, id1);

    // Enrich should add id2 as neighbor
    const enriched = repo.enrichWithGraphNeighbors(baseResults, 2);
    assert.ok(enriched.length >= 2, `should have base + neighbor, got ${enriched.length}`);
    assert.ok(enriched.some(r => r.memory.id === id2), 'neighbor id2 should be in enriched results');
    assert.ok(!enriched.some(r => r.memory.id === id3), 'unrelated id3 should NOT be in results');
  });

  it('should not duplicate memories already in results', () => {
    const id1 = repo.create({ content: 'validate user input always', kind: 'pitfall' }).id;
    const id2 = repo.create({ content: 'validate and sanitize all input', kind: 'pitfall' }).id;

    edgeRepo.createEdge(id1, id2, 'refines');

    // Both already in results
    const baseResults = repo.recall('validate input', { maxResults: 5 });
    const enriched = repo.enrichWithGraphNeighbors(baseResults, 2);

    // Should not have duplicates
    const ids = enriched.map(r => r.memory.id);
    const uniqueIds = new Set(ids);
    assert.equal(ids.length, uniqueIds.size, 'should have no duplicate IDs');
  });

  it('should respect maxExtra limit', () => {
    const id1 = repo.create({ content: 'core memory for graph test', kind: 'fact' }).id;
    const id2 = repo.create({ content: 'neighbor one of core', kind: 'fact' }).id;
    const id3 = repo.create({ content: 'neighbor two of core', kind: 'fact' }).id;
    const id4 = repo.create({ content: 'neighbor three of core', kind: 'fact' }).id;

    edgeRepo.createEdge(id1, id2, 'refines');
    edgeRepo.createEdge(id1, id3, 'refines');
    edgeRepo.createEdge(id1, id4, 'refines');

    const baseResults = repo.recall('core memory graph', { maxResults: 1 });
    const enriched = repo.enrichWithGraphNeighbors(baseResults, 1);

    // Should add at most 1 extra
    assert.ok(enriched.length <= 2, `should have at most 2 (base + 1 extra), got ${enriched.length}`);
  });

  it('should return empty enrichment when no edges exist', () => {
    repo.create({ content: 'isolated memory no edges', kind: 'fact' });

    const results = repo.recall('isolated memory', { maxResults: 1 });
    const enriched = repo.enrichWithGraphNeighbors(results, 2);
    assert.equal(enriched.length, results.length, 'should not add anything without edges');
  });
});

// --- Embedding Backfill Helpers --------------------------------------------

describe('Embedding Backfill Helpers', () => {
  it('should find memories without embeddings ordered by confidence', () => {
    repo.create({ content: 'always validate user input before processing data', kind: 'fact', confidence: 0.9 });
    repo.create({ content: 'use connection pooling for database operations', kind: 'decision', confidence: 0.3 });
    repo.create({
      content: 'enable compression for HTTP responses globally',
      kind: 'fact',
      embedding: embeddingToBuffer(new Float32Array(EMBEDDING_DIM)),
    });

    const without = repo.memoriesWithoutEmbeddings(10);
    assert.equal(without.length, 2);
    // High confidence first
    assert.ok(without[0].content.includes('validate'), `expected validate first, got: ${without[0].content}`);
  });

  it('should respect limit parameter', () => {
    const kinds = ['pitfall', 'decision', 'correction', 'fact', 'fact'] as const;
    for (let i = 0; i < 5; i++) {
      repo.create({ content: `distinct backfill content number ${i} about topic ${i * 7}`, kind: kinds[i] });
    }

    const batch = repo.memoriesWithoutEmbeddings(3);
    assert.equal(batch.length, 3);
  });
});

// --- Multi-Signal Score with Vector ----------------------------------------

describe('Multi-Signal Score with Vector', () => {
  it('should include VECTOR and PRECISION weights in scoring', async () => {
    const { FINGERPRINT } = await import('../src/constants/index.js');
    const { WEIGHTS } = FINGERPRINT;
    assert.ok(WEIGHTS.VECTOR > 0, 'VECTOR weight should be positive');
    assert.ok(WEIGHTS.PRECISION > 0, 'PRECISION weight should be positive');
    const totalWeight = Object.values(WEIGHTS).reduce((sum, w) => sum + (w as number), 0);
    assert.ok(Math.abs(totalWeight - 1.0) < 0.001, `weights should sum to 1.0, got ${totalWeight}`);
  });
});
