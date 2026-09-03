/** Goal staleness gates + SNR v3 Commit 4 three-tier goal rendering. */
import type { Plan } from '../../../db/plan-repository.js';
import { LIMITS, TOKEN_BUDGET, GOAL_TIER_LABELS, formatAgeCompact, type GoalTier } from '../../../constants/index.js';
import { isMetaGoal } from '../transcript-parser.js';
import type { BriefingContext } from './types.js';
import { tokeniseForOverlap, jaccardOverlap } from './query-fingerprint.js';
import { truncate } from '../../../utils/text.js';

/** Result of evaluating a carried goal against staleness gates. */
interface GoalStalenessResult {
  /** The goal text to render, or null if the goal should be suppressed entirely. */
  text: string | null;
  /** Label prefix — 'Goal' for fresh/first-carry, 'Previous goal' when carried once. */
  label: 'Goal' | 'Previous goal';
}

/**
 * Evaluate whether a carried goal is stale and should be suppressed.
 * Shared between the full briefing (renderTier1) and the index briefing
 * (compileIndexBriefing) so both paths apply the same five gates:
 *   1. isMetaGoal — session-management / synthetic-notice filter
 *   2. branchMismatch — goal captured on a different branch than current HEAD
 *   3. carryCount — inherited too many times without reinforcement
 *   4. completedStepMatch (GAP E) — goal paraphrases a done plan step
 *   5. shippedByCommit (Fix D) — goal tokens are covered by recent commit
 *      subjects above LIMITS.GOAL_SHIPPED_COVERAGE, i.e. the goal has already been
 *      committed to the branch and is now historical.
 * Returns `{ text: null }` when the goal should be omitted.
 */
function evaluateCarriedGoal(
  snap: NonNullable<BriefingContext['compactionSnapshot']>,
  plan: Plan | null,
  gitState: BriefingContext['gitState'],
): GoalStalenessResult {
  const fallback = snap.userContext.find(m => !isMetaGoal(m)) ?? null;
  const goal = snap.initialGoal ?? fallback;
  if (!goal || isMetaGoal(goal)) return { text: null, label: 'Goal' };

  const carryCount = snap.goalCarryCount ?? 0;
  const branchMismatch = snap.goalBranch != null
    && gitState?.branch != null
    && snap.goalBranch !== gitState.branch;

  const goalTokens = tokeniseForOverlap(goal);
  const completedStepMatch = plan?.steps.some(s => {
    if (s.status !== 'done') return false;
    const stepTokens = tokeniseForOverlap(s.description);
    return jaccardOverlap(goalTokens, stepTokens) >= LIMITS.GOAL_STALE_JACCARD;
  }) ?? false;

  const shippedByCommit = isGoalShippedByCommits(goalTokens, gitState?.recentCommits);

  if (branchMismatch
      || carryCount >= LIMITS.GOAL_MAX_CARRY_COUNT
      || completedStepMatch
      || shippedByCommit) {
    return { text: null, label: 'Goal' };
  }
  return { text: goal, label: carryCount === 1 ? 'Previous goal' : 'Goal' };
}

/** Fix D: ship-detection via recent commit subjects.
 *
 *  When the goal's meaningful tokens (length ≥3, non-stopword) are covered
 *  by the union of recent commit-subject tokens at LIMITS.GOAL_SHIPPED_COVERAGE or
 *  above, the goal is treated as shipped. This catches sticky goals that
 *  survived a phase/feature landing but describe work now in git history
 *  rather than current WIP.
 *
 *  Conservative by design:
 *   - Requires ≥3 goal tokens (coverage of a single-token goal is noisy).
 *   - Requires ≥1 recent commit subject to compute coverage at all.
 *   - Only flags when coverage ≥ LIMITS.GOAL_SHIPPED_COVERAGE (0.6).
 */
function isGoalShippedByCommits(
  goalTokens: Set<string>,
  recentCommits: string[] | undefined,
): boolean {
  if (!recentCommits || recentCommits.length === 0) return false;
  if (goalTokens.size < 3) return false;

  const commitTokens = new Set<string>();
  for (const subject of recentCommits) {
    for (const t of tokeniseForOverlap(subject)) commitTokens.add(t);
  }
  if (commitTokens.size === 0) return false;

  let matched = 0;
  for (const t of goalTokens) {
    if (commitTokens.has(t)) matched++;
  }
  const coverage = matched / goalTokens.size;
  return coverage >= LIMITS.GOAL_SHIPPED_COVERAGE;
}

// ---------------------------------------------------------------------------
// SNR v3 Commit 4 — three-tier goal rendering (Now / Feature / Project)
// ---------------------------------------------------------------------------
//
// Each tier applies a different staleness policy before the goal is rendered.
// The tiers can coexist — e.g. a branch may carry both a durable Project
// goal (from waykeep_plan(create)) and a transient Now goal (per-turn task
// from the transcript) at the same time. Cross-tier dedup prunes identical
// text so the briefing never shows the same goal twice under two labels.

/** A resolved goal-tier render candidate — what renderGoalTiers hands to the
 *  line builder. `text` is already truncated; `capturedAt` is already
 *  formatted as a compact age label (`Nm/h/d ago`). */
export interface GoalTierRender {
  tier: GoalTier;
  text: string;
  /** Already-formatted age label (null when no capturedAt is available). */
  ageLabel: string | null;
  /** Optional extra metadata (e.g. `(branch)`, `(plan)`) appended after the age. */
  extra: string | null;
}

/** Evaluate the Feature tier — branch-scoped synthesis. Mirrors the gates
 *  in `evaluateCarriedGoal` (branch mismatch, completed-step match, shipped
 *  by commit) but runs against a standalone `featureGoal` record rather
 *  than a compaction snapshot. Returns the text to render, or null when
 *  any staleness gate fires. carryCount is omitted because the Feature
 *  tier is queried directly from the DB on every read — there's no
 *  per-snapshot carry count to accumulate. */
function evaluateFeatureGoal(
  featureGoal: NonNullable<BriefingContext['featureGoal']>,
  plan: Plan | null,
  gitState: BriefingContext['gitState'],
): string | null {
  const text = featureGoal.text;
  if (!text || isMetaGoal(text)) return null;

  const branchMismatch = featureGoal.branch != null
    && gitState?.branch != null
    && featureGoal.branch !== gitState.branch;
  if (branchMismatch) return null;

  const goalTokens = tokeniseForOverlap(text);
  const completedStepMatch = plan?.steps.some(s => {
    if (s.status !== 'done') return false;
    const stepTokens = tokeniseForOverlap(s.description);
    return jaccardOverlap(goalTokens, stepTokens) >= LIMITS.GOAL_STALE_JACCARD;
  }) ?? false;
  if (completedStepMatch) return null;

  if (isGoalShippedByCommits(goalTokens, gitState?.recentCommits)) return null;

  return text;
}

/** Build the three-tier goal render list from ctx. Runs in both the full
 *  briefing (renderTier1) and the index briefing (compileIndexBriefing).
 *
 *  Tier policies:
 *   - Now: sourced from `compactionSnapshot.initialGoal` when compact mode
 *     is active AND the snapshot is from the current session. Gates match
 *     the pre-Commit-4 `evaluateCarriedGoal` (isMetaGoal, branch mismatch,
 *     carry count, completed step, shipped).
 *   - Feature: sourced from `featureGoal`. Gates match `evaluateFeatureGoal`
 *     (isMetaGoal, branch mismatch, completed step, shipped).
 *   - Project: sourced from `projectGoal`. Gates: only `isMetaGoal` — the
 *     durable tier never auto-stales by branch/ship/carry.
 *
 *  Cross-tier dedup: walks the tier list in order [Now, Feature, Project].
 *  A tier's text is dropped when it Jaccard-overlaps (>= GOAL_TIER_DEDUP_JACCARD)
 *  with any tier already accepted. "More specific wins" — Now beats Feature
 *  beats Project. */
export function renderGoalTiers(
  ctx: BriefingContext,
  plan: Plan | null,
  maxCharsOverride?: number,
): GoalTierRender[] {
  const accepted: GoalTierRender[] = [];
  const acceptedTokens: Array<Set<string>> = [];

  const dedupThreshold = LIMITS.GOAL_TIER_DEDUP_JACCARD;
  const maxChars = maxCharsOverride ?? TOKEN_BUDGET.BRIEFING_GOAL_MAX_CHARS;

  function tryAdd(tier: GoalTier, rawText: string, capturedAt: string | null | undefined, extra: string | null): void {
    if (!rawText || rawText.length === 0) return;
    const tokens = tokeniseForOverlap(rawText);
    for (const prev of acceptedTokens) {
      if (jaccardOverlap(tokens, prev) >= dedupThreshold) return;
    }
    accepted.push({
      tier,
      text: truncate(rawText, maxChars),
      ageLabel: formatAgeCompact(capturedAt ?? null),
      extra,
    });
    acceptedTokens.push(tokens);
  }

  // --- Now tier ------------------------------------------------------------
  // Only surfaces in compact mode, and only when the snapshot is from the
  // current session (session-boundary staleness). Reuses evaluateCarriedGoal
  // for the full set of pre-Commit-4 gates — nothing regresses, the tier
  // just gets a new label.
  if (ctx.sessionType === 'compact' && ctx.compactionSnapshot) {
    const snap = ctx.compactionSnapshot;
    const snapSession = snap.snapshotSessionId ?? null;
    const currentSession = ctx.currentSessionId ?? null;
    // Session-boundary: drop Now if the snap is from a different session.
    // When either side is null (legacy rows, test fixtures without ids),
    // fall through — the other gates still apply.
    const sessionMismatch = snapSession != null && currentSession != null && snapSession !== currentSession;
    if (!sessionMismatch) {
      const goalEval = evaluateCarriedGoal(snap, plan, ctx.gitState);
      if (goalEval.text) {
        tryAdd('now', goalEval.text, snap.goalCapturedAt ?? null, null);
      }
    }
  }

  // --- Feature tier --------------------------------------------------------
  // Direct feed: ctx.featureGoal (new Commit 4 field, populated by session-
  // start-handler's split query).
  if (ctx.featureGoal && ctx.featureGoal.text.length >= 15) {
    const featureText = evaluateFeatureGoal(ctx.featureGoal, plan, ctx.gitState);
    if (featureText) {
      tryAdd('feature', featureText, ctx.featureGoal.capturedAt ?? null, 'branch');
    }
  }
  // Legacy-route: a caller (script, pre-C4 hook path) that still packs a
  // branch-source goal into ctx.projectGoal is auto-routed into the Feature
  // tier here so the label stays correct without requiring every caller to
  // adopt the split. Requires the same staleness gates as direct featureGoal.
  if (ctx.projectGoal && ctx.projectGoal.source === 'branch' && ctx.projectGoal.text.length >= 15) {
    const virtualFeature = {
      text: ctx.projectGoal.text,
      capturedAt: ctx.projectGoal.capturedAt ?? null,
      branch: null as string | null,
    };
    const featureText = evaluateFeatureGoal(virtualFeature, plan, ctx.gitState);
    if (featureText) {
      tryAdd('feature', featureText, ctx.projectGoal.capturedAt ?? null, 'branch');
    }
  }

  // --- Project tier --------------------------------------------------------
  // Excludes branch-source goals (handled by the legacy-route above).
  if (ctx.projectGoal
      && ctx.projectGoal.source !== 'branch'
      && ctx.projectGoal.text.length >= 15
      && !isMetaGoal(ctx.projectGoal.text)) {
    tryAdd('project', ctx.projectGoal.text, ctx.projectGoal.capturedAt ?? null, ctx.projectGoal.source);
  }

  return accepted;
}

/** Format a tier render as a single briefing line: `<Label>: <text> [meta]`.
 *  Age and extra metadata live in a parenthesised suffix when either is
 *  present. `(plan, 3d ago)`, `(branch, 12m ago)`, or just `(8d ago)`. */
export function formatGoalTierLine(render: GoalTierRender): string {
  const label = GOAL_TIER_LABELS[render.tier];
  const metaParts: string[] = [];
  if (render.extra) metaParts.push(render.extra);
  if (render.ageLabel) metaParts.push(render.ageLabel);
  const suffix = metaParts.length > 0 ? ` (${metaParts.join(', ')})` : '';
  return `${label}: ${render.text}${suffix}`;
}
