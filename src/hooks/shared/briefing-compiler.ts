/**
 * Compile briefing text for session start injection.
 * Budget: ≤ 2000 tokens. Tier-based allocation with bottom-up reduction.
 *
 * Tiers (cut bottom-up when over budget):
 *   T1: plan + goal + git + user + project context + files + approach  (always)
 *   T2: decisions — effectiveness-ranked                               (high)
 *   T3: pitfalls — effectiveness-ranked                                (high)
 *   T4: corrections                                                    (medium)
 *
 * This file is the facade for the `briefing/` modules — it owns the
 * top-level `compileBriefing` orchestration and re-exports the public
 * surface (query-fp synthesis, index mode, recovery pass, types).
 */
import type { MemoryRepository } from '../../db/memory-repository.js';
import { formatMemoryContent } from '../../utils/memory-injection.js';
import type { PlanRepository } from '../../db/plan-repository.js';
import { LIMITS, TOKEN_BUDGET, BRIEFING_ALLOCATION, BRIEFING_MODE } from '../../constants/index.js';
// NOTE: Briefing compilation runs on the hot path for every session-start. Use
// estimateTokensFast (~microseconds) for all incremental budget checks and the
// returned tokenEstimate. Profiling showed the real estimateTokens / countTokens
// call averaged ~130 ms warm and dominated session-start latency (~3.25 s per
// compile across ~25 in-loop calls). See src/utils/tokens.ts for the trade-off.
import { estimateTokensFast } from '../../utils/tokens.js';
import type { BriefingContext, BriefingOutput } from './briefing/types.js';
import { buildBriefingQueryFp } from './briefing/query-fingerprint.js';
import { renderTier1 } from './briefing/tier1-renderer.js';
import { renderTier2, renderTier3, renderTier4 } from './briefing/memory-tier-renderers.js';
import { compileIndexBriefing } from './briefing/index-briefing.js';
import {
  GOVERNANCE_TIER_MAX_TOKENS, renderGovernanceTier,
} from './briefing/governance-tier.js';

// Facade re-exports — every name importable from this module before the
// briefing/ split remains importable here.
export type { BriefingContext, BriefingOutput } from './briefing/types.js';
export { buildBriefingQueryFp } from './briefing/query-fingerprint.js';
export { computeEffectiveness, recoverDroppedPitfalls } from './briefing/recovery.js';
export { compileIndexBriefing } from './briefing/index-briefing.js';

// ---------------------------------------------------------------------------
// Main compiler — assembles tiers with budget-aware reduction
// ---------------------------------------------------------------------------

/** Compile a briefing from DB state. Returns text + token estimate.
 *
 * Mode selection: 'full' runs the tier-based detailed briefing,
 * 'index' emits a compact progressive-disclosure index, and 'auto'
 * picks full on startup/clear and index on compact/resume.
 */
export function compileBriefing(
  memoryRepo: MemoryRepository,
  planRepo: PlanRepository,
  ctx: BriefingContext,
): BriefingOutput {
  const mode = ctx.briefingMode ?? BRIEFING_MODE.DEFAULT;
  // Post-compact with a snapshot must use full mode: the index path renders
  // only goal + open questions for recovery, dropping decisions, read/modified
  // files, approach notes, hypotheses, and errors. Those are the exact fields
  // the PreCompact hook stored for Claude to pick up after compaction, so
  // routing through renderTier1 is the whole point of capturing the snapshot.
  const resolved: 'full' | 'index' = mode === 'auto'
    ? (ctx.sessionType === 'compact' && ctx.compactionSnapshot
        ? 'full'
        : ctx.sessionType === 'compact' || ctx.sessionType === 'resume'
          ? 'index'
          : 'full')
    : mode;

  if (resolved === 'index') {
    return compileIndexBriefing(memoryRepo, planRepo, ctx);
  }

  const maxBudget = ctx.budgetOverride ?? TOKEN_BUDGET.BRIEFING_MAX;

  // Render Tier 1 (always included — plan, goal, git, user, files)
  const { tier: tier1, plan } = renderTier1(memoryRepo, planRepo, ctx);

  // GAP C/D: build one task-aware queryFp reused across T2/T3/T4 so the
  // same-project relevance gate can see goal + recent-file + branch signal.
  const queryFp = buildBriefingQueryFp(ctx, plan);

  // Remaining budget after T1
  const remainingAfterT1 = maxBudget - tier1.tokens;

  const governanceBudget = Math.min(GOVERNANCE_TIER_MAX_TOKENS, remainingAfterT1);
  const governance = renderGovernanceTier(ctx.governance, governanceBudget);
  const remainingAfterGovernance = remainingAfterT1 - governance.tokens;

  // Render T2–T4 with tier budgets, capped by remaining space
  const t2Budget = Math.min(BRIEFING_ALLOCATION.TIER2_BUDGET, remainingAfterGovernance);
  const { tier: tier2, includedDecisionIds } = renderTier2(memoryRepo, ctx, plan, t2Budget, queryFp);

  const remainingAfterT2 = remainingAfterGovernance - tier2.tokens;

  // Render T3 (pitfalls) + T4 (corrections; its budget flows from T3's
  // spend), then assemble. Order: header/context, corrections, decisions,
  // pitfalls (corrections near decisions for context).
  const assemble = (maxPitfalls?: number): BriefingOutput => {
    const t3Ctx = maxPitfalls === undefined ? ctx : { ...ctx, maxPitfalls };
    const t3Budget = Math.min(BRIEFING_ALLOCATION.TIER3_BUDGET, remainingAfterT2);
    const { tier: tier3, includedPitfallIds } = renderTier3(memoryRepo, t3Ctx, t3Budget, queryFp);

    const remainingAfterT3 = remainingAfterT2 - tier3.tokens;
    const t4Budget = Math.min(BRIEFING_ALLOCATION.TIER4_BUDGET, remainingAfterT3);
    const { tier: tier4, includedCorrectionIds } = renderTier4(memoryRepo, ctx, t4Budget, queryFp);

    const allLines = [
      ...tier1.lines,
      ...governance.lines,
      ...tier4.lines,
      ...tier2.lines,
      ...tier3.lines,
    ];
    const renderedMemoryIds = [...includedDecisionIds, ...includedPitfallIds, ...includedCorrectionIds];
    const text = allLines.join('\n');
    return { text, tokenEstimate: estimateTokensFast(text), includedPitfallIds, renderedMemoryIds };
  };

  // M4: budget reduction lives here, not in the caller. Only T3 (and T4's
  // flow-on budget) depends on maxPitfalls, so T1/T2/queryFp — the DB-heavy
  // work — are computed exactly once instead of up to three times.
  let out = assemble();
  for (const level of [LIMITS.BRIEFING_PITFALLS_COMPACT, LIMITS.BRIEFING_PITFALLS_MINIMAL]) {
    if (out.tokenEstimate <= maxBudget) break;
    if ((ctx.maxPitfalls ?? Number.POSITIVE_INFINITY) <= level) continue; // already at/below this level
    out = assemble(level);
  }

  return appendContradictions(memoryRepo, ctx, out);
}

/** Arbitration surfacing: append a small "verify & resolve" section for any
 *  unresolved contradiction pairs. Non-destructive — both sides still surface
 *  in their tiers; this only asks the human/agent to break the tie. Appended
 *  AFTER budget reduction so a high-signal conflict is never budget-cut, and
 *  only when conflicts exist (so briefings without conflicts are unchanged). */
function appendContradictions(
  memoryRepo: MemoryRepository,
  ctx: BriefingContext,
  out: BriefingOutput,
): BriefingOutput {
  const pairs = memoryRepo.getContradictions(ctx.project);
  if (pairs.length === 0) return out;
  const clip = (s: string) => (s.length > 70 ? s.slice(0, 67) + '...' : s);
  const lines = pairs.slice(0, LIMITS.BRIEFING_CONTRADICTIONS_MAX)
    .map(p => `  ⚠ "${formatMemoryContent({ ...p.winner, content: clip(p.winner.content) })}" vs "${formatMemoryContent({ ...p.loser, content: clip(p.loser.content) })}"`);
  const section = ['[WAYKEEP] Conflicting memories — verify & resolve:', ...lines].join('\n');
  const text = out.text ? `${out.text}\n${section}` : section;
  return { ...out, text, tokenEstimate: estimateTokensFast(text) };
}
