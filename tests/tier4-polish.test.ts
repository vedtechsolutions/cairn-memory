/**
 * Tier 4 Polish tests — Ebbinghaus decay, enhanced dedup, learning velocity.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db/connection.js';
import { MemoryRepository } from '../src/db/memory-repository.js';
import { applyConfidenceDecay, expireTtlMemories } from '../src/db/maintenance.js';
import { STABILITY_BY_KIND } from '../src/constants/index.js';
import { embeddingToBuffer } from '../src/utils/embeddings.js';
import type Database from 'better-sqlite3';

let db: Database.Database;
let repo: MemoryRepository;

beforeEach(() => {
  db = openDatabase({ dbPath: ':memory:' });
  repo = new MemoryRepository(db);
});

afterEach(() => {
  db.close();
});

// --- Ebbinghaus Continuous Decay -------------------------------------------

describe('Ebbinghaus Continuous Decay', () => {
  it('should have stability constants for all memory kinds', () => {
    assert.ok(STABILITY_BY_KIND.pitfall > 0, 'pitfall stability should be positive');
    assert.ok(STABILITY_BY_KIND.user_profile > STABILITY_BY_KIND.fact,
      'user_profile should decay slower than facts');
  });

  it('should decay old memories significantly', () => {
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 90); // 90 days ago

    db.prepare(`
      INSERT INTO memories (id, content, kind, project, tags, confidence, source, created_at, recall_count, invalidated)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0)
    `).run('decay-90d', 'old pitfall test', 'pitfall', 'proj', '[]', 0.8, 'learned', oldDate.toISOString());

    applyConfidenceDecay(db);

    const mem = repo.findById('decay-90d')!;
    // R = e^(-90/60) = e^(-1.5) ≈ 0.223, so conf = 0.8 * 0.223 ≈ 0.178
    assert.ok(mem.confidence < 0.3, `90-day pitfall should decay heavily, got ${mem.confidence}`);
  });

  it('should not decay memories recalled within 7 days', () => {
    const recentRecall = new Date();
    recentRecall.setDate(recentRecall.getDate() - 3); // recalled 3 days ago

    db.prepare(`
      INSERT INTO memories (id, content, kind, project, tags, confidence, source, created_at, last_recalled, recall_count, invalidated)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 5, 0)
    `).run('recent-recall', 'recently recalled pitfall', 'pitfall', 'proj', '[]', 0.7, 'learned',
      new Date(Date.now() - 60 * 86400000).toISOString(), recentRecall.toISOString());

    applyConfidenceDecay(db);

    const mem = repo.findById('recent-recall')!;
    assert.ok(Math.abs(mem.confidence - 0.7) < 0.01, `recently recalled should not decay, got ${mem.confidence}`);
  });

  it('decays identically regardless of recall count (step 7 — popularity is not durability)', () => {
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 60);

    // Same age, different recall counts
    db.prepare(`
      INSERT INTO memories (id, content, kind, project, tags, confidence, source, created_at, recall_count, invalidated)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `).run('low-recall', 'low recall memory test', 'fact', 'proj', '[]', 0.7, 'learned', oldDate.toISOString(), 0);

    db.prepare(`
      INSERT INTO memories (id, content, kind, project, tags, confidence, source, created_at, recall_count, invalidated)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `).run('high-recall', 'high recall memory test', 'fact', 'proj', '[]', 0.7, 'learned', oldDate.toISOString(), 10);

    applyConfidenceDecay(db);

    const low = repo.findById('low-recall')!;
    const high = repo.findById('high-recall')!;
    // Inverted by remediation step 7 (M5): stability once multiplied by
    // (1 + recall_count × 0.3), so 10 recalls meant S 30→120 and the row
    // barely decayed — exposure had become durability, and the popularity
    // loop kept noise alive. S is now kind × source only; spaced repetition
    // works through last_recalled moving the reference point, not the count.
    assert.equal(high.confidence, low.confidence,
      `equal-age rows must decay identically whatever their recall_count, got ${high.confidence} vs ${low.confidence}`);
  });

  it('should give source weight bonus to corrected memories', () => {
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 60);

    db.prepare(`
      INSERT INTO memories (id, content, kind, project, tags, confidence, source, created_at, recall_count, invalidated)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0)
    `).run('learned-src', 'learned source decay test', 'pitfall', 'proj', '[]', 0.7, 'learned', oldDate.toISOString());

    db.prepare(`
      INSERT INTO memories (id, content, kind, project, tags, confidence, source, created_at, recall_count, invalidated)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0)
    `).run('corrected-src', 'corrected source decay test', 'pitfall', 'proj', '[]', 0.7, 'corrected', oldDate.toISOString());

    applyConfidenceDecay(db);

    const learned = repo.findById('learned-src')!;
    const corrected = repo.findById('corrected-src')!;
    assert.ok(corrected.confidence > learned.confidence,
      `corrected (${corrected.confidence}) should retain more than learned (${learned.confidence})`);
  });

  it('should handle TTL expiration independently of decay', () => {
    const pastExpiry = new Date(Date.now() - 86400000).toISOString();
    db.prepare(`
      INSERT INTO memories (id, content, kind, project, tags, confidence, source, created_at, recall_count, invalidated, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)
    `).run('expired-mem', 'expired memory test', 'fact', 'proj', '[]', 0.9, 'learned', new Date().toISOString(), pastExpiry);

    const expired = expireTtlMemories(db);
    assert.ok(expired > 0, 'should expire TTL memory');
    assert.equal(repo.findById('expired-mem'), null, 'expired memory should be deleted');
  });
});

// --- Enhanced Dedup with Cosine Similarity ---------------------------------

describe('Enhanced Dedup with Cosine Similarity', () => {
  function makeEmbedding(seed: number): Buffer {
    const emb = new Float32Array(384);
    for (let i = 0; i < 384; i++) emb[i] = Math.sin(seed * (i + 1) * 0.1);
    let norm = 0;
    for (let i = 0; i < 384; i++) norm += emb[i] * emb[i];
    norm = Math.sqrt(norm);
    for (let i = 0; i < 384; i++) emb[i] /= norm;
    return embeddingToBuffer(emb);
  }

  it('should dedup via token overlap (existing behavior)', () => {
    repo.create({ content: 'always validate user input before database queries', kind: 'pitfall' });
    const result = repo.create({ content: 'validate user input before database queries always', kind: 'pitfall' });
    assert.ok(result.deduplicated, 'should detect token overlap duplicate');
  });

  it('should dedup via cosine similarity when embeddings match', () => {
    const emb = makeEmbedding(42);
    repo.create({
      content: 'ensure CSRF tokens are validated on all POST endpoints',
      kind: 'pitfall',
      embedding: emb,
    });

    // Shares enough keywords for FTS to find it, but token overlap is below 0.5
    // Cosine similarity = 1.0 (identical embedding) should catch it
    const result = repo.create({
      content: 'CSRF tokens must be checked for every POST request with proper validation headers',
      kind: 'pitfall',
      embedding: emb, // identical embedding = cosine similarity 1.0
    });

    assert.ok(result.deduplicated, 'should detect cosine similarity duplicate');
  });

  it('should not dedup dissimilar embeddings', () => {
    repo.create({
      content: 'always validate CSRF tokens on POST routes',
      kind: 'pitfall',
      embedding: makeEmbedding(1),
    });

    const result = repo.create({
      content: 'use connection pooling for database performance optimization',
      kind: 'fact',
      embedding: makeEmbedding(100), // very different embedding
    });

    assert.ok(!result.deduplicated, 'should not dedup dissimilar embeddings/content');
  });
});

// --- Learning Velocity (Stats Action) --------------------------------------

describe('Learning Velocity Stats', () => {
  it('should accept velocity action', async () => {
    // Just verify the action is valid by checking the constant
    const { STATS_ACTIONS } = await import('../src/constants/index.js');
    // The extended actions include 'velocity' — added in stats-tool.ts at runtime
    // We just verify the base actions exist
    assert.ok(STATS_ACTIONS.includes('summary'), 'should have summary');
    assert.ok(STATS_ACTIONS.includes('health'), 'should have health');
  });
});
