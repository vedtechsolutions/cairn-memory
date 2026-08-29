import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type Database from 'better-sqlite3';
import { openDatabase } from '../src/db/connection.js';
import { MemoryRepository } from '../src/db/memory-repository.js';
import { PlanRepository } from '../src/db/plan-repository.js';
import { compileBriefing, compileIndexBriefing, type BriefingContext } from '../src/hooks/shared/briefing-compiler.js';
import { BRIEFING_MODE } from '../src/constants/index.js';

let db: Database.Database;
let memoryRepo: MemoryRepository;
let planRepo: PlanRepository;

beforeEach(() => {
  db = openDatabase({ dbPath: ':memory:' });
  memoryRepo = new MemoryRepository(db);
  planRepo = new PlanRepository(db);
});

afterEach(() => {
  db.close();
});

function seedMemories(): { decisionId: string; pitfallId: string; correctionId: string } {
  const dec = memoryRepo.storeDecision({
    content: 'Use sqlite-vec over pgvector for single-file deployment simplicity',
    project: 'test-proj',
    context: { why: 'avoid external database dependencies', how_to_apply: 'check sqlite-vec docs' },
  });
  const pit = memoryRepo.storePitfall({
    content: 'Never commit credentials to the repo — scan the diff before push',
    project: 'test-proj',
    confidence: 0.9,
  });
  const cor = memoryRepo.create({
    content: 'Always validate user input at the API boundary, not deeper',
    kind: 'correction',
    project: 'test-proj',
  });
  return {
    decisionId: dec.id,
    pitfallId: pit.id,
    correctionId: cor.id,
  };
}

describe('compileIndexBriefing', () => {
  it('emits a compact index briefing with stable ID prefixes', () => {
    const ids = seedMemories();
    const ctx: BriefingContext = {
      project: 'test-proj',
      sessionType: 'compact',
      interrupted: false,
    };

    const result = compileIndexBriefing(memoryRepo, planRepo, ctx);

    assert.ok(result.text.startsWith('[Waykeep Memory Briefing — index]'));
    assert.ok(result.text.includes(`dec:${ids.decisionId.slice(0, 8)}`), 'must include decision prefix');
    assert.ok(result.text.includes(`pit:${ids.pitfallId.slice(0, 8)}`), 'must include pitfall prefix');
    assert.ok(result.text.includes(`cor:${ids.correctionId.slice(0, 8)}`), 'must include correction prefix');
    assert.ok(result.text.includes('cairn_expand'), 'footer must mention cairn_expand');
  });

  it('uses one-line entries per memory (structural progressive-disclosure property)', () => {
    // Progressive-disclosure design: every memory entry in the index briefing
    // is a single line with a stable type-coded ID prefix. The "smaller than
    // full" property depends on effectiveness filtering and corpus size so
    // it is not a hard invariant we can enforce in a unit test. The invariant
    // we CAN enforce is that every emitted memory line is a single short
    // entry that fits in one line, and the footer mentions cairn_expand.
    const ids = seedMemories();
    const result = compileIndexBriefing(memoryRepo, planRepo, {
      project: 'test-proj',
      sessionType: 'compact',
      interrupted: false,
    });

    const decLine = result.text.split('\n').find(l => l.includes(`dec:${ids.decisionId.slice(0, 8)}`));
    const pitLine = result.text.split('\n').find(l => l.includes(`pit:${ids.pitfallId.slice(0, 8)}`));
    const corLine = result.text.split('\n').find(l => l.includes(`cor:${ids.correctionId.slice(0, 8)}`));

    assert.ok(decLine, 'decision line must be present');
    assert.ok(pitLine, 'pitfall line must be present');
    assert.ok(corLine, 'correction line must be present');

    // Each memory entry must be a single line — no newlines inside the entry,
    // no multi-line "why: ..." expansion like the full briefing uses. Detail
    // is pulled via cairn_expand, not inlined here.
    assert.ok(decLine!.length <= BRIEFING_MODE.INDEX_LINE_MAX_CHARS + 30, 'decision line must fit one line');
    assert.ok(pitLine!.length <= BRIEFING_MODE.INDEX_LINE_MAX_CHARS + 30, 'pitfall line must fit one line');
    assert.ok(corLine!.length <= BRIEFING_MODE.INDEX_LINE_MAX_CHARS + 30, 'correction line must fit one line');

    // The footer must point at cairn_expand so the model knows how to pull detail.
    assert.ok(result.text.includes('cairn_expand'), 'footer must mention cairn_expand');
  });

  it('compileBriefing routes to index mode when briefingMode=index', () => {
    seedMemories();
    const ctx: BriefingContext = {
      project: 'test-proj',
      sessionType: 'compact',
      interrupted: false,
      briefingMode: 'index',
    };

    const result = compileBriefing(memoryRepo, planRepo, ctx);
    assert.ok(result.text.includes('[Waykeep Memory Briefing — index]'));
  });

  it('auto mode picks full on startup, index on bare compact', () => {
    seedMemories();
    const base: BriefingContext = {
      project: 'test-proj',
      sessionType: 'startup',
      interrupted: false,
      briefingMode: 'auto',
    };

    const startup = compileBriefing(memoryRepo, planRepo, base);
    assert.ok(!startup.text.includes('index'), 'auto+startup must use full format');

    // Compact WITHOUT a compactionSnapshot still falls through to index (e.g. if
    // the PreCompact hook failed to write a snapshot). The recovery-routing
    // override only fires when snapshot data is actually present.
    const compact = compileBriefing(memoryRepo, planRepo, { ...base, sessionType: 'compact' });
    assert.ok(compact.text.includes('[Waykeep Memory Briefing — index]'), 'auto+compact (no snapshot) must use index format');
  });

  it('auto mode routes compact+snapshot to full briefing for recovery fidelity', () => {
    // Regression: post-compact sessions MUST use the full briefing when a
    // compactionSnapshot exists. The index path only renders goal + open
    // questions and drops decisions, read/modified files, approach notes,
    // hypotheses, and error context — exactly the fields PreCompact stored
    // for recovery. Routing through renderTier1 is the whole point of the
    // snapshot.
    seedMemories();
    const result = compileBriefing(memoryRepo, planRepo, {
      project: 'test-proj',
      sessionType: 'compact',
      interrupted: false,
      briefingMode: 'auto',
      compactionSnapshot: {
        recentFiles: ['src/auth/login.ts', 'src/auth/session.ts'],
        recentReadFiles: ['src/db/schema.ts'],
        recentCommands: [],
        userContext: [],
        approachNotes: ['Refactor session handling to use the new token store'],
        initialGoal: 'Refactor authentication to use JWT tokens',
        recentDecisions: [{ chose: 'Use RS256 for JWT signing', why: 'asymmetric keys simplify rotation' }],
      },
    });

    assert.ok(
      !result.text.includes('[Waykeep Memory Briefing — index]'),
      'compact+snapshot must NOT use the index briefing header',
    );
    // Goal / decisions / files / approach come from the snapshot and are
    // rendered only by renderTier1 — their presence proves we took the full path.
    assert.ok(result.text.includes('Refactor authentication to use JWT tokens'), 'goal from snapshot must appear');
    assert.ok(result.text.includes('RS256'), 'decision from snapshot must appear');
    assert.ok(result.text.includes('login.ts'), 'recently modified file basename must appear');
    assert.ok(result.text.includes('schema.ts'), 'recently read file basename must appear');
    assert.ok(result.text.includes('Refactor session handling'), 'approach note must appear');
  });

  it('index mode filters corrections already surfaced pre-compact (GAP G symmetry)', () => {
    // Regression: corrections must respect alreadySurfacedMemoryIds the same
    // way decisions and pitfalls do. Without this filter, corrections
    // re-surface in the post-compact index briefing even though Claude
    // already has them in context.
    const ids = seedMemories();

    // Compact WITH snapshot would normally route to full. Force index mode
    // explicitly to exercise the compileIndexBriefing correction filter.
    const filtered = compileBriefing(memoryRepo, planRepo, {
      project: 'test-proj',
      sessionType: 'compact',
      interrupted: false,
      briefingMode: 'index',
      compactionSnapshot: {
        recentFiles: [],
        recentReadFiles: [],
        recentCommands: [],
        userContext: [],
        approachNotes: [],
        initialGoal: null,
        alreadySurfacedMemoryIds: [ids.correctionId],
      },
    });

    assert.ok(
      !filtered.text.includes(`cor:${ids.correctionId.slice(0, 8)}`),
      'correction id in alreadySurfacedMemoryIds must be filtered from index briefing',
    );

    // Baseline: without the alreadySurfaced set, the correction does surface.
    const baseline = compileBriefing(memoryRepo, planRepo, {
      project: 'test-proj',
      sessionType: 'compact',
      interrupted: false,
      briefingMode: 'index',
    });
    assert.ok(
      baseline.text.includes(`cor:${ids.correctionId.slice(0, 8)}`),
      'correction surfaces normally without alreadySurfaced filter (baseline)',
    );
  });

  it('default BRIEFING_MODE.DEFAULT is full for backward compatibility', () => {
    assert.equal(BRIEFING_MODE.DEFAULT, 'full');
  });

  it('respects entry caps in BRIEFING_MODE.INDEX_MAX_*', () => {
    // Seed more memories than the caps
    for (let i = 0; i < BRIEFING_MODE.INDEX_MAX_PITFALLS + 3; i++) {
      memoryRepo.storePitfall({
        content: `Test pitfall #${i} — never do the wrong thing in case ${i}`,
        project: 'test-proj',
        confidence: 0.8,
      });
    }

    const result = compileIndexBriefing(memoryRepo, planRepo, {
      project: 'test-proj',
      sessionType: 'compact',
      interrupted: false,
    });

    // Count pitfall entry lines in the result
    const pitfallLines = result.text.split('\n').filter(l => l.trim().startsWith('[pit:'));
    assert.ok(
      pitfallLines.length <= BRIEFING_MODE.INDEX_MAX_PITFALLS,
      `expected at most ${BRIEFING_MODE.INDEX_MAX_PITFALLS} pitfall entries, got ${pitfallLines.length}`,
    );
  });
});

describe('MemoryRepository.findByShortId', () => {
  it('resolves a unique short-id prefix to the full memory', () => {
    const { decisionId } = seedMemories();
    const shortId = decisionId.slice(0, 8);
    const found = memoryRepo.findByShortId(shortId);
    assert.ok(found);
    assert.equal(found.id, decisionId);
  });

  it('returns null for an unknown short-id', () => {
    seedMemories();
    assert.equal(memoryRepo.findByShortId('00000000'), null);
  });

  it('returns null for a too-short query', () => {
    seedMemories();
    assert.equal(memoryRepo.findByShortId('ab'), null);
  });
});
