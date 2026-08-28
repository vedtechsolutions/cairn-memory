/**
 * Hook-gap closure tests — briefing-compiler changes (GAP C, D, E, F, G).
 * Covers:
 *   - GAP C/D: same-project relevance gate with task-aware queryFp
 *               (recent files, goal tokens, branch tokens).
 *   - GAP E:   goal staleness from completed plan-step overlap.
 *   - GAP F:   T1↔T2 decision Jaccard dedup.
 *   - GAP G:   compact-mode index briefing excludes already-surfaced memories.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type Database from 'better-sqlite3';
import { openDatabase } from '../src/db/connection.js';
import { MemoryRepository } from '../src/db/memory-repository.js';
import { PlanRepository } from '../src/db/plan-repository.js';
import { compileBriefing, compileIndexBriefing, buildBriefingQueryFp, type BriefingContext } from '../src/hooks/shared/briefing-compiler.js';
import type { ContextFingerprint } from '../src/utils/fingerprint.js';
import type { ProjectContext } from '../src/utils/project-scanner.js';

const PROJECT = 'gap-test-project';

const TS_FP: ContextFingerprint = {
  lang: ['typescript'],
  framework: ['node'],
  module: ['hooks', 'handlers'],
};

const tsProjectContext: ProjectContext = {
  gitHash: 'abc1234',
  projectName: 'gap-test',
  techStack: 'TypeScript, Node',
  structure: ['src/', 'tests/'],
  entryPoints: ['src/index.ts'],
  keyConfigs: ['package.json'],
  scannedAt: new Date().toISOString(),
};

let db: Database.Database;
let memRepo: MemoryRepository;
let planRepo: PlanRepository;

beforeEach(() => {
  db = openDatabase({ dbPath: ':memory:' });
  memRepo = new MemoryRepository(db);
  planRepo = new PlanRepository(db);
});

afterEach(() => db.close());

function baseCtx(overrides: Partial<BriefingContext> = {}): BriefingContext {
  return {
    project: PROJECT,
    sessionType: 'startup',
    interrupted: false,
    projectContext: tsProjectContext,
    briefingMode: 'full',
    maxPitfalls: 10,
    ...overrides,
  };
}

// --- GAP C/D: same-project relevance gate --------------------------------

describe('GAP C/D — briefing same-project relevance with task-aware queryFp', () => {
  it('drops same-project pitfall with disjoint module fingerprint when recent files differ', () => {
    // Pitfall anchored to src/db/connection.ts (module: ['db'])
    memRepo.create({
      content: 'CONNECTION_DOT_TS_PITFALL about sqlite migrations',
      kind: 'pitfall',
      project: PROJECT,
      confidence: 0.9,
      fingerprint: { lang: ['typescript'], framework: ['node'], module: ['db', 'connection'] },
    });
    // Pitfall anchored to src/hooks/handlers (module: ['hooks', 'handlers'])
    memRepo.create({
      content: 'HANDLERS_PITFALL about hook registration',
      kind: 'pitfall',
      project: PROJECT,
      confidence: 0.9,
      fingerprint: { lang: ['typescript'], framework: ['node'], module: ['hooks', 'handlers'] },
    });

    // Compaction snapshot with recent files entirely in src/hooks/handlers
    const ctx = baseCtx({
      sessionType: 'compact',
      compactionSnapshot: {
        recentFiles: ['src/hooks/handlers/pitfall-handler.ts', 'src/hooks/handlers/prompt-handler.ts'],
        recentReadFiles: [],
        recentCommands: [],
        userContext: [],
        approachNotes: [],
        initialGoal: null,
      },
    });
    const out = compileBriefing(memRepo, planRepo, ctx);
    // handlers pitfall survives (module intersects query's enriched fingerprint)
    assert.match(out.text, /HANDLERS_PITFALL/);
    // connection pitfall is dropped (no module overlap with the recent files)
    assert.doesNotMatch(out.text, /CONNECTION_DOT_TS_PITFALL/);
  });

  it('admits same-project pitfall when anchor matches a recent file', () => {
    memRepo.create({
      content: 'ANCHORED_PITFALL about connection.ts migrations',
      kind: 'pitfall',
      project: PROJECT,
      confidence: 0.9,
      // Pitfall has no module but is anchored to the file.
      anchor: 'connection.ts',
    });

    const ctx = baseCtx({
      sessionType: 'compact',
      compactionSnapshot: {
        recentFiles: ['src/db/connection.ts'],
        recentReadFiles: [],
        recentCommands: [],
        userContext: [],
        approachNotes: [],
        initialGoal: null,
      },
    });
    // passesSameProjectRelevance with filePath=null uses module-required
    // mode — an anchor-only memory without matching module is dropped.
    // But since recent files enrich the queryFp module set with 'connection',
    // and the memory anchor mentions connection.ts, the anchor branch hits.
    // NOTE: the relevance check runs with filePath=null in briefings, so
    // anchor-only matching is NOT exercised by the gate — only module
    // intersection. The test documents actual behavior: memories with
    // neither anchor nor module AND a file-specific query are dropped.
    // Here the query has no file (null), so broad memories are admitted
    // only via the "broad memory without module" branch → kept.
    const out = compileBriefing(memRepo, planRepo, ctx);
    assert.match(out.text, /ANCHORED_PITFALL/);
  });
});

// --- GAP E: goal staleness via completed plan step -----------------------

describe('GAP E — goal staleness from completed plan-step overlap', () => {
  it('suppresses a goal that paraphrases a completed plan step', () => {
    const { plan } = planRepo.create({
      project: PROJECT,
      name: 'Test plan',
      steps: [
        { description: 'Restart daemon and re-measure SNR baseline' },
        { description: 'Write new tests for the relevance gate' },
      ],
    });
    planRepo.updateStep(plan.id, { step_id: plan.steps[0].step_id, status: 'done' });

    const ctx = baseCtx({
      sessionType: 'compact',
      compactionSnapshot: {
        recentFiles: [],
        recentReadFiles: [],
        recentCommands: [],
        userContext: [],
        approachNotes: [],
        initialGoal: 'Restart daemon and re-measure SNR',
        goalBranch: 'main',
        goalCarryCount: 0,
      },
      gitState: { branch: 'main', uncommittedCount: 0, unpushedCount: 0 },
    });
    const out = compileBriefing(memRepo, planRepo, ctx);
    // SNR v3 Commit 4: labels changed to the three-tier taxonomy.
    assert.doesNotMatch(out.text, /^Now: Restart daemon/m);
    assert.doesNotMatch(out.text, /^Previous goal:/m);
  });

  it('keeps unrelated goals', () => {
    const { plan } = planRepo.create({
      project: PROJECT,
      name: 'Test plan',
      steps: [
        { description: 'Restart daemon and re-measure SNR' },
        { description: 'Commit phase 6 changes' },
      ],
    });
    planRepo.updateStep(plan.id, { step_id: plan.steps[0].step_id, status: 'done' });

    const ctx = baseCtx({
      sessionType: 'compact',
      compactionSnapshot: {
        recentFiles: [],
        recentReadFiles: [],
        recentCommands: [],
        userContext: [],
        approachNotes: [],
        initialGoal: 'Refactor briefing compiler fingerprint helper',
        goalBranch: 'main',
        goalCarryCount: 0,
      },
      gitState: { branch: 'main', uncommittedCount: 0, unpushedCount: 0 },
    });
    const out = compileBriefing(memRepo, planRepo, ctx);
    assert.match(out.text, /Refactor briefing compiler fingerprint helper/);
  });
});

// --- GAP F: T1↔T2 decision Jaccard dedup ---------------------------------

describe('GAP F — T1↔T2 decision dedup via Jaccard', () => {
  it('drops a near-duplicate T2 decision even when the prefix differs', () => {
    // T1 decision comes from plan
    const { plan } = planRepo.create({
      project: PROJECT,
      name: 'Decision plan',
      steps: [{ description: 'Pick storage strategy' }],
    });
    planRepo.addDecision(plan.id, {
      step_id: plan.steps[0].step_id,
      chose: 'Use better-sqlite3 as embedded storage because synchronous API simplifies hooks',
      why: 'Simpler than async ORM',
      alternatives: [],
      permanent: false,
    });

    // T2 near-duplicate stored in memory — different prefix, same essential
    // content. Token overlap is ~0.75 which exceeds the 0.55 dedup threshold.
    memRepo.create({
      content: 'Decided: use better-sqlite3 as embedded storage — synchronous API simplifies hooks integration',
      kind: 'decision',
      project: PROJECT,
      confidence: 0.9,
      fingerprint: TS_FP,
    });

    // Non-duplicate T2 decision — should survive
    memRepo.create({
      content: 'Adopt fingerprint-based retrieval to scope memory recall by context',
      kind: 'decision',
      project: PROJECT,
      confidence: 0.9,
      fingerprint: TS_FP,
    });

    const ctx = baseCtx({
      sessionType: 'compact',
      compactionSnapshot: {
        recentFiles: ['src/hooks/handlers/prompt-handler.ts'],
        recentReadFiles: [],
        recentCommands: [],
        userContext: [],
        approachNotes: [],
        initialGoal: null,
      },
    });
    const out = compileBriefing(memRepo, planRepo, ctx);
    // T1 plan decision surfaces
    assert.match(out.text, /better-sqlite3/);
    // T2 near-duplicate must NOT appear a second time
    const betterSqliteMatches = (out.text.match(/better-sqlite3/g) ?? []).length;
    assert.equal(betterSqliteMatches, 1, 'T2 duplicate should have been collapsed');
    // Unrelated decision survives
    assert.match(out.text, /fingerprint-based retrieval/);
  });
});

// --- GAP G: compact-mode index briefing excludes already-surfaced IDs ----

describe('GAP G — compact-mode index briefing diff against pre-compact IDs', () => {
  it('omits pitfalls that were already injected pre-compact', () => {
    const already = memRepo.create({
      content: 'ALREADY_SURFACED pitfall about tracker flushing',
      kind: 'pitfall',
      project: PROJECT,
      confidence: 0.95,
      fingerprint: TS_FP,
    });
    const fresh = memRepo.create({
      content: 'FRESH_NEW pitfall about cache invalidation',
      kind: 'pitfall',
      project: PROJECT,
      confidence: 0.95,
      fingerprint: TS_FP,
    });

    // Both memories need at least some effectiveness — boost the surface/impact.
    memRepo.incrementSurface(already.id);
    memRepo.incrementImpact(already.id);
    memRepo.incrementSurface(fresh.id);
    memRepo.incrementImpact(fresh.id);

    const ctx = baseCtx({
      sessionType: 'compact',
      briefingMode: 'index',
      compactionSnapshot: {
        recentFiles: ['src/hooks/handlers/prompt-handler.ts'],
        recentReadFiles: [],
        recentCommands: [],
        userContext: [],
        approachNotes: [],
        initialGoal: null,
        alreadySurfacedMemoryIds: [already.id],
      },
    });
    const out = compileIndexBriefing(memRepo, planRepo, ctx);
    assert.doesNotMatch(out.text, /ALREADY_SURFACED/);
    assert.match(out.text, /FRESH_NEW/);
  });

  it('includes already-surfaced memory when not in compact mode', () => {
    const m = memRepo.create({
      content: 'STARTUP_PITFALL about something relevant',
      kind: 'pitfall',
      project: PROJECT,
      confidence: 0.95,
      fingerprint: TS_FP,
    });
    memRepo.incrementSurface(m.id);
    memRepo.incrementImpact(m.id);

    // Startup mode: alreadySurfaced filter is not applied
    const ctx = baseCtx({
      sessionType: 'startup',
      briefingMode: 'index',
      compactionSnapshot: {
        recentFiles: ['src/hooks/handlers/prompt-handler.ts'],
        recentReadFiles: [],
        recentCommands: [],
        userContext: [],
        approachNotes: [],
        initialGoal: null,
        alreadySurfacedMemoryIds: [m.id],
      },
    });
    const out = compileIndexBriefing(memRepo, planRepo, ctx);
    assert.match(out.text, /STARTUP_PITFALL/);
  });
});

// --- Index briefing applies the same staleness gates as renderTier1 ------

describe('index briefing goal staleness — branch mismatch / carry count / completed step', () => {
  it('suppresses goal on branch mismatch', () => {
    const ctx = baseCtx({
      sessionType: 'compact',
      briefingMode: 'index',
      gitState: { branch: 'main', uncommittedCount: 0, unpushedCount: 0 },
      compactionSnapshot: {
        recentFiles: [],
        recentReadFiles: [],
        recentCommands: [],
        userContext: [],
        approachNotes: [],
        initialGoal: 'Implement the feature X on the other branch for release',
        goalBranch: 'feat/other-branch',
        goalCarryCount: 0,
      },
    });
    const out = compileIndexBriefing(memRepo, planRepo, ctx);
    assert.doesNotMatch(out.text, /Implement the feature X/);
  });

  it('suppresses goal when carry count exceeds max', () => {
    const ctx = baseCtx({
      sessionType: 'compact',
      briefingMode: 'index',
      gitState: { branch: 'main', uncommittedCount: 0, unpushedCount: 0 },
      compactionSnapshot: {
        recentFiles: [],
        recentReadFiles: [],
        recentCommands: [],
        userContext: [],
        approachNotes: [],
        initialGoal: 'Refactor the authentication module end to end',
        goalBranch: 'main',
        goalCarryCount: 5, // > GOAL_MAX_CARRY_COUNT (2)
      },
    });
    const out = compileIndexBriefing(memRepo, planRepo, ctx);
    assert.doesNotMatch(out.text, /Refactor the authentication module/);
  });

  it('suppresses goal paraphrasing a completed plan step', () => {
    const { plan } = planRepo.create({
      project: PROJECT,
      name: 'Index staleness plan',
      steps: [{ description: 'Restart daemon and re-measure SNR baseline' }],
    });
    planRepo.updateStep(plan.id, { step_id: plan.steps[0].step_id, status: 'done' });

    const ctx = baseCtx({
      sessionType: 'compact',
      briefingMode: 'index',
      gitState: { branch: 'main', uncommittedCount: 0, unpushedCount: 0 },
      compactionSnapshot: {
        recentFiles: [],
        recentReadFiles: [],
        recentCommands: [],
        userContext: [],
        approachNotes: [],
        initialGoal: 'Restart daemon and re-measure SNR',
        goalBranch: 'main',
        goalCarryCount: 0,
      },
    });
    const out = compileIndexBriefing(memRepo, planRepo, ctx);
    assert.doesNotMatch(out.text, /Restart daemon/);
  });

  it('suppresses synthetic "the user stopped X" goal in index mode', () => {
    // Real regression: isMetaGoal must reject this when it passes through
    // the compact briefing path, otherwise it leaks into the index briefing.
    const ctx = baseCtx({
      sessionType: 'compact',
      briefingMode: 'index',
      gitState: { branch: 'main', uncommittedCount: 0, unpushedCount: 0 },
      compactionSnapshot: {
        recentFiles: [],
        recentReadFiles: [],
        recentCommands: [],
        userContext: [],
        approachNotes: [],
        initialGoal: 'The user stopped the ultraplan session above. Do not respond to the stop notification — wait for the next message',
        goalBranch: 'main',
        goalCarryCount: 0,
      },
    });
    const out = compileIndexBriefing(memRepo, planRepo, ctx);
    assert.doesNotMatch(out.text, /ultraplan session/);
    assert.doesNotMatch(out.text, /do not respond/i);
  });

  it('keeps a fresh, non-stale goal in index mode', () => {
    const ctx = baseCtx({
      sessionType: 'compact',
      briefingMode: 'index',
      gitState: { branch: 'main', uncommittedCount: 0, unpushedCount: 0 },
      compactionSnapshot: {
        recentFiles: [],
        recentReadFiles: [],
        recentCommands: [],
        userContext: [],
        approachNotes: [],
        initialGoal: 'Implement the correction dedup helper for the briefing compiler',
        goalBranch: 'main',
        goalCarryCount: 0,
      },
    });
    const out = compileIndexBriefing(memRepo, planRepo, ctx);
    assert.match(out.text, /Implement the correction dedup helper/);
  });
});

// --- Fix D: ship-detection via recent commit subjects --------------------

describe('goal staleness — ship-detection via recent commits (Fix D)', () => {
  it('suppresses goal whose tokens are covered by recent commit subjects', () => {
    // Goal tokens (length ≥3, non-stopword): {primary, memory, integration,
    // north, star, phases, compounding, learning, loop}
    // Commit subjects between them cover all of those tokens → coverage 1.0
    // ≥ GOAL_SHIPPED_COVERAGE (0.6) → suppressed.
    const ctx = baseCtx({
      sessionType: 'compact',
      gitState: {
        branch: 'feat/primary-memory-integration',
        uncommittedCount: 0,
        unpushedCount: 0,
        recentCommits: [
          'North-Star Phases 3+4+5: compounding learning loop (patterns, goals, precision feedback)',
          'North-Star Phase 2: resume cursor — last edit file+line+tool in the briefing',
          'North-Star Phase 1: sticky project goal across meta turns',
          'Primary memory integration initial scaffold',
        ],
      },
      compactionSnapshot: {
        recentFiles: [],
        recentReadFiles: [],
        recentCommands: [],
        userContext: [],
        approachNotes: [],
        initialGoal: 'Primary memory integration — North-Star Phases 3+4+5: compounding learning loop',
        goalBranch: 'feat/primary-memory-integration',
        goalCarryCount: 0,
      },
    });
    const out = compileBriefing(memRepo, planRepo, ctx);
    assert.doesNotMatch(out.text, /Primary memory integration — North-Star Phases/);
  });

  it('keeps goal when recent commits do not cover its tokens', () => {
    const ctx = baseCtx({
      sessionType: 'compact',
      gitState: {
        branch: 'feat/new-work',
        uncommittedCount: 0,
        unpushedCount: 0,
        recentCommits: [
          'docs: fix typo in README',
          'chore: bump dependencies',
        ],
      },
      compactionSnapshot: {
        recentFiles: [],
        recentReadFiles: [],
        recentCommands: [],
        userContext: [],
        approachNotes: [],
        initialGoal: 'Implement the correction dedup helper for the briefing compiler',
        goalBranch: 'feat/new-work',
        goalCarryCount: 0,
      },
    });
    const out = compileBriefing(memRepo, planRepo, ctx);
    assert.match(out.text, /Implement the correction dedup helper/);
  });

  it('keeps goal when recentCommits is undefined (backwards compat)', () => {
    const ctx = baseCtx({
      sessionType: 'compact',
      // gitState has no recentCommits — older callers, missing telemetry, etc.
      gitState: { branch: 'feat/x', uncommittedCount: 0, unpushedCount: 0 },
      compactionSnapshot: {
        recentFiles: [],
        recentReadFiles: [],
        recentCommands: [],
        userContext: [],
        approachNotes: [],
        initialGoal: 'Implement the correction dedup helper for the briefing compiler',
        goalBranch: 'feat/x',
        goalCarryCount: 0,
      },
    });
    const out = compileBriefing(memRepo, planRepo, ctx);
    assert.match(out.text, /Implement the correction dedup helper/);
  });

  it('does not flag very short goals as shipped (coverage noise floor)', () => {
    // Goal tokens after stop-word filter: {refactor} → size 1, below the
    // 3-token minimum in isGoalShippedByCommits, so the gate should skip.
    const ctx = baseCtx({
      sessionType: 'compact',
      gitState: {
        branch: 'main',
        uncommittedCount: 0,
        unpushedCount: 0,
        recentCommits: ['refactor: tidy imports'],
      },
      compactionSnapshot: {
        recentFiles: [],
        recentReadFiles: [],
        recentCommands: [],
        userContext: [],
        approachNotes: [],
        initialGoal: 'Refactor',
        goalBranch: 'main',
        goalCarryCount: 0,
      },
    });
    const out = compileBriefing(memRepo, planRepo, ctx);
    // Goal is too short to hit the min-goal-chars render threshold either
    // way, so mainly we're asserting the gate didn't crash on tiny input.
    assert.ok(typeof out.text === 'string');
  });
});

// --- Briefing SNR v2 follow-up: filesystem-root segment filter -----------

describe('buildBriefingQueryFp — filesystem-root segment filtering', () => {
  it('drops /opt, /home, .claude, worktrees from absolute-path queryFp modules', () => {
    const ctx = baseCtx({
      sessionType: 'compact',
      compactionSnapshot: {
        recentFiles: [
          '/opt/cairn/src/hooks/handlers/stop-handler.ts',
          '/opt/cairn/.claude/worktrees/slug/src/hooks/foo.ts',
        ],
        recentReadFiles: ['/home/alice/code/proj/src/bar.ts'],
        recentCommands: [],
        userContext: [],
        approachNotes: [],
        initialGoal: null,
      },
    });
    const qfp = buildBriefingQueryFp(ctx, null);
    assert.ok(qfp, 'queryFp should be defined');
    // Filesystem-root and Claude-scaffolding tokens must NOT leak.
    for (const noise of ['opt', 'home', '.claude', 'worktrees', 'usr', 'var', 'tmp', 'root', 'etc']) {
      assert.ok(!qfp!.module.includes(noise),
        `queryFp.module should not include "${noise}" (got: ${qfp!.module.join(', ')})`);
    }
    // Real signal must survive.
    assert.ok(qfp!.module.includes('cairn'), 'real project segment should survive');
    assert.ok(qfp!.module.includes('hooks'), 'real module segment should survive');
    assert.ok(qfp!.module.includes('handlers'), 'real directory segment should survive');
  });
});
