import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type Database from 'better-sqlite3';
import { openDatabase } from '../src/db/connection.js';
import { MemoryRepository } from '../src/db/memory-repository.js';
import {
  applyConfidenceDecay,
  cleanupSnapshots,
  cleanupArchivedPlans,
  forgetProject,
  findStaleProjects,
  runMaintenance,
} from '../src/db/maintenance.js';

let db: Database.Database;
let memoryRepo: MemoryRepository;

beforeEach(() => {
  db = openDatabase({ dbPath: ':memory:' });
  memoryRepo = new MemoryRepository(db);
});

afterEach(() => {
  db.close();
});

describe('Confidence Decay', () => {
  it('should decay memories not recalled within interval', () => {
    // Create a memory with an old created_at date
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 60); // 60 days ago

    db.prepare(`
      INSERT INTO memories (id, content, kind, project, tags, confidence, source, created_at, recall_count, invalidated)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0)
    `).run('old-mem', 'Old lesson', 'pitfall', 'proj-a', '[]', 0.5, 'learned', oldDate.toISOString());

    const { decayed } = applyConfidenceDecay(db);
    assert.ok(decayed > 0, 'Should have decayed at least one memory');

    const mem = memoryRepo.findById('old-mem')!;
    assert.ok(mem.confidence < 0.5, `Confidence should be reduced from 0.5, got ${mem.confidence}`);
    // Ebbinghaus continuous decay: R = e^(-t/S), t=60d, S=60 (pitfall), so R ≈ 0.368
    assert.ok(mem.confidence < 0.3, `Should decay via Ebbinghaus (60d, S=60), got ${mem.confidence}`);
  });

  it('should NOT decay recently created memories', () => {
    memoryRepo.create({ content: 'Fresh lesson just created now', kind: 'pitfall', project: 'proj-a', confidence: 0.5 });

    const { decayed } = applyConfidenceDecay(db);
    // Fresh memory shouldn't be decayed
    assert.equal(decayed, 0);
  });

  it('should delete memories below threshold', () => {
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 60);

    db.prepare(`
      INSERT INTO memories (id, content, kind, project, tags, confidence, source, created_at, recall_count, invalidated)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0)
    `).run('low-conf', 'Barely there', 'pitfall', 'proj-a', '[]', 0.05, 'learned', oldDate.toISOString());

    const { deleted } = applyConfidenceDecay(db);
    assert.ok(deleted > 0, 'Should have deleted low-confidence memory');

    const mem = memoryRepo.findById('low-conf');
    assert.equal(mem, null, 'Memory should be gone');
  });

  it('should NOT delete corrections even if low confidence', () => {
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 60);

    db.prepare(`
      INSERT INTO memories (id, content, kind, project, tags, confidence, source, created_at, recall_count, invalidated)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0)
    `).run('corr-low', 'User correction', 'correction', null, '[]', 0.05, 'user', oldDate.toISOString());

    applyConfidenceDecay(db);
    const mem = memoryRepo.findById('corr-low');
    assert.ok(mem, 'Corrections should not be auto-deleted');
  });
});

describe('Snapshot Cleanup', () => {
  it('should remove snapshots older than retention window', () => {
    const oldDate = new Date();
    oldDate.setHours(oldDate.getHours() - 48); // 48 hours ago (beyond 24h retention)

    db.prepare(`
      INSERT INTO compaction_snapshots (id, session_id, project, captured_at)
      VALUES (?, ?, ?, ?)
    `).run('snap1', 'session-old', 'proj-a', oldDate.toISOString());

    db.prepare(`
      INSERT INTO compaction_snapshots (id, session_id, project, captured_at)
      VALUES (?, ?, ?, ?)
    `).run('snap2', 'session-current', 'proj-a', new Date().toISOString());

    const cleaned = cleanupSnapshots(db);
    assert.equal(cleaned, 1);

    const remaining = db.prepare('SELECT COUNT(*) as cnt FROM compaction_snapshots').get() as { cnt: number };
    assert.equal(remaining.cnt, 1);
  });
});

describe('Archived Plan Cleanup', () => {
  it('should remove plans older than retention period', () => {
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 200); // 200 days ago

    db.prepare(`
      INSERT INTO plans (id, project, name, status, created_at, updated_at)
      VALUES (?, ?, ?, 'completed', ?, ?)
    `).run('old-plan', 'proj-a', 'Old plan', oldDate.toISOString(), oldDate.toISOString());

    const cleaned = cleanupArchivedPlans(db);
    assert.equal(cleaned, 1);
  });

  it('should NOT remove recent archived plans', () => {
    const recentDate = new Date();
    recentDate.setDate(recentDate.getDate() - 10); // 10 days ago

    db.prepare(`
      INSERT INTO plans (id, project, name, status, created_at, updated_at)
      VALUES (?, ?, ?, 'completed', ?, ?)
    `).run('recent-plan', 'proj-a', 'Recent plan', recentDate.toISOString(), recentDate.toISOString());

    const cleaned = cleanupArchivedPlans(db);
    assert.equal(cleaned, 0);
  });

  it('should NOT remove active plans', () => {
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 200);

    db.prepare(`
      INSERT INTO plans (id, project, name, status, created_at, updated_at)
      VALUES (?, ?, ?, 'active', ?, ?)
    `).run('active-plan', 'proj-a', 'Active plan', oldDate.toISOString(), oldDate.toISOString());

    const cleaned = cleanupArchivedPlans(db);
    assert.equal(cleaned, 0);
  });
});

describe('Forget Project', () => {
  it('should delete all memories for a project', () => {
    memoryRepo.create({ content: 'Database connection string is postgres://localhost:5432', kind: 'fact', project: 'proj-a' });
    memoryRepo.create({ content: 'Authentication uses JWT tokens with 24h expiry', kind: 'fact', project: 'proj-a' });
    memoryRepo.create({ content: 'Redis cache server runs on default port 6379', kind: 'fact', project: 'proj-b' });

    const deleted = forgetProject(db, 'proj-a');
    assert.equal(deleted, 2);

    assert.equal(memoryRepo.countByProject('proj-a'), 0);
    assert.equal(memoryRepo.countByProject('proj-b'), 1);
  });
});

describe('Stale Project Detection', () => {
  it('should find projects with no recent recall', () => {
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 120); // 120 days ago

    db.prepare(`
      INSERT INTO memories (id, content, kind, project, tags, confidence, source, created_at, recall_count, invalidated)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0)
    `).run('stale-mem', 'Old fact', 'fact', 'stale-proj', '[]', 0.5, 'learned', oldDate.toISOString());

    const stale = findStaleProjects(db);
    assert.ok(stale.includes('stale-proj'));
  });

  it('should NOT flag projects with recent activity', () => {
    memoryRepo.create({ content: 'Fresh fact for active project', kind: 'fact', project: 'active-proj' });

    const stale = findStaleProjects(db);
    assert.ok(!stale.includes('active-proj'));
  });
});

describe('Run Maintenance (integration)', () => {
  it('should run all maintenance tasks without errors', () => {
    // Seed some data
    memoryRepo.create({ content: 'Test memory for maintenance', kind: 'fact', project: 'proj-a' });

    const result = runMaintenance(db, 'current-session');
    assert.ok(typeof result.decayed === 'number');
    assert.ok(typeof result.deleted === 'number');
    assert.ok(typeof result.expired === 'number');
    assert.ok(typeof result.snapshotsCleaned === 'number');
    assert.ok(typeof result.archivedPlansCleaned === 'number');
    assert.ok(typeof result.telemetryCleaned === 'number');
  });
});
