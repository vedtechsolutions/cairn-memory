/** Tiers 2–4 renderers — decisions, pitfalls, and corrections pulled from the
 *  memory DB, effectiveness-ranked and SNR-guarded. */
import type { MemoryRepository } from '../../../db/memory-repository.js';
import type { Plan } from '../../../db/plan-repository.js';
import { LIMITS, BRIEFING_ALLOCATION } from '../../../constants/index.js';
import { estimateTokensFast } from '../../../utils/tokens.js';
import { neutralizeMemoryText } from '../../../utils/validation.js';
import type { ContextFingerprint } from '../../../utils/fingerprint.js';
import { passesCrossProjectGuard, passesSameProjectRelevance, deriveProjectIdentityTokens, meaningfulTokenCount } from '../../../utils/cross-project-guard.js';
import type { BriefingContext } from './types.js';
import {
  NARROW_OVERLAP_MIN_MEANINGFUL_TOKENS,
  narrowPolicyExclusions,
  broadRelevanceFp,
  tokeniseForOverlap,
  jaccardOverlap,
} from './query-fingerprint.js';
import { computeEffectiveness } from './recovery.js';
import {
  DECISION_DEDUP_JACCARD,
  truncate,
  isCompletedDecision,
  isCorrectionQuality,
  emptyTier,
  measureLines,
  type TierResult,
} from './render-helpers.js';

/** Tier 2: Decisions from memory DB — effectiveness-ranked */
export function renderTier2(
  memoryRepo: MemoryRepository,
  ctx: BriefingContext,
  plan: Plan | null,
  budget: number,
  queryFp: ContextFingerprint,
): { tier: TierResult; includedDecisionIds: string[] } {
  // In compact mode with plan decisions already in T1, use memory DB for cross-session decisions only
  // In startup mode, this is the primary decision source
  const hasPlanDecisions = plan && plan.decisions.length > 0;
  const hasSnapshotDecisions = ctx.sessionType === 'compact'
    && ctx.compactionSnapshot?.recentDecisions
    && ctx.compactionSnapshot.recentDecisions.length > 0;

  // If plan or snapshot already provided decisions in T1, pull fewer from DB to avoid duplication
  const candidateLimit = (hasPlanDecisions || hasSnapshotDecisions)
    ? LIMITS.MAX_CROSS_SESSION_DECISIONS
    : LIMITS.BRIEFING_MAX_DECISIONS;

  const rawDecisions = memoryRepo.topDecisionsRanked(ctx.project, candidateLimit);
  // SNR v3 Commit 3: always-on guards with cold-start policy. The cross-project
  // guard runs against the full synthesised queryFp (overlap=0 blocks
  // unfingerprinted globals). The same-project relevance gate runs against
  // the broad variant when meaningful token count is below threshold, so
  // same-project memories still surface via the broad-query short-circuit.
  const identityTokens = deriveProjectIdentityTokens(ctx.project);
  const useNarrow = meaningfulTokenCount(queryFp, narrowPolicyExclusions(ctx.project)) >= NARROW_OVERLAP_MIN_MEANINGFUL_TOKENS;
  const relevanceFp = useNarrow ? queryFp : broadRelevanceFp(queryFp);
  const guardedDecisions = rawDecisions
    .filter(d => passesCrossProjectGuard(d, ctx.project, queryFp))
    .filter(d => passesSameProjectRelevance(d, relevanceFp, null, identityTokens));
  const decisions = memoryRepo.filterSuperseded(guardedDecisions);
  let rendered = decisions
    .filter(d => computeEffectiveness(d) >= BRIEFING_ALLOCATION.LOW_EFFECTIVENESS_THRESHOLD)
    .filter(d => !isCompletedDecision(d.content));

  // Defense-in-depth: cross-tier dedup. GAP F replaces the original prefix
  // match with token-set Jaccard so near-duplicates with different prefixes
  // (e.g. "chose X because Y" vs "Decided to chose X because Y (alt: Z)")
  // actually collapse. Prefix match kept as a cheap exact-match fast path.
  const t1Sigs: Array<{ prefix: string; tokens: Set<string> }> = [];
  const pushSig = (text: string): void => {
    t1Sigs.push({
      prefix: text.toLowerCase().replace(/\s+/g, ' ').slice(0, LIMITS.DECISION_DEDUP_PREFIX),
      tokens: tokeniseForOverlap(text),
    });
  };
  if (hasPlanDecisions && plan) {
    for (const d of plan.decisions.slice(-LIMITS.BRIEFING_MAX_DECISIONS)) {
      pushSig(d.chose);
    }
  }
  if (hasSnapshotDecisions && ctx.compactionSnapshot?.recentDecisions) {
    for (const d of ctx.compactionSnapshot.recentDecisions.slice(-LIMITS.BRIEFING_MAX_DECISIONS)) {
      pushSig(d.chose);
    }
  }
  if (t1Sigs.length > 0) {
    rendered = rendered.filter(d => {
      const prefix = d.content.toLowerCase().replace(/\s+/g, ' ').slice(0, LIMITS.DECISION_DEDUP_PREFIX);
      const tokens = tokeniseForOverlap(d.content);
      for (const sig of t1Sigs) {
        if (sig.prefix === prefix) return false;
        if (jaccardOverlap(tokens, sig.tokens) >= DECISION_DEDUP_JACCARD) return false;
      }
      return true;
    });
  }

  const lines: string[] = [];
  const includedIds: string[] = [];
  let tokensSoFar = 0;

  // Render decisions if any
  if (rendered.length > 0) {
    const header = (hasPlanDecisions || hasSnapshotDecisions) ? 'Prior decisions:' : 'Decisions:';
    lines.push(header);
    tokensSoFar = estimateTokensFast(header);

    for (const d of rendered) {
      const eff = computeEffectiveness(d);
      // Neutralize untrusted memory text so it can't impersonate Waykeep's
      // system voice when injected back into the briefing (see H2).
      const content = neutralizeMemoryText(d.content);
      let line: string;
      if (eff >= BRIEFING_ALLOCATION.HIGH_EFFECTIVENESS_THRESHOLD) {
        const why = d.context?.why ? ` — ${neutralizeMemoryText(d.context.why)}` : '';
        line = `  - ${content}${why}`;
      } else {
        line = `  - ${content}`;
      }
      const lineTokens = estimateTokensFast(line);
      if (tokensSoFar + lineTokens > budget) break;
      lines.push(line);
      includedIds.push(d.id);
      tokensSoFar += lineTokens;
    }
  }

  // Investigation chains (resolved) — part of T2 budget, renders even without decisions
  // Quality gate: skip chains with generic triggers that provide no learning value
  const GENERIC_TRIGGER = /^Exit code N$/;
  if (ctx.resolvedChains && ctx.resolvedChains.length > 0) {
    const currentTokens = lines.length > 0 ? measureLines(lines).tokens : 0;
    for (const chain of ctx.resolvedChains.filter(c => !GENERIC_TRIGGER.test(c.trigger_error))) {
      const approaches = chain.attempts.map(a => a.approach).join(', ');
      const resolution = chain.resolution ?? 'unresolved';
      const chainLine = `  - Investigation: ${truncate(chain.trigger_error, 80)} → tried ${truncate(approaches, 80)} → ${truncate(resolution, 80)}`;
      const chainTokens = estimateTokensFast(chainLine);
      if (currentTokens + chainTokens > budget) break;
      lines.push(chainLine);
    }
  }

  if (lines.length === 0) return { tier: emptyTier(), includedDecisionIds: [] };

  return { tier: measureLines(lines), includedDecisionIds: includedIds };
}

/** Tier 3: Pitfalls — effectiveness-ranked (existing logic, now budget-aware) */
export function renderTier3(
  memoryRepo: MemoryRepository,
  ctx: BriefingContext,
  budget: number,
  queryFp: ContextFingerprint,
): { tier: TierResult; includedPitfallIds: string[] } {
  // Quality-adaptive pitfall count
  const basePitfallCount = ctx.sessionType === 'compact'
    ? LIMITS.BRIEFING_PITFALLS_COMPACT
    : LIMITS.BRIEFING_PITFALLS_NORMAL;
  const qualityAdjusted = ctx.previousSessionQuality?.label === 'stuck'
    ? Math.min(basePitfallCount + LIMITS.BRIEFING_PITFALLS_STUCK_BONUS, LIMITS.BRIEFING_PITFALLS_NORMAL + LIMITS.BRIEFING_PITFALLS_STUCK_BONUS)
    : ctx.previousSessionQuality?.label === 'smooth'
      ? Math.max(basePitfallCount - 1, LIMITS.BRIEFING_PITFALLS_MINIMAL)
      : basePitfallCount;
  const pitfallCount = ctx.maxPitfalls ?? qualityAdjusted;

  // SNR v3 Commit 3: cold-start policy governs whether to use the
  // synthesised queryFp for narrow-overlap re-ranking. When meaningful
  // token count is below threshold, the fp is too thin to rank memories
  // meaningfully — we fall back to pure effectiveness+recency ordering
  // (topPitfalls(..., undefined)) and run the cross-project guard against
  // the thin fp, with the broad variant for same-project relevance.
  const identityTokens = deriveProjectIdentityTokens(ctx.project);
  const useNarrow = meaningfulTokenCount(queryFp, narrowPolicyExclusions(ctx.project)) >= NARROW_OVERLAP_MIN_MEANINGFUL_TOKENS;
  const relevanceFp = useNarrow ? queryFp : broadRelevanceFp(queryFp);

  // Over-fetch so the guard pipeline can drop leaks without starving T3.
  const fetchPitfallCount = pitfallCount * 2;
  const pitfallsRaw = memoryRepo.topPitfalls(ctx.project, fetchPitfallCount, useNarrow ? queryFp : undefined);
  const pitfalls = pitfallsRaw
    .filter(p => passesCrossProjectGuard(p, ctx.project, queryFp))
    .filter(p => passesSameProjectRelevance(p, relevanceFp, null, identityTokens))
    .slice(0, pitfallCount);
  const renderedPitfalls = pitfalls.filter(p => computeEffectiveness(p) >= BRIEFING_ALLOCATION.LOW_EFFECTIVENESS_THRESHOLD);

  if (renderedPitfalls.length === 0) return { tier: emptyTier(), includedPitfallIds: [] };

  const lines: string[] = [];
  lines.push('Pitfalls:');
  let tokensSoFar = estimateTokensFast('Pitfalls:');

  const includedIds: string[] = [];
  for (const p of renderedPitfalls) {
    const eff = computeEffectiveness(p);
    // Neutralize untrusted memory text before it re-enters model context (H2).
    const content = neutralizeMemoryText(p.content);
    let line: string;
    if (eff >= BRIEFING_ALLOCATION.HIGH_EFFECTIVENESS_THRESHOLD) {
      const why = p.context?.why ? ` (Why: ${neutralizeMemoryText(p.context.why)})` : '';
      const howTo = p.context?.how_to_apply ? ` → ${neutralizeMemoryText(p.context.how_to_apply)}` : '';
      line = `  - ${content}${why}${howTo}`;
    } else {
      const why = p.context?.why ? ` (Why: ${neutralizeMemoryText(p.context.why)})` : '';
      line = `  - ${content}${why}`;
    }
    const lineTokens = estimateTokensFast(line);
    if (tokensSoFar + lineTokens > budget) break;
    lines.push(line);
    includedIds.push(p.id);
    tokensSoFar += lineTokens;
  }

  if (lines.length <= 1) return { tier: emptyTier(), includedPitfallIds: [] };

  return { tier: measureLines(lines), includedPitfallIds: includedIds };
}

/** Tier 4: Corrections — quality-filtered and fingerprint-aware */
export function renderTier4(
  memoryRepo: MemoryRepository,
  ctx: BriefingContext,
  budget: number,
  queryFp: ContextFingerprint,
): { tier: TierResult; includedCorrectionIds: string[] } {
  // SNR v3 Commit 3: cold-start policy — broad variant for same-project
  // relevance when meaningful token count is below threshold.
  const identityTokens = deriveProjectIdentityTokens(ctx.project);
  const useNarrow = meaningfulTokenCount(queryFp, narrowPolicyExclusions(ctx.project)) >= NARROW_OVERLAP_MIN_MEANINGFUL_TOKENS;
  const relevanceFp = useNarrow ? queryFp : broadRelevanceFp(queryFp);
  const corrections = memoryRepo.activeCorrections(ctx.project, 6)
    .filter(c => isCorrectionQuality(c.content))
    .filter(c => passesCrossProjectGuard(c, ctx.project, queryFp))
    .filter(c => passesSameProjectRelevance(c, relevanceFp, null, identityTokens))
    .slice(0, 3);

  if (corrections.length === 0) return { tier: emptyTier(), includedCorrectionIds: [] };

  const lines: string[] = [];
  const includedIds: string[] = [];
  lines.push('Corrections:');
  let tokensSoFar = estimateTokensFast('Corrections:');

  for (const c of corrections) {
    const line = `  - ${neutralizeMemoryText(c.content)}`;
    const lineTokens = estimateTokensFast(line);
    if (tokensSoFar + lineTokens > budget) break;
    lines.push(line);
    includedIds.push(c.id);
    tokensSoFar += lineTokens;
  }

  if (lines.length <= 1) return { tier: emptyTier(), includedCorrectionIds: [] };

  return { tier: measureLines(lines), includedCorrectionIds: includedIds };
}
