/**
 * Shared goal-resolution logic for the PreCompact and SessionEnd hooks.
 *
 * Both hooks persist a compaction snapshot and must resolve the same two
 * goal tiers before the INSERT:
 *
 *  - initial_goal (Now tier): inherit across meta turns with staleness
 *    bookkeeping (goal_branch, goal_carry_count, goal_captured_at).
 *  - project_goal (Project tier): sticky "what this branch is FOR" line
 *    (transcript mine → DB carry-forward → active plan name → branch
 *    synthesis).
 *
 * Prior pitfall: the two hooks each carried a hand-synced copy of this
 * logic, and column-list/logic drift between them silently disabled
 * briefing features. This module is now the single implementation; the
 * only intentional difference between the callers is expressed via
 * `sessionId` on {@link resolveInitialGoal}.
 */
import type Database from 'better-sqlite3';
import { isMetaGoal, distillGoal } from './transcript-parser.js';
import { getLatestCommitSubject } from '../../utils/project-scanner.js';
import { synthesizeBranchGoal } from '../../utils/branch-goal.js';
import { LIMITS } from '../../constants/index.js';

type GoalRow = {
  initial_goal: string;
  goal_branch: string | null;
  goal_carry_count: number | null;
  goal_captured_at: string | null;
  captured_at: string;
};

export interface InitialGoalResolution {
  /** Resolved goal text, or null when nothing non-meta could be found. */
  goal: string | null;
  /** Branch where the goal originated (staleness gate input). */
  goalBranch: string | null;
  /** How many times the goal has been inherited without reinforcement. */
  goalCarryCount: number;
  /**
   * Original capture time when the goal was inherited from a prior
   * snapshot; null when the goal is fresh (or absent) — the caller stamps
   * the INSERT timestamp in that case so the age clock starts now.
   */
  goalCapturedAt: string | null;
}

/**
 * Resolve the initial_goal (Now tier) for a snapshot, with goal-continuity
 * inheritance across meta turns.
 *
 * If the transcript's goal looks like a meta-command (e.g. "do a compact",
 * "continue", short acks), inherit the previous snapshot's goal so the
 * original task survives across continuations. All snapshot lookups are
 * TIME-BOUNDED (LIMITS.GOAL_SCAN_HOURS) to prevent perpetual inheritance of
 * stale goals. Staleness tracking: goal_branch records the branch where the
 * goal originated, goal_carry_count tracks how many times it's been
 * inherited without reinforcement, goal_captured_at (SNR v3 Commit 4) is
 * carried forward on inheritance so the Now-tier age clock doesn't reset on
 * every compaction, and stamped fresh (null here → INSERT time) when the
 * goal comes from this turn's transcript/userContext.
 * Research: LangGraph (fresh-start default), OnGoal (UIST 2025, goal
 * integration), GTD (graduated commitment), Linear (auto-archive on
 * staleness).
 *
 * @param opts.sessionId When set (PreCompact — mid-session compaction), the
 *   current session's snapshots are checked first, then any-session
 *   snapshots in the time window. When omitted (SessionEnd — session
 *   boundary), only the any-session window applies.
 */
export function resolveInitialGoal(opts: {
  db: Database.Database;
  project: string;
  /** Goal mined from the current transcript (may be null or a meta-command). */
  transcriptGoal: string | null;
  /** Recent user messages — last-resort fallback source for a fresh goal. */
  userContext: string[];
  currentBranch: string | null;
  sessionId?: string;
}): InitialGoalResolution {
  const { db, project, userContext, currentBranch, sessionId } = opts;

  const resolution: InitialGoalResolution = {
    goal: opts.transcriptGoal,
    goalBranch: currentBranch,
    goalCarryCount: 0,
    goalCapturedAt: null,
  };

  if (resolution.goal && !isMetaGoal(resolution.goal)) return resolution;

  // Phase 1 (compaction context only): check current session's snapshots.
  let validGoal: GoalRow | undefined;
  if (sessionId) {
    const prevSnaps = db.prepare(`
      SELECT initial_goal, goal_branch, goal_carry_count, goal_captured_at, captured_at FROM compaction_snapshots
      WHERE project = ? AND session_id = ? AND initial_goal IS NOT NULL
        AND captured_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-' || ? || ' hours')
      ORDER BY captured_at DESC LIMIT ?
    `).all(project, sessionId, LIMITS.GOAL_SCAN_HOURS, LIMITS.GOAL_SCAN_LIMIT) as GoalRow[];
    validGoal = prevSnaps.find(s => !isMetaGoal(s.initial_goal));
  }

  // Phase 2: fall back to recent snapshots within the time window (any session).
  if (!validGoal) {
    const prevSnaps = db.prepare(`
      SELECT initial_goal, goal_branch, goal_carry_count, goal_captured_at, captured_at FROM compaction_snapshots
      WHERE project = ? AND initial_goal IS NOT NULL
        AND captured_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-' || ? || ' hours')
      ORDER BY captured_at DESC LIMIT ?
    `).all(project, LIMITS.GOAL_SCAN_HOURS, LIMITS.GOAL_SCAN_LIMIT) as GoalRow[];
    validGoal = prevSnaps.find(s => !isMetaGoal(s.initial_goal));
  }

  if (validGoal) {
    resolution.goal = distillGoal(validGoal.initial_goal);
    // Carry forward the origin branch, increment carry count
    resolution.goalBranch = validGoal.goal_branch ?? currentBranch;
    resolution.goalCarryCount = (validGoal.goal_carry_count ?? 0) + 1;
    // Inherit the original capture time so the age clock doesn't reset
    // on every compaction. Fall back to the prior snapshot's captured_at
    // for rows written before schema v23 (goal_captured_at still null).
    resolution.goalCapturedAt = validGoal.goal_captured_at ?? validGoal.captured_at;
  } else {
    // Last resort: scan userContext for a non-meta message
    const fallback = userContext.find(m => m.length > LIMITS.FALLBACK_GOAL_MIN_CHARS && !isMetaGoal(m));
    resolution.goal = fallback ? distillGoal(fallback) : null;
    // Fresh goal from userContext — reset staleness
    resolution.goalBranch = currentBranch;
    resolution.goalCarryCount = 0;
    // Freshly-mined goal → goalCapturedAt stays null (caller stamps INSERT time).
  }

  return resolution;
}

export interface ProjectGoalResolution {
  projectGoal: string | null;
  /** 'transcript' | 'plan' | 'branch' | null (mirrors project_goal_source). */
  projectGoalSource: string | null;
  /**
   * Original capture time when the projectGoal text is unchanged from the
   * most recent snapshot; null when the text changed or no goal exists —
   * the caller stamps the INSERT timestamp in that case.
   */
  projectGoalCapturedAt: string | null;
}

/**
 * Resolve the project_goal (Project tier) for a snapshot — sticky across
 * meta turns (Phase 1).
 *
 * Priority: transcript mine (waykeep_plan create) → carry-forward from DB →
 * active plan name → branch synthesis. The result persists even when the
 * current turn is meta, so the briefing can surface "what this branch is
 * FOR" across SNR audits, /compact, and exit+return cycles.
 *
 * project_goal_captured_at (SNR v3 Commit 4) is carried forward only when
 * the projectGoal TEXT is unchanged from the most recent snapshot. Text
 * change (= explicit pivot: plan rename or a new transcript mine) resets
 * the clock. That lookup is deliberately NOT time-windowed — unlike the
 * GOAL_SCAN_HOURS carry-forward above it — because the Project tier is
 * long-lived by design and captured_at must survive from older rows.
 */
export function resolveProjectGoal(opts: {
  db: Database.Database;
  project: string;
  /** Project goal mined from the current transcript, if any. */
  transcriptProjectGoal: string | null;
  /** Name of the active plan, if one exists. */
  activePlanName: string | null;
  currentBranch: string | null;
  /** Working directory — used for latest-commit-subject branch synthesis. */
  cwd: string;
}): ProjectGoalResolution {
  const { db, project, activePlanName, currentBranch, cwd } = opts;

  let projectGoal: string | null = opts.transcriptProjectGoal;
  let projectGoalSource: string | null = projectGoal ? 'transcript' : null;

  if (!projectGoal) {
    type ProjectGoalRow = { project_goal: string; project_goal_source: string | null };
    const prevProjectGoal = db.prepare(`
      SELECT project_goal, project_goal_source FROM compaction_snapshots
      WHERE project = ? AND project_goal IS NOT NULL
        AND captured_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-' || ? || ' hours')
      ORDER BY captured_at DESC LIMIT 1
    `).get(project, LIMITS.GOAL_SCAN_HOURS) as ProjectGoalRow | undefined;
    if (prevProjectGoal?.project_goal) {
      projectGoal = prevProjectGoal.project_goal;
      projectGoalSource = prevProjectGoal.project_goal_source ?? 'plan';
    }
  }

  if (!projectGoal && activePlanName) {
    projectGoal = activePlanName;
    projectGoalSource = 'plan';
  }

  if (!projectGoal && currentBranch) {
    const commitSubject = getLatestCommitSubject(cwd);
    const branchGoal = synthesizeBranchGoal(currentBranch, { commitSubject });
    if (branchGoal) {
      projectGoal = branchGoal;
      projectGoalSource = 'branch';
    }
  }

  let projectGoalCapturedAt: string | null = null;
  if (projectGoal) {
    type PrevPgRow = { project_goal: string; project_goal_captured_at: string | null; captured_at: string };
    const prevAnyPg = db.prepare(`
      SELECT project_goal, project_goal_captured_at, captured_at FROM compaction_snapshots
      WHERE project = ? AND project_goal IS NOT NULL
      ORDER BY captured_at DESC LIMIT 1
    `).get(project) as PrevPgRow | undefined;
    if (prevAnyPg && prevAnyPg.project_goal === projectGoal) {
      // Pure carry-forward — same text → inherit original capture time.
      // Fall back to prev's captured_at for rows written before schema v23.
      projectGoalCapturedAt = prevAnyPg.project_goal_captured_at ?? prevAnyPg.captured_at;
    }
    // Text differs (or no prior row) → caller stamps INSERT time.
  }

  return { projectGoal, projectGoalSource, projectGoalCapturedAt };
}
