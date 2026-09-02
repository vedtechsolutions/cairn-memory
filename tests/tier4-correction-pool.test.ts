/**
 * M9 (step 6): the Tier-4 corrections query took the top-6 by confidence and
 * only THEN filtered for structural eligibility — six high-confidence junk
 * rows starved the tier while eligible corrections sat at rank 7+. The pool
 * must be filtered BEFORE the display limit.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type Database from 'better-sqlite3';
import { openDatabase } from '../src/db/connection.js';
import { MemoryRepository } from '../src/db/memory-repository.js';
import { PlanRepository } from '../src/db/plan-repository.js';
import { compileBriefing, type BriefingContext } from '../src/hooks/shared/briefing-compiler.js';

let db: Database.Database;
let memRepo: MemoryRepository;
let planRepo: PlanRepository;

const PROJECT = 'proj-tier4';
const TS_CONTEXT = {
  gitHash: 'aaa', projectName: 'tier4', techStack: 'TypeScript, Node',
  structure: ['src/'], entryPoints: ['src/index.ts'], keyConfigs: ['package.json'],
  scannedAt: new Date().toISOString(),
};

beforeEach(() => {
  db = openDatabase({ dbPath: ':memory:' });
  memRepo = new MemoryRepository(db);
  planRepo = new PlanRepository(db);
});

afterEach(() => db.close());

describe('Tier-4 corrections: filter before the limit (M9)', () => {
  it('an eligible correction surfaces even when 6 ineligible rows outrank it by confidence', () => {
    // Six structurally ineligible corrections (raw multi-line pastes fail
    // isCorrectionQuality) at TOP confidence…
    // These fail isCorrectionQuality's actual reject patterns (imperative
    // lead-ins), not an imagined structural check.
    for (let i = 0; i < 6; i++) {
      memRepo.create({
        content: `please go back and rework the raw pasted junk request number ${i} in the billing module immediately`,
        kind: 'correction', project: PROJECT, confidence: 0.95, skipDedup: true,
      });
    }
    // …and ONE eligible distilled correction below them.
    memRepo.create({
      content: 'Always run the build before claiming completion because tsc emits before erroring.',
      // Project-scoped: a null-fingerprint GLOBAL would be dropped by the
      // cross-project guard (GAP K) — that is not what this gate probes.
      kind: 'correction', project: PROJECT, confidence: 0.7,
    });

    const ctx: BriefingContext = {
      project: PROJECT,
      sessionType: 'startup',
      interrupted: false,
      projectContext: TS_CONTEXT,
      briefingMode: 'full',
    } as unknown as BriefingContext;
    const out = compileBriefing(memRepo, planRepo, ctx);
    const text = typeof out === 'string' ? out : (out as { text: string }).text;
    assert.ok(text.includes('Always run the build before claiming completion'),
      'the eligible correction must not be starved out by ineligible higher-confidence rows');
    assert.ok(!text.includes('raw pasted junk'), 'junk stays excluded');
  });
});

describe('briefing topPitfalls popularity cap (step 6 carry-in)', () => {
  it('a massively-recalled pitfall cannot outrank purely on count — the multiplier caps at 5', () => {
    const db2 = openDatabase({ dbPath: ':memory:' });
    try {
      const repo2 = new MemoryRepository(db2);
      // popular: mid confidence, enormous recall_count. rival: higher
      // confidence, capped-count. Under the uncapped multiplier popular
      // wins (0.7×101 >> 0.9×6); under MIN(count,5): 0.7×6=4.2 < 0.9×6=5.4.
      const pop = repo2.create({ content: 'popular pitfall about flaky sockets', kind: 'pitfall', project: 'proj-cap', confidence: 0.7 });
      db2.prepare('UPDATE memories SET recall_count = 100 WHERE id = ?').run(pop.id);
      const rival = repo2.create({ content: 'rival pitfall about flaky sockets handling', kind: 'pitfall', project: 'proj-cap', confidence: 0.9, skipDedup: true });
      db2.prepare('UPDATE memories SET recall_count = 5 WHERE id = ?').run(rival.id);
      const top = repo2.topPitfalls('proj-cap', 1);
      assert.equal(top[0].id, rival.id,
        'confidence with a bounded popularity term must beat raw popularity');
    } finally {
      db2.close();
    }
  });
});
