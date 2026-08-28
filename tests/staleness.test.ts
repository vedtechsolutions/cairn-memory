import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type Database from 'better-sqlite3';
import { openDatabase } from '../src/db/connection.js';
import { MemoryRepository } from '../src/db/memory-repository.js';
import {
  weakenZeroImpactPitfalls,
  weakenStaleFingerprintMemories,
  weakenDeletedFileMemories,
  runStalenessDetection,
} from '../src/db/maintenance.js';
import { STALENESS, CONFIDENCE } from '../src/constants/index.js';
import { getProjectModuleTerms } from '../src/utils/project-scanner.js';

function createTestDb() {
  return openDatabase({ dbPath: ':memory:' });
}

function createMemory(
  repo: MemoryRepository,
  overrides: {
    content?: string;
    kind?: string;
    confidence?: number;
    fingerprint?: { lang: string[]; framework: string[]; module: string[] };
    tags?: string[];
  } = {},
): string {
  const result = repo.create({
    content: overrides.content ?? 'Test pitfall content',
    kind: (overrides.kind ?? 'pitfall') as 'pitfall' | 'decision' | 'correction' | 'fact',
    project: 'test-project',
    tags: overrides.tags ?? [],
    confidence: overrides.confidence ?? 0.7,
    fingerprint: overrides.fingerprint,
  });
  return result.id;
}

// --- Phase 1: Zero-Impact Pitfall Weakening ---

describe('Phase 1 — Zero-Impact Pitfall Weakening', () => {
  let db: Database.Database;
  let repo: MemoryRepository;

  beforeEach(() => {
    db = createTestDb();
    repo = new MemoryRepository(db);
  });

  it('should weaken pitfalls with high surface count and zero impact', () => {
    const id = createMemory(repo, { confidence: 0.7 });

    // Simulate 6 surfaces with 0 impact
    for (let i = 0; i < 6; i++) repo.incrementSurface(id);

    const weakened = weakenZeroImpactPitfalls(db);
    assert.equal(weakened, 1);

    const row = db.prepare('SELECT confidence FROM memories WHERE id = ?').get(id) as { confidence: number };
    assert.ok(row.confidence < 0.7, `Confidence should decrease from 0.7, got ${row.confidence}`);
  });

  it('should NOT weaken pitfalls with some impact', () => {
    const id = createMemory(repo, { confidence: 0.7 });

    for (let i = 0; i < 6; i++) repo.incrementSurface(id);
    repo.incrementImpact(id); // 1 impact

    const weakened = weakenZeroImpactPitfalls(db);
    assert.equal(weakened, 0);
  });

  it('should NOT weaken pitfalls below surface threshold', () => {
    const id = createMemory(repo, { confidence: 0.7 });

    for (let i = 0; i < 3; i++) repo.incrementSurface(id);

    const weakened = weakenZeroImpactPitfalls(db);
    assert.equal(weakened, 0);
  });

  it('should NOT weaken non-pitfall kinds', () => {
    const id = createMemory(repo, { kind: 'fact', confidence: 0.7 });

    for (let i = 0; i < 6; i++) repo.incrementSurface(id);

    const weakened = weakenZeroImpactPitfalls(db);
    assert.equal(weakened, 0);
  });

  it('should respect the weaken floor', () => {
    const id = createMemory(repo, { confidence: 0.16 });

    for (let i = 0; i < 6; i++) repo.incrementSurface(id);

    weakenZeroImpactPitfalls(db);
    const row = db.prepare('SELECT confidence FROM memories WHERE id = ?').get(id) as { confidence: number };
    assert.ok(row.confidence >= STALENESS.WEAKEN_FLOOR, 'Should not go below floor');
  });
});

// --- Phase 2: Fingerprint Staleness ---

describe('Phase 2 — Fingerprint Staleness Detection', () => {
  let db: Database.Database;
  let repo: MemoryRepository;

  beforeEach(() => {
    db = createTestDb();
    repo = new MemoryRepository(db);
  });

  it('should weaken memories with no module overlap to current project', () => {
    const id = createMemory(repo, {
      confidence: 0.7,
      fingerprint: { lang: ['typescript'], framework: [], module: ['payments', 'stripe'] },
    });

    // Current project has no "payments" or "stripe" directories
    const currentTerms = new Set(['db', 'hooks', 'mcp', 'utils', 'constants']);
    const weakened = weakenStaleFingerprintMemories(db, 'test-project', currentTerms);

    assert.equal(weakened, 1);
    const row = db.prepare('SELECT confidence FROM memories WHERE id = ?').get(id) as { confidence: number };
    assert.ok(row.confidence < 0.7);
  });

  it('should NOT weaken memories with at least one module overlap', () => {
    createMemory(repo, {
      confidence: 0.7,
      fingerprint: { lang: ['typescript'], framework: [], module: ['db', 'memory', 'repository'] },
    });

    const currentTerms = new Set(['db', 'hooks', 'mcp', 'utils', 'constants']);
    const weakened = weakenStaleFingerprintMemories(db, 'test-project', currentTerms);

    assert.equal(weakened, 0);
  });

  it('should NOT weaken memories without fingerprints', () => {
    createMemory(repo, { confidence: 0.7 }); // no fingerprint

    const currentTerms = new Set(['db', 'hooks']);
    const weakened = weakenStaleFingerprintMemories(db, 'test-project', currentTerms);
    assert.equal(weakened, 0);
  });

  it('should NOT weaken memories with empty module array', () => {
    createMemory(repo, {
      confidence: 0.7,
      fingerprint: { lang: ['typescript'], framework: ['node'], module: [] },
    });

    const currentTerms = new Set(['db', 'hooks']);
    const weakened = weakenStaleFingerprintMemories(db, 'test-project', currentTerms);
    assert.equal(weakened, 0);
  });

  it('should handle empty current project terms gracefully', () => {
    createMemory(repo, {
      confidence: 0.7,
      fingerprint: { lang: ['typescript'], framework: [], module: ['db'] },
    });

    const weakened = weakenStaleFingerprintMemories(db, 'test-project', new Set());
    assert.equal(weakened, 0); // empty project terms = skip entirely
  });
});

// --- Phase 3: Git-Delta Deleted File Detection ---

describe('Phase 3 — Deleted File Memory Detection', () => {
  let db: Database.Database;
  let repo: MemoryRepository;

  beforeEach(() => {
    db = createTestDb();
    repo = new MemoryRepository(db);
  });

  it('should weaken memories referencing a deleted file by name', () => {
    const id = createMemory(repo, {
      content: 'Always validate inputs in stripe-handler before processing payments',
      confidence: 0.7,
    });

    // "stripe-handler" was deleted
    const weakened = weakenDeletedFileMemories(db, 'test-project', ['src/payments/stripe-handler.ts']);

    assert.equal(weakened, 1);
    const row = db.prepare('SELECT confidence FROM memories WHERE id = ?').get(id) as { confidence: number };
    assert.ok(row.confidence < 0.7);
  });

  it('should NOT weaken memories that dont match deleted file', () => {
    createMemory(repo, {
      content: 'Always use parameterized queries in database operations',
      confidence: 0.7,
    });

    const weakened = weakenDeletedFileMemories(db, 'test-project', ['src/payments/stripe-handler.ts']);
    assert.equal(weakened, 0);
  });

  it('should handle empty deleted files list', () => {
    createMemory(repo, { content: 'Some memory', confidence: 0.7 });
    const weakened = weakenDeletedFileMemories(db, 'test-project', []);
    assert.equal(weakened, 0);
  });

  it('should skip very short file stems', () => {
    createMemory(repo, { content: 'Something about db module', confidence: 0.7 });
    // stem "db" is only 2 chars — below the 3-char minimum
    const weakened = weakenDeletedFileMemories(db, 'test-project', ['src/db.ts']);
    assert.equal(weakened, 0);
  });
});

// --- runStalenessDetection Integration ---

describe('runStalenessDetection — Integration', () => {
  let db: Database.Database;
  let repo: MemoryRepository;

  beforeEach(() => {
    db = createTestDb();
    repo = new MemoryRepository(db);
  });

  it('should run all three phases and return counts', () => {
    // Phase 1 candidate: high surface, zero impact
    const id1 = createMemory(repo, { content: 'Phase one pitfall about validation errors', confidence: 0.7 });
    for (let i = 0; i < 6; i++) repo.incrementSurface(id1);

    // Phase 2 candidate: stale fingerprint (distinct content to avoid dedup)
    createMemory(repo, {
      content: 'Phase two pitfall about removed feature payments',
      confidence: 0.7,
      fingerprint: { lang: ['python'], framework: [], module: ['removed_feature'] },
    });

    const currentTerms = new Set(['db', 'hooks', 'mcp']);
    const result = runStalenessDetection(db, 'test-project', currentTerms, []);

    assert.equal(result.zeroImpact, 1);
    assert.equal(result.staleFingerprint, 1);
    assert.equal(result.deletedFileRefs, 0);
  });
});

// --- getProjectModuleTerms ---

describe('getProjectModuleTerms', () => {
  // Derive the repo root from this test's compiled location (dist/tests/…) so
  // the scan targets the real checkout on any machine — CI checks out to a
  // different path (…/cairn), not a hardcoded /opt/cairn.
  const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

  it('should extract terms from a real project directory', () => {
    const terms = getProjectModuleTerms(REPO_ROOT);
    assert.ok(terms.size > 0, 'Should extract terms from the repo root');
    assert.ok(terms.has('src'), 'Should contain src');
    assert.ok(terms.has('hooks'), 'Should contain hooks');
    assert.ok(terms.has('db'), 'Should contain db');
    assert.ok(terms.has('utils'), 'Should contain utils');
  });

  it('should not include ignored directories', () => {
    const terms = getProjectModuleTerms(REPO_ROOT);
    assert.ok(!terms.has('node_modules'), 'Should not contain node_modules');
    assert.ok(!terms.has('dist'), 'Should not contain dist');
  });
});

// --- Constants ---

describe('Staleness Constants', () => {
  it('should have reasonable thresholds', () => {
    assert.equal(STALENESS.ZERO_IMPACT_THRESHOLD, 5);
    assert.equal(STALENESS.MAX_SWEEP_BATCH, 50);
    assert.ok(STALENESS.WEAKEN_FLOOR > CONFIDENCE.DELETE_THRESHOLD, 'Floor should be above delete threshold');
  });
});
