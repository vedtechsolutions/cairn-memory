/**
 * SNR v3 Commit 4 — three-tier goal rendering (Now / Feature / Project).
 *
 * These tests lock the tier contract so future refactors can't silently
 * regress the label taxonomy, staleness policy, or cross-tier dedup.
 *
 * Coverage:
 *   1. Label taxonomy — "Now:", "Feature:", "Project:".
 *   2. Now-tier session-boundary staleness — drops when snapshotSessionId
 *      differs from ctx.currentSessionId.
 *   3. Feature-tier staleness — branch mismatch, completed-step match,
 *      shipped-by-commit (inherits the existing gate suite).
 *   4. Project-tier durability — never auto-stales on branch change or
 *      shipped detection.
 *   5. Cross-tier dedup — identical text collapses, most-specific wins.
 *   6. Age metadata — compact formatter renders (Nm/h/d ago).
 *   7. End-to-end through compileBriefing + compileIndexBriefing.
 *   8. Schema round-trip — goal_captured_at + project_goal_captured_at
 *      persist through INSERT/SELECT on compaction_snapshots.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type Database from 'better-sqlite3';
import { openDatabase } from '../src/db/connection.js';
import { MemoryRepository } from '../src/db/memory-repository.js';
import { PlanRepository } from '../src/db/plan-repository.js';
import {
  compileBriefing,
  compileIndexBriefing,
  type BriefingContext,
} from '../src/hooks/shared/briefing-compiler.js';
import { formatAgeCompact, GOAL_TIER_LABELS } from '../src/constants/index.js';

const PROJECT = 'cairn-goal-tiers-test';

let db: Database.Database;
let memRepo: MemoryRepository;
let planRepo: PlanRepository;

beforeEach(() => {
  db = openDatabase({ dbPath: ':memory:' });
  memRepo = new MemoryRepository(db);
  planRepo = new PlanRepository(db);
});

afterEach(() => db.close());

// ---------------------------------------------------------------------------
// 1. Label taxonomy — constant + rendered-line contract
// ---------------------------------------------------------------------------

describe('Commit 4: GOAL_TIER_LABELS exports the three-tier taxonomy', () => {
  it('exposes now/feature/project → Now/Feature/Project', () => {
    assert.equal(GOAL_TIER_LABELS.now, 'Now');
    assert.equal(GOAL_TIER_LABELS.feature, 'Feature');
    assert.equal(GOAL_TIER_LABELS.project, 'Project');
  });
});

describe('Commit 4: renderTier1 emits the three-tier labels end-to-end', () => {
  it('renders a Now line from compactionSnapshot.initialGoal in compact mode', () => {
    const ctx: BriefingContext = {
      project: PROJECT,
      sessionType: 'compact',
      interrupted: false,
      currentSessionId: 'sess-a',
      gitState: { branch: 'feat/auth', uncommittedCount: 0, unpushedCount: 0 },
      compactionSnapshot: {
        recentFiles: [],
        recentReadFiles: [],
        recentCommands: [],
        userContext: ['build the auth system'],
        approachNotes: [],
        initialGoal: 'Build the authentication system',
        goalBranch: 'feat/auth',
        goalCarryCount: 0,
        snapshotSessionId: 'sess-a',
      },
    };
    const out = compileBriefing(memRepo, planRepo, ctx);
    assert.match(out.text, /Now: Build the authentication system/);
  });

  it('renders a Feature line from ctx.featureGoal', () => {
    const ctx: BriefingContext = {
      project: PROJECT,
      sessionType: 'startup',
      interrupted: false,
      gitState: { branch: 'feat/payments', uncommittedCount: 0, unpushedCount: 0 },
      featureGoal: {
        text: 'Stripe payments integration for billing module',
        branch: 'feat/payments',
      },
    };
    const out = compileBriefing(memRepo, planRepo, ctx);
    assert.match(out.text, /Feature: Stripe payments integration/);
  });

  it('renders a Project line from ctx.projectGoal when source ≠ branch', () => {
    const ctx: BriefingContext = {
      project: PROJECT,
      sessionType: 'startup',
      interrupted: false,
      projectGoal: {
        text: 'Primary memory integration — North-Star phases 3+4+5',
        source: 'plan',
      },
    };
    const out = compileBriefing(memRepo, planRepo, ctx);
    assert.match(out.text, /Project: Primary memory integration/);
  });
});

// ---------------------------------------------------------------------------
// 2. Now-tier session-boundary staleness
// ---------------------------------------------------------------------------

describe('Commit 4: Now tier drops when snapshotSessionId ≠ currentSessionId', () => {
  it('drops Now when the snap is from a different session', () => {
    const ctx: BriefingContext = {
      project: PROJECT,
      sessionType: 'compact',
      interrupted: false,
      currentSessionId: 'sess-new',
      gitState: { branch: 'feat/auth', uncommittedCount: 0, unpushedCount: 0 },
      compactionSnapshot: {
        recentFiles: [],
        recentReadFiles: [],
        recentCommands: [],
        userContext: [],
        approachNotes: [],
        initialGoal: 'Build the authentication system',
        goalBranch: 'feat/auth',
        goalCarryCount: 0,
        snapshotSessionId: 'sess-old',
      },
    };
    const out = compileBriefing(memRepo, planRepo, ctx);
    assert.ok(!out.text.includes('Now: Build the authentication system'),
      'cross-session snap must not re-surface as Now');
  });

  it('keeps Now when the snap is from the same session', () => {
    const ctx: BriefingContext = {
      project: PROJECT,
      sessionType: 'compact',
      interrupted: false,
      currentSessionId: 'sess-alpha',
      gitState: { branch: 'feat/auth', uncommittedCount: 0, unpushedCount: 0 },
      compactionSnapshot: {
        recentFiles: [],
        recentReadFiles: [],
        recentCommands: [],
        userContext: [],
        approachNotes: [],
        initialGoal: 'Build the authentication system',
        goalBranch: 'feat/auth',
        goalCarryCount: 0,
        snapshotSessionId: 'sess-alpha',
      },
    };
    const out = compileBriefing(memRepo, planRepo, ctx);
    assert.match(out.text, /Now: Build the authentication system/);
  });

  it('keeps Now when session ids are absent (legacy rows)', () => {
    const ctx: BriefingContext = {
      project: PROJECT,
      sessionType: 'compact',
      interrupted: false,
      gitState: { branch: 'feat/auth', uncommittedCount: 0, unpushedCount: 0 },
      compactionSnapshot: {
        recentFiles: [],
        recentReadFiles: [],
        recentCommands: [],
        userContext: [],
        approachNotes: [],
        initialGoal: 'Build the authentication system',
        goalBranch: 'feat/auth',
        goalCarryCount: 0,
        // snapshotSessionId omitted — pre-v23 rows
      },
    };
    const out = compileBriefing(memRepo, planRepo, ctx);
    assert.match(out.text, /Now: Build the authentication system/,
      'legacy rows without session id should still render Now');
  });
});

// ---------------------------------------------------------------------------
// 3. Feature-tier staleness gates
// ---------------------------------------------------------------------------

describe('Commit 4: Feature tier branch / shipped / completed-step gates', () => {
  it('drops Feature when branch has changed', () => {
    const ctx: BriefingContext = {
      project: PROJECT,
      sessionType: 'startup',
      interrupted: false,
      gitState: { branch: 'feat/current', uncommittedCount: 0, unpushedCount: 0 },
      featureGoal: {
        text: 'Stale feature goal from the old branch',
        branch: 'feat/old',
      },
    };
    const out = compileBriefing(memRepo, planRepo, ctx);
    assert.ok(!out.text.includes('Feature:'), 'branch-mismatched Feature must drop');
  });

  it('drops Feature when goal tokens match a completed plan step', () => {
    const plan = planRepo.create({
      project: PROJECT,
      name: 'Phase 3',
      steps: [
        { description: 'Stripe payments integration for billing module' },
      ],
    }).plan;
    planRepo.updateStep(plan.id, { step_id: 1, status: 'done' });

    const ctx: BriefingContext = {
      project: PROJECT,
      sessionType: 'startup',
      interrupted: false,
      gitState: { branch: 'feat/payments', uncommittedCount: 0, unpushedCount: 0 },
      featureGoal: {
        text: 'Stripe payments integration for billing module',
        branch: 'feat/payments',
      },
    };
    const out = compileBriefing(memRepo, planRepo, ctx);
    assert.ok(!out.text.includes('Feature:'), 'Feature matching a done step must drop');
  });

  it('drops Feature when recent commits cover the goal tokens (shipped)', () => {
    const ctx: BriefingContext = {
      project: PROJECT,
      sessionType: 'startup',
      interrupted: false,
      gitState: {
        branch: 'feat/payments',
        uncommittedCount: 0,
        unpushedCount: 0,
        recentCommits: [
          'Stripe payments integration complete',
          'Billing module refactor for payments',
          'Integration tests for stripe billing',
        ],
      },
      featureGoal: {
        text: 'Stripe payments integration for billing module',
        branch: 'feat/payments',
      },
    };
    const out = compileBriefing(memRepo, planRepo, ctx);
    assert.ok(!out.text.includes('Feature:'), 'shipped Feature must drop');
  });
});

// ---------------------------------------------------------------------------
// 4. Project-tier durability
// ---------------------------------------------------------------------------

describe('Commit 4: Project tier survives branch change and shipped detection', () => {
  it('keeps Project when branch has changed', () => {
    const ctx: BriefingContext = {
      project: PROJECT,
      sessionType: 'startup',
      interrupted: false,
      gitState: { branch: 'feat/completely-different', uncommittedCount: 0, unpushedCount: 0 },
      projectGoal: {
        text: 'North-Star: zero-loss continuity and compounding learning',
        source: 'plan',
      },
    };
    const out = compileBriefing(memRepo, planRepo, ctx);
    assert.match(out.text, /Project: North-Star/);
  });

  it('keeps Project when commit subjects would ship a Feature', () => {
    const ctx: BriefingContext = {
      project: PROJECT,
      sessionType: 'startup',
      interrupted: false,
      gitState: {
        branch: 'feat/north-star',
        uncommittedCount: 0,
        unpushedCount: 0,
        recentCommits: [
          'North-Star zero-loss continuity complete',
          'Compounding learning phase 3 shipped',
          'North-Star phase 4 wiring done',
        ],
      },
      projectGoal: {
        text: 'North-Star: zero-loss continuity and compounding learning',
        source: 'plan',
      },
    };
    const out = compileBriefing(memRepo, planRepo, ctx);
    assert.match(out.text, /Project: North-Star/,
      'Project tier must survive even when commit subjects would ship a Feature');
  });

  it('drops Project when the text is meta (isMetaGoal filter)', () => {
    const ctx: BriefingContext = {
      project: PROJECT,
      sessionType: 'startup',
      interrupted: false,
      projectGoal: {
        text: 'Continue this was where you were before we got disconnected — ready to proceed?',
        source: 'plan',
      },
    };
    const out = compileBriefing(memRepo, planRepo, ctx);
    // Anchor the negative assertion on the meta prose text so the top-level
    // "Project: <slug>" identifier line doesn't false-positive the match.
    assert.ok(!/Project:\s*Continue this was/.test(out.text),
      'meta/resume-prose Project goal must be suppressed');
  });
});

// ---------------------------------------------------------------------------
// 5. Cross-tier dedup — most-specific wins
// ---------------------------------------------------------------------------

describe('Commit 4: cross-tier dedup drops less-specific duplicates', () => {
  it('drops Feature when Feature and Now tokens overlap', () => {
    const ctx: BriefingContext = {
      project: PROJECT,
      sessionType: 'compact',
      interrupted: false,
      currentSessionId: 'sess-same',
      gitState: { branch: 'feat/auth', uncommittedCount: 0, unpushedCount: 0 },
      compactionSnapshot: {
        recentFiles: [],
        recentReadFiles: [],
        recentCommands: [],
        userContext: [],
        approachNotes: [],
        initialGoal: 'Build the authentication system with OAuth',
        goalBranch: 'feat/auth',
        goalCarryCount: 0,
        snapshotSessionId: 'sess-same',
      },
      featureGoal: {
        text: 'Build the authentication system',
        branch: 'feat/auth',
      },
    };
    const out = compileBriefing(memRepo, planRepo, ctx);
    assert.match(out.text, /Now: Build the authentication system with OAuth/);
    assert.ok(!out.text.includes('Feature:'), 'Feature deduped against overlapping Now');
  });

  it('drops Project when Project and Feature tokens overlap (Feature wins)', () => {
    const ctx: BriefingContext = {
      project: PROJECT,
      sessionType: 'startup',
      interrupted: false,
      gitState: { branch: 'feat/north-star', uncommittedCount: 0, unpushedCount: 0 },
      featureGoal: {
        text: 'North-Star zero-loss continuity',
        branch: 'feat/north-star',
      },
      projectGoal: {
        text: 'North-Star zero-loss continuity compounding learning',
        source: 'plan',
      },
    };
    const out = compileBriefing(memRepo, planRepo, ctx);
    assert.match(out.text, /Feature: North-Star/);
    assert.ok(!/Project:\s*North-Star/.test(out.text), 'Project deduped against overlapping Feature');
  });

  it('keeps all three when texts are genuinely distinct', () => {
    const ctx: BriefingContext = {
      project: PROJECT,
      sessionType: 'compact',
      interrupted: false,
      currentSessionId: 'sess-x',
      gitState: { branch: 'feat/alpha', uncommittedCount: 0, unpushedCount: 0 },
      compactionSnapshot: {
        recentFiles: [],
        recentReadFiles: [],
        recentCommands: [],
        userContext: [],
        approachNotes: [],
        initialGoal: 'Debug the regression in caching layer',
        goalBranch: 'feat/alpha',
        goalCarryCount: 0,
        snapshotSessionId: 'sess-x',
      },
      featureGoal: {
        text: 'Ship OAuth token refresh flow for mobile clients',
        branch: 'feat/alpha',
      },
      projectGoal: {
        text: 'Authentication subsystem redesign for multi-tenancy',
        source: 'plan',
      },
    };
    const out = compileBriefing(memRepo, planRepo, ctx);
    assert.match(out.text, /Now: Debug the regression/);
    assert.match(out.text, /Feature: Ship OAuth token refresh/);
    assert.match(out.text, /Project: Authentication subsystem redesign/);
  });
});

// ---------------------------------------------------------------------------
// 6. Age metadata — formatAgeCompact
// ---------------------------------------------------------------------------

describe('Commit 4: formatAgeCompact renders Nm/h/d ago labels', () => {
  const now = Date.parse('2026-04-11T12:00:00.000Z');

  it('returns null for null/undefined/invalid input', () => {
    assert.equal(formatAgeCompact(null, now), null);
    assert.equal(formatAgeCompact(undefined, now), null);
    assert.equal(formatAgeCompact('not-a-date', now), null);
  });

  it('returns "just now" for < 1 minute', () => {
    const at = new Date(now - 30_000).toISOString();
    assert.equal(formatAgeCompact(at, now), 'just now');
  });

  it('returns Nm ago for 1-59 minutes', () => {
    const at = new Date(now - 12 * 60_000).toISOString();
    assert.equal(formatAgeCompact(at, now), '12m ago');
  });

  it('returns Nh ago for 1-23 hours', () => {
    const at = new Date(now - 5 * 60 * 60_000).toISOString();
    assert.equal(formatAgeCompact(at, now), '5h ago');
  });

  it('returns Nd ago for 24+ hours', () => {
    const at = new Date(now - 3 * 24 * 60 * 60_000).toISOString();
    assert.equal(formatAgeCompact(at, now), '3d ago');
  });

  it('returns null for future timestamps (captured_at in the future)', () => {
    const at = new Date(now + 60_000).toISOString();
    assert.equal(formatAgeCompact(at, now), null);
  });
});

describe('Commit 4: rendered goal lines include age metadata when available', () => {
  it('adds "(plan, Nd ago)" suffix to Project line when capturedAt is set', () => {
    const capturedAt = new Date(Date.now() - 3 * 24 * 60 * 60_000).toISOString();
    const ctx: BriefingContext = {
      project: PROJECT,
      sessionType: 'startup',
      interrupted: false,
      projectGoal: {
        text: 'Multi-tenancy for the auth subsystem',
        source: 'plan',
        capturedAt,
      },
    };
    const out = compileBriefing(memRepo, planRepo, ctx);
    assert.match(out.text, /Project: Multi-tenancy for the auth subsystem \(plan, 3d ago\)/);
  });

  it('adds "(branch, Nh ago)" suffix to Feature line when capturedAt is set', () => {
    const capturedAt = new Date(Date.now() - 4 * 60 * 60_000).toISOString();
    const ctx: BriefingContext = {
      project: PROJECT,
      sessionType: 'startup',
      interrupted: false,
      gitState: { branch: 'feat/alpha', uncommittedCount: 0, unpushedCount: 0 },
      featureGoal: {
        text: 'Ship OAuth token refresh flow for mobile clients',
        branch: 'feat/alpha',
        capturedAt,
      },
    };
    const out = compileBriefing(memRepo, planRepo, ctx);
    assert.match(out.text, /Feature: Ship OAuth token refresh flow for mobile clients \(branch, 4h ago\)/);
  });
});

// ---------------------------------------------------------------------------
// 7. Index briefing parity
// ---------------------------------------------------------------------------

describe('Commit 4: compileIndexBriefing shares the three-tier helper', () => {
  it('renders Now + Feature + Project in index mode', () => {
    // Note: initialGoal must not contain "compact"/"compaction" — isMetaGoal
    // rejects those as session-management prose.
    const ctx: BriefingContext = {
      project: PROJECT,
      sessionType: 'compact',
      interrupted: false,
      currentSessionId: 'sess-index',
      gitState: { branch: 'feat/alpha', uncommittedCount: 0, unpushedCount: 0 },
      compactionSnapshot: {
        recentFiles: [],
        recentReadFiles: [],
        recentCommands: [],
        userContext: [],
        approachNotes: [],
        initialGoal: 'Immediate task: fix regression in the replay layer',
        goalBranch: 'feat/alpha',
        goalCarryCount: 0,
        snapshotSessionId: 'sess-index',
      },
      featureGoal: {
        text: 'Ship OAuth token refresh flow for mobile clients',
        branch: 'feat/alpha',
      },
      projectGoal: {
        text: 'Authentication subsystem redesign for multi-tenancy',
        source: 'plan',
      },
    };
    const out = compileIndexBriefing(memRepo, planRepo, ctx);
    assert.match(out.text, /Now: Immediate task/);
    assert.match(out.text, /Feature: Ship OAuth token refresh/);
    assert.match(out.text, /Project: Authentication subsystem redesign/);
  });
});

// ---------------------------------------------------------------------------
// 8. Schema round-trip — goal_captured_at + project_goal_captured_at
// ---------------------------------------------------------------------------

describe('Commit 4: schema v23 columns round-trip through INSERT/SELECT', () => {
  it('writes and reads goal_captured_at + project_goal_captured_at', () => {
    const goalCapturedAt = '2026-04-11T10:00:00.000Z';
    const projectGoalCapturedAt = '2026-04-08T09:00:00.000Z';
    db.prepare(`
      INSERT INTO compaction_snapshots (
        id, session_id, project, captured_at,
        initial_goal, goal_captured_at,
        project_goal, project_goal_source, project_goal_captured_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'snap-c4-1',
      'sess-c4',
      PROJECT,
      '2026-04-11T12:00:00.000Z',
      'Fresh task goal',
      goalCapturedAt,
      'Durable project goal',
      'plan',
      projectGoalCapturedAt,
    );

    const row = db.prepare(`
      SELECT goal_captured_at, project_goal_captured_at
      FROM compaction_snapshots WHERE id = ?
    `).get('snap-c4-1') as { goal_captured_at: string; project_goal_captured_at: string };

    assert.equal(row.goal_captured_at, goalCapturedAt);
    assert.equal(row.project_goal_captured_at, projectGoalCapturedAt);
  });

  it('allows NULL for both captured_at columns (backward compatible)', () => {
    db.prepare(`
      INSERT INTO compaction_snapshots (id, session_id, project, captured_at, initial_goal)
      VALUES (?, ?, ?, ?, ?)
    `).run('snap-c4-null', 'sess-c4', PROJECT, '2026-04-11T12:00:00.000Z', 'Legacy goal');

    const row = db.prepare(`
      SELECT goal_captured_at, project_goal_captured_at
      FROM compaction_snapshots WHERE id = ?
    `).get('snap-c4-null') as { goal_captured_at: string | null; project_goal_captured_at: string | null };

    assert.equal(row.goal_captured_at, null);
    assert.equal(row.project_goal_captured_at, null);
  });
});
