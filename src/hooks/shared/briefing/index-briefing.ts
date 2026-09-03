// ---------------------------------------------------------------------------
// Progressive-disclosure index briefing
// ---------------------------------------------------------------------------
import type { MemoryRepository } from '../../../db/memory-repository.js';
import { formatMemoryContent } from '../../../utils/memory-injection.js';
import type { PlanRepository, Plan } from '../../../db/plan-repository.js';
import { BRIEFING_ALLOCATION, BRIEFING_MODE, LIMITS, BRIEFING_BUDGET } from '../../../constants/index.js';
import { estimateTokensFast } from '../../../utils/tokens.js';
import { passesCrossProjectGuard, passesSameProjectRelevance, deriveProjectIdentityTokens, meaningfulTokenCount } from '../../../utils/cross-project-guard.js';
import type { BriefingContext, BriefingOutput } from './types.js';
import {
  buildBriefingQueryFp,
  narrowPolicyExclusions,
  broadRelevanceFp,
} from './query-fingerprint.js';
import { renderGoalTiers, formatGoalTierLine } from './goal-tiers.js';
import { computeEffectiveness } from './recovery.js';
import {
  truncate,
  renderResumeCursor,
  isCompletedDecision,
  isCorrectionQuality,
  formatPlanSummary,
} from './render-helpers.js';
import { renderGovernanceTier } from './governance-tier.js';
import { isMemoryEligibleForInjection } from '../../../utils/memory-injection.js';
import { TOOL } from '../../../constants/mcp.js';

/**
 * Emit a compact index briefing. Each memory entry is rendered as a single
 * short line prefixed with a stable type-coded ID (dec:/pit:/cor:/inv:) that
 * Claude can pass to the waykeep_expand MCP tool to pull full content, why,
 * how_to_apply, confidence, and effectiveness on demand.
 *
 * Target: ~400 tokens total. Much tighter than the full briefing. Trades
 * verbose detail at inject-time for on-demand expansion, following the
 * claude-mem and Anthropic Skills progressive-disclosure pattern.
 */
export function compileIndexBriefing(
  memoryRepo: MemoryRepository,
  planRepo: PlanRepository,
  ctx: BriefingContext,
): BriefingOutput {
  const lines: string[] = [];
  const includedPitfallIds: string[] = [];
  const renderedMemoryIds: string[] = [];

  lines.push('[Waykeep Memory Briefing — index]');

  if (ctx.project) {
    lines.push(`Project: ${ctx.project}`);
  }

  // Git state — single line
  if (ctx.gitState) {
    const parts: string[] = [];
    if (ctx.gitState.branch) parts.push(`branch: ${ctx.gitState.branch}`);
    if (ctx.gitState.uncommittedCount > 0) parts.push(`${ctx.gitState.uncommittedCount} uncommitted`);
    if (ctx.gitState.unpushedCount > 0) parts.push(`${ctx.gitState.unpushedCount} unpushed`);
    if (parts.length > 0) lines.push(`Git: ${parts.join(', ')}`);
  }

  // Structured user model (single line)
  if (ctx.structuredUserProfile) {
    lines.push(`User: ${ctx.structuredUserProfile}`);
  }

  // Plan state
  let plan: Plan | null = null;
  if (ctx.project) {
    plan = planRepo.getActive(ctx.project);
    if (plan) {
      lines.push(formatPlanSummary(plan, ctx.interrupted));
    }
  }

  // SNR v3 Commit 4: three-tier goal rendering, shared with renderTier1.
  // Index mode uses the tighter BRIEFING_MODE.INDEX_LINE_MAX_CHARS cap so
  // each goal line fits the compact index layout without wrapping.
  for (const tierRender of renderGoalTiers(ctx, plan, BRIEFING_MODE.INDEX_LINE_MAX_CHARS)) {
    lines.push(formatGoalTierLine(tierRender));
  }
  if (ctx.sessionType === 'compact' && ctx.compactionSnapshot) {
    const snap = ctx.compactionSnapshot;
    if (snap.reasoningState?.openQuestions?.length) {
      lines.push(`Open: ${snap.reasoningState.openQuestions.slice(0, 2).map(q => truncate(q, 60)).join('; ')}`);
    }
  }

  // Phase 2: resume cursor in the index briefing. Same staleness + file
  // existence gates as the full briefing path — both delegate to
  // renderResumeCursor so the logic stays in one place.
  const indexCursorLine = renderResumeCursor(ctx.lastEditCursor);
  if (indexCursorLine) {
    lines.push(indexCursorLine);
  }

  const governanceRemaining = (ctx.budgetOverride ?? BRIEFING_BUDGET.GOVERNANCE_TIER_MAX) -
    estimateTokensFast(lines.join('\n'));
  const governance = renderGovernanceTier(
    ctx.governance, Math.min(BRIEFING_BUDGET.GOVERNANCE_TIER_MAX, governanceRemaining),
  );
  lines.push(...governance.lines);

  // Decisions — effectiveness-ranked, one line each with dec: prefix
  // Phase 6a.2 + GAP C/D: task-aware queryFp drives cross-project + same-project
  // gates. Built once for all three INDEX-mode guard filters below.
  const indexQueryFp = buildBriefingQueryFp(ctx, plan);

  // GAP G: in compact mode, exclude memories that were already injected
  // pre-compact so the index briefing surfaces what was lost, not what
  // Claude already has in context.
  const alreadySurfaced = new Set<string>(
    ctx.sessionType === 'compact'
      ? (ctx.compactionSnapshot?.alreadySurfacedMemoryIds ?? [])
      : [],
  );

  // Over-fetch so the already-surfaced filter can drop items without
  // starving the index briefing.
  const decisionFetchLimit = BRIEFING_MODE.INDEX_MAX_DECISIONS * (alreadySurfaced.size > 0 ? 3 : 2);
  const decisionCandidates = memoryRepo.topDecisionsRanked(ctx.project, decisionFetchLimit);
  // SNR v3 Commit 3: cold-start policy shared across all three INDEX-mode
  // filters below. indexQueryFp is always defined now, so we can compute
  // the narrow flag once and reuse.
  const identityTokens = deriveProjectIdentityTokens(ctx.project);
  const indexUseNarrow = meaningfulTokenCount(indexQueryFp, narrowPolicyExclusions(ctx.project)) >= LIMITS.NARROW_OVERLAP_MIN_MEANINGFUL_TOKENS;
  const indexRelevanceFp = indexUseNarrow ? indexQueryFp : broadRelevanceFp(indexQueryFp);
  const decisionsGuarded = decisionCandidates
    .filter(d => passesCrossProjectGuard(d, ctx.project, indexQueryFp))
    .filter(d => passesSameProjectRelevance(d, indexRelevanceFp, null, identityTokens));
  const decisions = memoryRepo
    .filterSuperseded(decisionsGuarded)
    .filter(d => computeEffectiveness(d) >= BRIEFING_ALLOCATION.LOW_EFFECTIVENESS_THRESHOLD)
    .filter(d => !isCompletedDecision(d.content))
    .filter(d => !alreadySurfaced.has(d.id))
    .slice(0, BRIEFING_MODE.INDEX_MAX_DECISIONS);
  if (decisions.length > 0) {
    lines.push(`Decisions (${decisions.length}):`);
    for (const d of decisions) {
      lines.push(`  [dec:${d.id.slice(0, 8)}] ${formatMemoryContent({ ...d, content: truncate(d.content, BRIEFING_MODE.INDEX_LINE_MAX_CHARS) })}`);
      renderedMemoryIds.push(d.id);
    }
  }

  // Pitfalls — effectiveness-ranked, one line each with pit: prefix
  // Reuses indexQueryFp + the indexUseNarrow flag built in the decisions
  // block above. topPitfalls gets `undefined` when the narrow policy is
  // off so it falls back to raw effectiveness+recency ranking.
  const pitfallFetchLimit = BRIEFING_MODE.INDEX_MAX_PITFALLS * (alreadySurfaced.size > 0 ? 3 : 2);
  const pitfallCandidates = memoryRepo.topPitfalls(
    ctx.project,
    pitfallFetchLimit,
    indexUseNarrow ? indexQueryFp : undefined,
  );
  const pitfallsGuarded = pitfallCandidates
    .filter(isMemoryEligibleForInjection)
    .filter(p => passesCrossProjectGuard(p, ctx.project, indexQueryFp))
    .filter(p => passesSameProjectRelevance(p, indexRelevanceFp, null, identityTokens));
  const pitfalls = pitfallsGuarded
    .filter(p => computeEffectiveness(p) >= BRIEFING_ALLOCATION.LOW_EFFECTIVENESS_THRESHOLD)
    .filter(p => !alreadySurfaced.has(p.id))
    .slice(0, BRIEFING_MODE.INDEX_MAX_PITFALLS);
  if (pitfalls.length > 0) {
    lines.push(`Pitfalls (${pitfalls.length}):`);
    for (const p of pitfalls) {
      lines.push(`  [pit:${p.id.slice(0, 8)}] ${formatMemoryContent({ ...p, content: truncate(p.content, BRIEFING_MODE.INDEX_LINE_MAX_CHARS) })}`);
      includedPitfallIds.push(p.id);
      renderedMemoryIds.push(p.id);
    }
  }

  // Corrections — fingerprint-aware, one line each
  // Phase 6a.2 + GAP C/D: same strict cross-project guard AND same-project
  // relevance gate as pitfalls/decisions. GAP G (symmetry with decisions/
  // pitfalls above): drop items already surfaced pre-compact so the index
  // briefing shows what Claude lost, not what it still has in context.
  // SNR v3 Commit 3: cold-start policy reuses indexRelevanceFp from above.
  const correctionFetchLimit = BRIEFING_MODE.INDEX_MAX_CORRECTIONS * (alreadySurfaced.size > 0 ? 3 : 2);
  const corrections = memoryRepo
    .activeCorrections(ctx.project, correctionFetchLimit)
    .filter(c => isCorrectionQuality(c.content))
    .filter(c => passesCrossProjectGuard(c, ctx.project, indexQueryFp))
    .filter(c => passesSameProjectRelevance(c, indexRelevanceFp, null, identityTokens))
    .filter(c => !alreadySurfaced.has(c.id))
    .slice(0, BRIEFING_MODE.INDEX_MAX_CORRECTIONS);
  if (corrections.length > 0) {
    lines.push(`Corrections (${corrections.length}):`);
    for (const c of corrections) {
      lines.push(`  [cor:${c.id.slice(0, 8)}] ${formatMemoryContent({ ...c, content: truncate(c.content, BRIEFING_MODE.INDEX_LINE_MAX_CHARS) })}`);
      renderedMemoryIds.push(c.id);
    }
  }

  // Investigation chains — one line each
  if (ctx.resolvedChains && ctx.resolvedChains.length > 0) {
    const limit = Math.min(BRIEFING_MODE.INDEX_MAX_CHAINS, ctx.resolvedChains.length);
    lines.push(`Investigations (${limit}):`);
    for (let i = 0; i < limit; i++) {
      const chain = ctx.resolvedChains[i];
      const trigger = truncate(chain.trigger_error, 60);
      const resolution = chain.resolution ? ` → ${truncate(chain.resolution, 40)}` : '';
      lines.push(`  [inv:${i}] ${trigger}${resolution}`);
    }
  }

  // Footer — tell Claude how to get detail
  lines.push(`Use ${TOOL.EXPAND}(["<id>", ...]) for full content, why, and how-to-apply.`);

  const text = lines.join('\n');
  return {
    text,
    tokenEstimate: estimateTokensFast(text),
    includedPitfallIds,
    renderedMemoryIds,
  };
}
