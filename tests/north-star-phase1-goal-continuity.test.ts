import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type Database from 'better-sqlite3';
import { openDatabase } from '../src/db/connection.js';
import { SCHEMA_VERSION } from '../src/db/schema.js';
import { MemoryRepository } from '../src/db/memory-repository.js';
import { PlanRepository } from '../src/db/plan-repository.js';
import {
  compileBriefing,
  compileIndexBriefing,
  type BriefingContext,
} from '../src/hooks/shared/briefing-compiler.js';
import { synthesizeBranchGoal } from '../src/utils/branch-goal.js';

// ============================================================================
// Phase 1: Goal Continuity — sticky ambient project goal
//
// Covers:
//   1. Branch-goal synthesizer — base branches, chore branches, enrichment
//   2. Schema migration — project_goal columns present
//   3. Briefing renders "Project goal" line on startup
//   4. Briefing renders "Project goal" line on compact
//   5. Dedup: same text as session goal renders only once
//   6. Source-aware label: branch → "(branch)", plan → "(plan)"
//   7. Index briefing path renders project goal too
//   8. Short (<15 char) goals are suppressed
// ============================================================================

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

describe('synthesizeBranchGoal', () => {
  it('turns feat/ branch into sentence-case goal', () => {
    const result = synthesizeBranchGoal('feat/primary-memory-integration');
    assert.equal(result, 'Primary memory integration');
  });

  it('turns fix/ branch into sentence-case goal', () => {
    const result = synthesizeBranchGoal('fix/login-race-condition');
    assert.equal(result, 'Login race condition');
  });

  it('returns null for base branches (main, master, dev)', () => {
    assert.equal(synthesizeBranchGoal('main'), null);
    assert.equal(synthesizeBranchGoal('master'), null);
    assert.equal(synthesizeBranchGoal('dev'), null);
    assert.equal(synthesizeBranchGoal('develop'), null);
  });

  it('returns null for chore / ci / docs branches', () => {
    assert.equal(synthesizeBranchGoal('chore/deps-bump'), null);
    assert.equal(synthesizeBranchGoal('ci/fix-pipeline'), null);
    assert.equal(synthesizeBranchGoal('docs/readme-update'), null);
  });

  it('returns null for empty / null branches', () => {
    assert.equal(synthesizeBranchGoal(null), null);
    assert.equal(synthesizeBranchGoal(undefined), null);
    assert.equal(synthesizeBranchGoal(''), null);
  });

  it('returns null when the synthesized text is shorter than 12 chars', () => {
    assert.equal(synthesizeBranchGoal('feat/x'), null);
    assert.equal(synthesizeBranchGoal('feat/foo'), null);
  });

  it('enriches branch with novel commit subject tokens', () => {
    const result = synthesizeBranchGoal('feat/user-auth', {
      commitSubject: 'Add email verification flow',
    });
    assert.match(result ?? '', /User auth/);
    assert.match(result ?? '', /email verification flow/);
  });

  it('skips commit enrichment when subject adds no novel tokens', () => {
    const result = synthesizeBranchGoal('feat/user-authentication', {
      commitSubject: 'user authentication',
    });
    // Body and subject overlap completely — no enrichment
    assert.equal(result, 'User authentication');
  });

  it('skips chore / docs / wip commits for enrichment', () => {
    const result = synthesizeBranchGoal('feat/primary-memory-integration', {
      commitSubject: 'chore: bump deps',
    });
    assert.equal(result, 'Primary memory integration');
  });

  it('handles multi-segment branches (feat/api/rate-limit)', () => {
    const result = synthesizeBranchGoal('feat/api/rate-limit');
    assert.match(result ?? '', /Api rate limit/i);
  });

  it('handles bare (no-prefix) branches with enough content', () => {
    const result = synthesizeBranchGoal('user-authentication-redesign');
    assert.equal(result, 'User authentication redesign');
  });
});

describe('Schema migration v20: project_goal columns', () => {
  it('compaction_snapshots has project_goal + project_goal_source columns', () => {
    const cols = db.prepare("PRAGMA table_info('compaction_snapshots')")
      .all() as Array<{ name: string }>;
    const names = cols.map(c => c.name);
    assert.ok(names.includes('project_goal'), 'project_goal column missing');
    assert.ok(names.includes('project_goal_source'), 'project_goal_source column missing');
  });

  it('sessions table has project_goal column', () => {
    const cols = db.prepare("PRAGMA table_info('sessions')")
      .all() as Array<{ name: string }>;
    const names = cols.map(c => c.name);
    assert.ok(names.includes('project_goal'), 'sessions.project_goal column missing');
  });

  it('schema_version is current', () => {
    const row = db.prepare('SELECT version FROM schema_version LIMIT 1')
      .get() as { version: number };
    assert.equal(row.version, SCHEMA_VERSION);
  });
});

// SNR v3 Commit 4: label migration.
//   source='branch' goals now live on ctx.featureGoal (rendered as "Feature:").
//   source ∈ {plan, transcript, user} goals stay on ctx.projectGoal (rendered as "Project:").
//   The per-tier truth lives in tests/goal-tiers.test.ts — these tests are preserved to
//   lock the label contract and dedup behaviour end-to-end.
describe('Briefing renders three-tier goal lines (Commit 4)', () => {
  it('renders a Feature line on startup path when featureGoal is present', () => {
    const ctx: BriefingContext = {
      project: 'test-proj',
      sessionType: 'startup',
      interrupted: false,
      featureGoal: {
        text: 'Primary memory integration — Cairn v5 hook wiring',
        branch: null,
      },
    };
    const briefing = compileBriefing(memoryRepo, planRepo, ctx);
    assert.match(briefing.text, /Feature: Primary memory integration/);
  });

  it('renders a Project line on compact path when projectGoal is present (plan source)', () => {
    const ctx: BriefingContext = {
      project: 'test-proj',
      sessionType: 'compact',
      interrupted: false,
      compactionSnapshot: {
        recentFiles: [],
        recentReadFiles: [],
        recentCommands: [],
        userContext: [],
        approachNotes: [],
        initialGoal: null,
      },
      projectGoal: {
        text: 'Add goal continuity to the briefing compiler',
        source: 'plan',
      },
    };
    const briefing = compileBriefing(memoryRepo, planRepo, ctx);
    assert.match(briefing.text, /Project: Add goal continuity/);
  });

  it('suppresses project goal shorter than 15 chars', () => {
    const ctx: BriefingContext = {
      project: 'test-proj',
      sessionType: 'startup',
      interrupted: false,
      featureGoal: { text: 'Too short', branch: null },
    };
    const briefing = compileBriefing(memoryRepo, planRepo, ctx);
    // Neither tier should render — Feature helper requires length >= 15.
    assert.ok(!briefing.text.includes('Feature:'), 'short feature goal should be suppressed');
  });

  it('dedups Feature against Now when tokens overlap', () => {
    const ctx: BriefingContext = {
      project: 'test-proj',
      sessionType: 'compact',
      interrupted: false,
      compactionSnapshot: {
        recentFiles: [],
        recentReadFiles: [],
        recentCommands: [],
        userContext: [],
        approachNotes: [],
        initialGoal: 'Primary memory integration across hooks and briefing',
        goalBranch: 'feat/primary-memory-integration',
        goalCarryCount: 0,
      },
      gitState: {
        branch: 'feat/primary-memory-integration',
        uncommittedCount: 0,
        unpushedCount: 0,
      },
      featureGoal: {
        text: 'Primary memory integration across hooks',
        branch: 'feat/primary-memory-integration',
      },
    };
    const briefing = compileBriefing(memoryRepo, planRepo, ctx);
    // Now wins the duplicate — Feature must be deduped out.
    assert.match(briefing.text, /Now: Primary memory integration/, 'Now tier must render');
    assert.ok(!briefing.text.includes('Feature:'), 'Feature line should be deduped against overlapping Now');
  });

  it('renders Feature vs Project under distinct labels for distinct sources', () => {
    const base: BriefingContext = {
      project: 'test-proj',
      sessionType: 'startup',
      interrupted: false,
    };
    // Note: the briefing always opens with a top-level "Project: <slug>" line
    // (the project identifier). Regex assertions below anchor on the goal
    // text "ambient" to avoid matching that slug line.
    const goalText = 'Some ambient project goal here';

    const planBriefing = compileBriefing(memoryRepo, planRepo, {
      ...base,
      projectGoal: { text: goalText, source: 'plan' },
    });
    assert.match(planBriefing.text, /Project: Some ambient project goal/);
    assert.ok(!/Feature:\s*Some ambient/.test(planBriefing.text), 'plan source stays in Project tier, no Feature line');

    const branchBriefing = compileBriefing(memoryRepo, planRepo, {
      ...base,
      featureGoal: { text: goalText, branch: null },
    });
    assert.match(branchBriefing.text, /Feature: Some ambient project goal/);
    assert.ok(!/Project:\s*Some ambient/.test(branchBriefing.text), 'branch source stays in Feature tier, no Project goal line');

    const transcriptBriefing = compileBriefing(memoryRepo, planRepo, {
      ...base,
      projectGoal: { text: goalText, source: 'transcript' },
    });
    assert.match(transcriptBriefing.text, /Project: Some ambient project goal/);
  });
});

describe('Index briefing renders three-tier goal lines (Commit 4)', () => {
  it('index briefing includes Project line when projectGoal is set', () => {
    const ctx: BriefingContext = {
      project: 'test-proj',
      sessionType: 'compact',
      interrupted: false,
      compactionSnapshot: {
        recentFiles: [],
        recentReadFiles: [],
        recentCommands: [],
        userContext: [],
        approachNotes: [],
        initialGoal: null,
      },
      projectGoal: {
        text: 'Zero-loss continuity + compounding learning',
        source: 'plan',
      },
    };
    const briefing = compileIndexBriefing(memoryRepo, planRepo, ctx);
    assert.match(briefing.text, /Project: Zero-loss continuity/);
  });

  it('index briefing dedups Feature against Now when tokens overlap', () => {
    const ctx: BriefingContext = {
      project: 'test-proj',
      sessionType: 'compact',
      interrupted: false,
      compactionSnapshot: {
        recentFiles: [],
        recentReadFiles: [],
        recentCommands: [],
        userContext: [],
        approachNotes: [],
        initialGoal: 'Zero-loss continuity and compounding learning system',
        goalBranch: 'feat/north-star',
        goalCarryCount: 0,
      },
      gitState: {
        branch: 'feat/north-star',
        uncommittedCount: 0,
        unpushedCount: 0,
      },
      featureGoal: {
        text: 'Zero-loss continuity and compounding learning',
        branch: 'feat/north-star',
      },
    };
    const briefing = compileIndexBriefing(memoryRepo, planRepo, ctx);
    assert.ok(!briefing.text.includes('Feature:'), 'Feature tier should dedup against overlapping Now');
  });
});

describe('Snapshot round-trip: project_goal persists through INSERT/SELECT', () => {
  it('writes and reads project_goal + project_goal_source', () => {
    const goal = 'Primary memory integration — full pipeline';
    db.prepare(`
      INSERT INTO compaction_snapshots
        (id, session_id, project, captured_at, project_goal, project_goal_source)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('snap-1', 'sess-1', 'test-proj', new Date().toISOString(), goal, 'branch');

    const row = db.prepare(`
      SELECT project_goal, project_goal_source FROM compaction_snapshots
      WHERE id = ?
    `).get('snap-1') as { project_goal: string; project_goal_source: string };
    assert.equal(row.project_goal, goal);
    assert.equal(row.project_goal_source, 'branch');
  });

  it('sessions.project_goal persists through UPDATE/SELECT', () => {
    db.prepare(`
      INSERT INTO sessions (id, project, started_at)
      VALUES (?, ?, ?)
    `).run('sess-1', 'test-proj', new Date().toISOString());

    const goal = 'Ambient project goal for session handoff';
    db.prepare(`
      UPDATE sessions SET project_goal = ? WHERE id = ?
    `).run(goal, 'sess-1');

    const row = db.prepare(`
      SELECT project_goal FROM sessions WHERE id = ?
    `).get('sess-1') as { project_goal: string };
    assert.equal(row.project_goal, goal);
  });
});
