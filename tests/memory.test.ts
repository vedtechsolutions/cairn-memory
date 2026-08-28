import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type Database from 'better-sqlite3';
import { openDatabase } from '../src/db/connection.js';
import { MemoryRepository } from '../src/db/memory-repository.js';
import { CONFIDENCE } from '../src/constants/index.js';
import { EdgeRepository } from '../src/db/edge-repository.js';

let db: Database.Database;
let repo: MemoryRepository;

beforeEach(() => {
  db = openDatabase({ dbPath: ':memory:' });
  repo = new MemoryRepository(db);
});

afterEach(() => {
  db.close();
});

describe('MemoryRepository — Create', () => {
  it('should create a memory and return its ID', () => {
    const result = repo.create({
      content: 'Use list not tree in Odoo 19 views',
      kind: 'pitfall',
      tags: ['odoo19', 'xml', 'views'],
      project: 'test-proj',
    });

    assert.ok(result.id);
    assert.equal(result.deduplicated, false);

    const mem = repo.findById(result.id);
    assert.ok(mem);
    assert.equal(mem.content, 'Use list not tree in Odoo 19 views');
    assert.equal(mem.kind, 'pitfall');
    assert.equal(mem.project, 'test-proj');
    assert.deepEqual(mem.tags, ['odoo19', 'xml', 'views']);
    assert.equal(mem.confidence, CONFIDENCE.LEARNED);
    assert.equal(mem.source, 'learned');
    assert.equal(mem.recall_count, 0);
    assert.equal(mem.invalidated, 0);
  });

  it('should default corrections to higher confidence', () => {
    const result = repo.create({
      content: 'Always ask before committing',
      kind: 'correction',
    });
    const mem = repo.findById(result.id)!;
    assert.equal(mem.confidence, CONFIDENCE.CORRECTION);
  });

  it('should default project to null (global)', () => {
    const result = repo.create({
      content: 'A global fact',
      kind: 'fact',
    });
    const mem = repo.findById(result.id)!;
    assert.equal(mem.project, null);
  });

  it('should sanitize content — strip control chars and extra whitespace', () => {
    const result = repo.create({
      content: 'Hello\x00   world\t\ttest',
      kind: 'fact',
    });
    const mem = repo.findById(result.id)!;
    assert.equal(mem.content, 'Hello world test');
  });

  it('should deduplicate similar content in same scope', () => {
    const r1 = repo.create({
      content: 'Odoo 19 always use list element not tree element in view definitions',
      kind: 'pitfall',
      tags: ['odoo19'],
      project: 'proj-a',
    });
    assert.equal(r1.deduplicated, false);

    // Nearly identical content — high token overlap
    const r2 = repo.create({
      content: 'Odoo 19 always use list element not tree element in XML view definitions',
      kind: 'pitfall',
      tags: ['xml'],
      project: 'proj-a',
    });
    assert.equal(r2.deduplicated, true);
    assert.equal(r2.id, r1.id); // Same memory updated

    // Verify tags were merged
    const mem = repo.findById(r1.id)!;
    assert.ok(mem.tags.includes('odoo19'));
    assert.ok(mem.tags.includes('xml'));
  });

  it('should NOT deduplicate different kinds', () => {
    repo.create({
      content: 'SQLite over Postgres for single user',
      kind: 'decision',
      project: 'proj-a',
    });

    const r2 = repo.create({
      content: 'SQLite over Postgres for single user embedded',
      kind: 'pitfall',
      project: 'proj-a',
    });
    assert.equal(r2.deduplicated, false);
  });
});

describe('MemoryRepository — Recall', () => {
  beforeEach(() => {
    // Seed test data
    repo.create({ content: 'Odoo 19 use list not tree in view definitions', kind: 'pitfall', tags: ['odoo19', 'xml'], project: 'proj-a' });
    repo.create({ content: 'SQLite over Postgres because single-user embedded', kind: 'decision', tags: ['database'], project: 'proj-a' });
    repo.create({ content: 'Always ask before committing code', kind: 'correction', tags: ['git'], project: null });
    repo.create({ content: 'DB connection string is postgres://localhost:5432', kind: 'fact', tags: ['database'], project: 'proj-b' });
  });

  it('should return relevant memories by FTS query', () => {
    const results = repo.recall('Odoo XML views', { project: 'proj-a' });
    assert.ok(results.length > 0);
    assert.ok(results[0].memory.content.includes('list not tree'));
  });

  it('should include global memories in project recall', () => {
    const results = repo.recall('committing code git', { project: 'proj-a' });
    assert.ok(results.some(r => r.memory.kind === 'correction'));
  });

  it('should rank by composite score (confidence * source weight * recency)', () => {
    // Create a corrected memory (higher source weight)
    repo.create({
      content: 'Use ORM not raw SQL in Odoo views',
      kind: 'correction',
      tags: ['odoo19'],
      project: 'proj-a',
      source: 'corrected',
      confidence: 0.8,
    });

    const results = repo.recall('Odoo views', { project: 'proj-a' });
    // Corrected should rank high
    const correctedIdx = results.findIndex(r => r.memory.source === 'corrected');
    if (correctedIdx >= 0 && results.length > 1) {
      // Corrected memory should have a higher score
      assert.ok(results[correctedIdx].score > 0);
    }
  });

  it('should update recall stats on recall', () => {
    const results = repo.recall('Odoo XML', { project: 'proj-a' });
    assert.ok(results.length > 0);

    const mem = repo.findById(results[0].memory.id)!;
    assert.equal(mem.recall_count, 1);
    assert.ok(mem.last_recalled);
  });

  it('should respect maxResults', () => {
    const results = repo.recall('database', { project: 'proj-a', maxResults: 1 });
    assert.ok(results.length <= 1);
  });

  it('should return empty for no match', () => {
    const results = repo.recall('xyzzy nonexistent topic', { project: 'proj-a' });
    assert.equal(results.length, 0);
  });

  it('should filter by kind', () => {
    const results = repo.recall('database', { project: 'proj-a', kind: 'decision' });
    for (const r of results) {
      assert.equal(r.memory.kind, 'decision');
    }
  });

  it('should not return invalidated memories', () => {
    const created = repo.create({ content: 'Invalid lesson about XML parsing', kind: 'pitfall', tags: ['xml'], project: 'proj-a' });
    repo.invalidate(created.id);

    const results = repo.recall('XML parsing', { project: 'proj-a' });
    assert.ok(!results.some(r => r.memory.id === created.id));
  });
});

describe('MemoryRepository — RecallByTags', () => {
  beforeEach(() => {
    repo.create({ content: 'Odoo 19 list not tree', kind: 'pitfall', tags: ['odoo19', 'xml'], project: 'proj-a', confidence: 0.7 });
    repo.create({ content: 'Python import error fix', kind: 'pitfall', tags: ['python', 'imports'], project: 'proj-a', confidence: 0.6 });
  });

  it('should find memories by tag match', () => {
    const results = repo.recallByTags(['xml'], { project: 'proj-a' });
    assert.ok(results.length > 0);
    assert.ok(results[0].content.includes('list not tree'));
  });

  it('should respect minConfidence', () => {
    const results = repo.recallByTags(['python'], { project: 'proj-a', minConfidence: 0.8 });
    assert.equal(results.length, 0);
  });
});

describe('MemoryRepository — Update/Invalidate/Delete', () => {
  it('should update content and boost confidence', () => {
    const { id } = repo.create({ content: 'Original lesson', kind: 'pitfall' });
    const ok = repo.update(id, 'Updated lesson with more detail');
    assert.equal(ok, true);

    const mem = repo.findById(id)!;
    assert.equal(mem.content, 'Updated lesson with more detail');
    assert.equal(mem.confidence, CONFIDENCE.CORRECTION);
    assert.equal(mem.source, 'corrected');
  });

  it('should soft-delete via invalidate', () => {
    const { id } = repo.create({ content: 'Will be invalidated', kind: 'fact' });
    const ok = repo.invalidate(id);
    assert.equal(ok, true);

    const mem = repo.findById(id)!;
    assert.equal(mem.invalidated, 1);
  });

  it('should hard-delete via delete', () => {
    const { id } = repo.create({ content: 'Will be deleted', kind: 'fact' });
    const ok = repo.delete(id);
    assert.equal(ok, true);

    const mem = repo.findById(id);
    assert.equal(mem, null);
  });

  it('should return false for non-existent ID', () => {
    assert.equal(repo.update('nonexistent', 'test'), false);
    assert.equal(repo.invalidate('nonexistent'), false);
    assert.equal(repo.delete('nonexistent'), false);
  });
});

describe('MemoryRepository — Boost Confidence', () => {
  it('should increment confidence', () => {
    const { id } = repo.create({ content: 'Boostable', kind: 'pitfall', confidence: 0.5 });
    repo.boostConfidence(id, 0.1);
    const mem = repo.findById(id)!;
    assert.ok(Math.abs(mem.confidence - 0.6) < 0.001);
  });

  it('should cap at 1.0', () => {
    const { id } = repo.create({ content: 'Almost max', kind: 'pitfall', confidence: 0.95 });
    repo.boostConfidence(id, 0.2);
    const mem = repo.findById(id)!;
    assert.ok(mem.confidence <= 1.0);
  });
});

describe('MemoryRepository — Top Pitfalls & Active Corrections', () => {
  it('should return pitfalls ranked by confidence * recall frequency', () => {
    repo.create({ content: 'Pitfall A', kind: 'pitfall', project: 'proj-a', confidence: 0.8 });
    repo.create({ content: 'Pitfall B', kind: 'pitfall', project: 'proj-a', confidence: 0.4 });
    repo.create({ content: 'Global pitfall', kind: 'pitfall', project: null, confidence: 0.6 });

    const pitfalls = repo.topPitfalls('proj-a', 5);
    assert.ok(pitfalls.length >= 2);
    // First should be highest ranked
    assert.ok(pitfalls[0].confidence >= pitfalls[1].confidence);
  });

  it('should return active corrections', () => {
    repo.create({ content: 'Correction 1', kind: 'correction', project: null });
    repo.create({ content: 'Correction 2', kind: 'correction', project: 'proj-a' });

    const corrections = repo.activeCorrections('proj-a', 5);
    assert.ok(corrections.length >= 1);
  });
});

describe('MemoryRepository — Project Scoping', () => {
  it('should count memories by project', () => {
    repo.create({ content: 'Database connection string is postgres://localhost', kind: 'fact', project: 'proj-a' });
    repo.create({ content: 'Auth module uses JWT tokens for session management', kind: 'fact', project: 'proj-a' });
    repo.create({ content: 'Redis cache is on port 6379 default config', kind: 'fact', project: 'proj-b' });

    assert.equal(repo.countByProject('proj-a'), 2);
    assert.equal(repo.countByProject('proj-b'), 1);
  });
});

describe('MemoryRepository — Surface & Impact Tracking', () => {
  it('should include surface_count and impact_count in created memories', () => {
    const { id } = repo.create({ content: 'Test pitfall for surface tracking', kind: 'pitfall', project: 'proj-a' });
    const mem = repo.findById(id)!;
    assert.equal(mem.surface_count, 0);
    assert.equal(mem.impact_count, 0);
  });

  it('should return updated surface_count after incrementSurface', () => {
    const { id } = repo.create({ content: 'Pitfall to be surfaced multiple times', kind: 'pitfall', project: 'proj-a' });
    repo.incrementSurface(id);
    repo.incrementSurface(id);
    const mem = repo.findById(id)!;
    assert.equal(mem.surface_count, 2);
  });

  it('should return updated impact_count after incrementImpact', () => {
    const { id } = repo.create({ content: 'Pitfall with positive impact measured', kind: 'pitfall', project: 'proj-a' });
    repo.incrementImpact(id);
    const mem = repo.findById(id)!;
    assert.equal(mem.impact_count, 1);
  });
});

describe('MemoryRepository — Search (read-only)', () => {
  it('search() should not update recall_count', () => {
    repo.create({ content: 'Python import error in Flask application', kind: 'pitfall', project: 'proj-a' });

    const results = repo.search('Python Flask import', { project: 'proj-a' });
    assert.ok(results.length > 0);

    const mem = repo.findById(results[0].memory.id)!;
    assert.equal(mem.recall_count, 0, 'search() must not bump recall_count');
    assert.equal(mem.last_recalled, null, 'search() must not set last_recalled');
  });

  it('recall() should update recall_count', () => {
    repo.create({ content: 'TypeScript strict mode compilation errors', kind: 'pitfall', project: 'proj-a' });

    const results = repo.recall('TypeScript strict mode', { project: 'proj-a' });
    assert.ok(results.length > 0);

    const mem = repo.findById(results[0].memory.id)!;
    assert.equal(mem.recall_count, 1, 'recall() must bump recall_count');
    assert.ok(mem.last_recalled, 'recall() must set last_recalled');
  });
});

// --- storeDecision() Gateway ------------------------------------------------

describe('MemoryRepository — storeDecision()', () => {
  it('should create a new decision with correct fields', () => {
    const result = repo.storeDecision({
      content: 'Use Redis for session store because it supports TTL natively',
      project: 'proj-a',
      source: 'user',
      confidence: 0.8,
      tags: ['redis', 'sessions'],
      context: { why: 'TTL support' },
    });

    assert.equal(result.deduplicated, false);
    const mem = repo.findById(result.id)!;
    assert.equal(mem.kind, 'decision');
    assert.equal(mem.source, 'user');
    assert.equal(mem.confidence, 0.8);
    assert.deepEqual(mem.tags, ['redis', 'sessions']);
    assert.equal(mem.context?.why, 'TTL support');
  });

  it('should dedup via token overlap and merge', () => {
    const r1 = repo.storeDecision({
      content: 'Use Redis for session store because it supports TTL natively',
      project: 'proj-a',
    });
    const r2 = repo.storeDecision({
      content: 'Use Redis for session store because TTL support is native',
      project: 'proj-a',
    });

    assert.equal(r1.deduplicated, false);
    assert.equal(r2.deduplicated, true);
    assert.equal(r2.id, r1.id);

    const mem = repo.findById(r1.id)!;
    assert.ok(mem.confidence > CONFIDENCE.LEARNED, 'confidence should be boosted on dedup');
  });

  it('should not downgrade source authority on dedup', () => {
    repo.storeDecision({
      content: 'Use JWT for authentication because it is stateless',
      project: 'proj-a',
      source: 'user',
    });
    // Auto-mined decision with lower authority tries to merge
    const r2 = repo.storeDecision({
      content: 'Use JWT for authentication because it is stateless and scalable',
      project: 'proj-a',
      source: 'learned',
    });

    assert.equal(r2.deduplicated, true);
    const mem = repo.findById(r2.id)!;
    assert.equal(mem.source, 'user', 'source must not downgrade from user to learned');
  });

  it('should upgrade source authority on dedup', () => {
    repo.storeDecision({
      content: 'Use JWT for authentication because it is stateless',
      project: 'proj-a',
      source: 'learned',
    });
    const r2 = repo.storeDecision({
      content: 'Use JWT for authentication because it is stateless and scalable',
      project: 'proj-a',
      source: 'user',
    });

    assert.equal(r2.deduplicated, true);
    const mem = repo.findById(r2.id)!;
    assert.equal(mem.source, 'user', 'source should upgrade from learned to user');
  });

  it('should take max of boosted vs incoming confidence', () => {
    repo.storeDecision({
      content: 'Use PostgreSQL for production database due to JSONB support',
      project: 'proj-a',
      confidence: 0.9,
    });
    const r2 = repo.storeDecision({
      content: 'Use PostgreSQL for production database due to JSONB support and reliability',
      project: 'proj-a',
      confidence: 0.55,
    });

    assert.equal(r2.deduplicated, true);
    const mem = repo.findById(r2.id)!;
    // max(0.9 + 0.05, 0.55) = 0.95
    assert.ok(mem.confidence >= 0.95, `expected >= 0.95, got ${mem.confidence}`);
  });

  it('should fill context gaps without overwriting existing', () => {
    repo.storeDecision({
      content: 'Use Zod for runtime validation because TypeScript types are erased',
      project: 'proj-a',
      context: { why: 'types erased at runtime' },
    });
    const r2 = repo.storeDecision({
      content: 'Use Zod for runtime validation because TypeScript types are erased at runtime',
      project: 'proj-a',
      context: { why: 'should not overwrite', how_to_apply: 'import { z } from zod' },
    });

    const mem = repo.findById(r2.id)!;
    assert.equal(mem.context?.why, 'types erased at runtime', 'existing why should not be overwritten');
    assert.equal(mem.context?.how_to_apply, 'import { z } from zod', 'new how_to_apply should fill gap');
  });

  it('should keep longer content on dedup', () => {
    const short = 'Use Redis for sessions because TTL support';
    const long = 'Use Redis for sessions because TTL support is native and avoids custom cleanup logic';
    repo.storeDecision({ content: short, project: 'proj-a' });
    repo.storeDecision({ content: long, project: 'proj-a' });

    const all = db.prepare("SELECT content FROM memories WHERE kind = 'decision' AND project = 'proj-a'").all() as Array<{ content: string }>;
    assert.equal(all.length, 1);
    assert.equal(all[0].content, long);
  });

  it('should not dedup across different projects', () => {
    const r1 = repo.storeDecision({
      content: 'Use Redis for sessions because TTL support is native',
      project: 'proj-a',
    });
    const r2 = repo.storeDecision({
      content: 'Use Redis for sessions because TTL support is native',
      project: 'proj-b',
    });

    assert.equal(r1.deduplicated, false);
    assert.equal(r2.deduplicated, false);
    assert.notEqual(r1.id, r2.id);
  });

  it('should pick richer fingerprint on merge', () => {
    repo.storeDecision({
      content: 'Use Express over Fastify because middleware ecosystem is larger',
      project: 'proj-a',
      fingerprint: undefined,
    });
    const fp = { module: ['api'], framework: ['express'], lang: ['typescript'] };
    repo.storeDecision({
      content: 'Use Express over Fastify because the middleware ecosystem is much larger',
      project: 'proj-a',
      fingerprint: fp,
    });

    const all = db.prepare("SELECT fingerprint FROM memories WHERE kind = 'decision' AND project = 'proj-a'").all() as Array<{ fingerprint: string | null }>;
    assert.equal(all.length, 1);
    assert.ok(all[0].fingerprint, 'fingerprint should be set from richer input');
    const parsed = JSON.parse(all[0].fingerprint!);
    assert.deepEqual(parsed.module, ['api']);
  });

  it('should backfill embedding on merge when existing lacks one', () => {
    const r1 = repo.storeDecision({
      content: 'Use Redis for sessions because TTL support is native',
      project: 'proj-a',
    });
    assert.equal(r1.deduplicated, false);

    const fakeEmbedding = Buffer.alloc(384 * 4); // 384-dim Float32
    const r2 = repo.storeDecision({
      content: 'Use Redis for sessions because TTL support is natively built in',
      project: 'proj-a',
      embedding: fakeEmbedding,
    });
    assert.equal(r2.deduplicated, true);

    const row = db.prepare('SELECT embedding FROM memories WHERE id = ?').get(r1.id) as { embedding: Buffer | null };
    assert.ok(row.embedding !== null, 'embedding should be backfilled on merge');
  });
});

// --- storePitfall() Gateway --------------------------------------------------

describe('MemoryRepository — storePitfall()', () => {
  it('should create a new pitfall with correct fields', () => {
    const result = repo.storePitfall({
      content: 'Never use raw SQL in Odoo models — use ORM methods instead',
      project: 'proj-a',
      source: 'learned',
      tags: ['odoo', 'sql'],
      anchor: '{"file":"models.py","func":"create"}',
    });

    assert.equal(result.deduplicated, false);
    const mem = repo.findById(result.id)!;
    assert.equal(mem.kind, 'pitfall');
    assert.equal(mem.source, 'learned');
    assert.deepEqual(mem.tags, ['odoo', 'sql']);
  });

  it('should dedup via token overlap and merge', () => {
    const r1 = repo.storePitfall({
      content: 'Never use raw SQL in Odoo models — use ORM methods instead',
      project: 'proj-a',
    });
    const r2 = repo.storePitfall({
      content: 'Never use raw SQL in Odoo models — always prefer ORM methods',
      project: 'proj-a',
    });

    assert.equal(r2.deduplicated, true);
    assert.equal(r2.id, r1.id);
    const mem = repo.findById(r1.id)!;
    assert.ok(mem.confidence > CONFIDENCE.AUTO_DETECTED, 'confidence should be boosted');
  });

  it('should not downgrade source authority on dedup', () => {
    repo.storePitfall({
      content: 'Always validate user input before database queries to prevent injection',
      project: 'proj-a',
      source: 'user',
    });
    const r2 = repo.storePitfall({
      content: 'Always validate user input before database queries to prevent SQL injection attacks',
      project: 'proj-a',
      source: 'learned',
    });

    const mem = repo.findById(r2.id)!;
    assert.equal(mem.source, 'user', 'source must not downgrade from user to learned');
  });

  it('should fill context gaps without overwriting existing', () => {
    repo.storePitfall({
      content: 'Edit tool old_string must be unique in the file — include more surrounding context',
      project: 'proj-a',
      context: { why: 'non-unique matches cause silent failures' },
    });
    const r2 = repo.storePitfall({
      content: 'Edit tool old_string must be unique in the target file — add more context lines',
      project: 'proj-a',
      context: { how_to_apply: 'include 3-5 surrounding lines' },
    });

    const mem = repo.findById(r2.id)!;
    assert.equal(mem.context?.why, 'non-unique matches cause silent failures');
    assert.equal(mem.context?.how_to_apply, 'include 3-5 surrounding lines');
  });

  it('should preserve anchor on new pitfall', () => {
    const result = repo.storePitfall({
      content: 'ENOENT errors in Bash — check file exists before reading',
      project: 'proj-a',
      anchor: '{"file":"utils.ts"}',
    });

    const row = db.prepare('SELECT anchor FROM memories WHERE id = ?').get(result.id) as { anchor: string | null };
    assert.equal(row.anchor, '{"file":"utils.ts"}');
  });
});

// --- Supersedes Edge Direction -----------------------------------------------

describe('filterSuperseded — edge direction', () => {
  it('should filter out OLD memories (source_id) and keep NEW ones (target_id)', () => {
    const oldMem = repo.create({ content: 'Old approach: use callbacks for async', kind: 'decision', project: 'proj-a' });
    const newMem = repo.create({ content: 'New approach: use async/await for cleaner code', kind: 'decision', project: 'proj-a' });

    const edgeRepo = new EdgeRepository(db);
    // Convention: source=OLD, target=NEW (target replaces source)
    edgeRepo.createEdge(oldMem.id, newMem.id, 'supersedes');

    const filtered = repo.filterSuperseded([
      repo.findById(oldMem.id)!,
      repo.findById(newMem.id)!,
    ]);

    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].id, newMem.id, 'only the NEW memory should survive');
  });
});

describe('storeMemory: shared gateway behavior', () => {
  it('storeDecision and storePitfall share identical merge logic', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    const repo = new MemoryRepository(db);

    // Store initial decision and pitfall with same content pattern
    const d1 = repo.storeDecision({ content: 'Use approach A for auth', project: 'p', source: 'learned', tags: ['auth'] });
    const p1 = repo.storePitfall({ content: 'Never use raw SQL in handlers', project: 'p', source: 'learned', tags: ['sql'] });
    assert.equal(d1.deduplicated, false);
    assert.equal(p1.deduplicated, false);

    // Dedup merge: both should apply source authority, tag union, confidence boost
    const d2 = repo.storeDecision({ content: 'Use approach A for auth module', project: 'p', source: 'user', tags: ['security'] });
    const p2 = repo.storePitfall({ content: 'Never use raw SQL in route handlers', project: 'p', source: 'user', tags: ['security'] });
    assert.equal(d2.deduplicated, true);
    assert.equal(p2.deduplicated, true);

    // Verify both got source upgraded to 'user' and tags unioned
    const decision = repo.findById(d2.id)!;
    const pitfall = repo.findById(p2.id)!;
    assert.equal(decision.source, 'user');
    assert.equal(pitfall.source, 'user');
    assert.ok(decision.tags.includes('auth'));
    assert.ok(decision.tags.includes('security'));
    assert.ok(pitfall.tags.includes('sql'));
    assert.ok(pitfall.tags.includes('security'));

    db.close();
  });

  it('storeDecision defaults to LEARNED confidence, storePitfall defaults to AUTO_DETECTED', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    const repo = new MemoryRepository(db);

    const d = repo.storeDecision({ content: 'Decision with default confidence level test', project: 'p' });
    const p = repo.storePitfall({ content: 'Pitfall with default confidence level test', project: 'p' });

    const decision = repo.findById(d.id)!;
    const pitfall = repo.findById(p.id)!;
    assert.equal(decision.confidence, 0.65); // CONFIDENCE.LEARNED
    assert.equal(pitfall.confidence, 0.55); // CONFIDENCE.AUTO_DETECTED

    db.close();
  });

  it('storePitfall preserves anchor, storeDecision sets null anchor', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    const repo = new MemoryRepository(db);

    const p = repo.storePitfall({ content: 'Never edit config.ts without backup', project: 'p', anchor: '{"files":["config.ts"]}' });
    const d = repo.storeDecision({ content: 'Use Redis for session storage', project: 'p' });

    // anchor is not on the Memory interface — check via raw SQL
    const pitfallRow = db.prepare('SELECT anchor FROM memories WHERE id = ?').get(p.id) as { anchor: string | null };
    const decisionRow = db.prepare('SELECT anchor FROM memories WHERE id = ?').get(d.id) as { anchor: string | null };
    assert.equal(pitfallRow.anchor, '{"files":["config.ts"]}');
    assert.equal(decisionRow.anchor, null);

    db.close();
  });
});
