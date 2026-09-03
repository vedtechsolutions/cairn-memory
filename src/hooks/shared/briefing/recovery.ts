/** Effectiveness scoring + the Stage 2 recovery pass for dropped pitfalls. */
import type { MemoryRepository, Memory } from '../../../db/memory-repository.js';
import { BRIEFING_ALLOCATION } from '../../../constants/index.js';
import { estimateTokensFast } from '../../../utils/tokens.js';
import type { ContextFingerprint } from '../../../utils/fingerprint.js';
import { passesCrossProjectGuard, passesSameProjectRelevance, deriveProjectIdentityTokens, meaningfulTokenCount } from '../../../utils/cross-project-guard.js';
import { NARROW_OVERLAP_MIN_MEANINGFUL_TOKENS, narrowPolicyExclusions, broadRelevanceFp } from './query-fingerprint.js';
import { truncate } from './render-helpers.js';
import { isMemoryEligibleForInjection , formatMemoryContent } from '../../../utils/memory-injection.js';
import { MS_PER_DAY } from '../../../constants/time.js';

/** Compute effectiveness score (0–1) for a memory.
 *  High surface count with low impact = noise. High impact/surface ratio = valuable.
 *  Never-surfaced memories get benefit-of-the-doubt that decays with age —
 *  a 6-month-old unproven decision should not compete with a recent one. */
export function computeEffectiveness(memory: Memory): number {
  if (memory.surface_count === 0) {
    const fallbackWeight = memory.confidence >= 0.55 ? 0.5 : 0.3;
    // Age penalty: halve effectiveness every 30 days for never-surfaced memories
    const ageDays = (Date.now() - new Date(memory.created_at).getTime()) / MS_PER_DAY;
    const agePenalty = 1.0 / (1.0 + ageDays / 30);
    return memory.confidence * fallbackWeight * agePenalty;
  }
  const conversionRate = Math.min(1.0, memory.impact_count / memory.surface_count);
  return conversionRate * 0.7 + memory.confidence * 0.3;
}

/**
 * Stage 2 correction pass: recover high-impact pitfalls dropped by the
 * main briefing's multi-pass reduction (5 → 3 → 1 under budget pressure).
 *
 * # Contract
 *
 * Invariants this function maintains (audited in SNR v3 Commit 5):
 *
 *  1. **Post-budget only** — caller must check `briefing.tokenEstimate <
 *     budget` before invoking. `remainingTokenBudget` must be the
 *     positive delta. Returns null when < CORRECTION_PASS_MIN_BUDGET.
 *
 *  2. **Exclusion-respecting** — `includedPitfallIds` must list every
 *     pitfall already rendered by the main pass. Recovery never
 *     double-surfaces the same pitfall.
 *
 *  3. **Quality floor parity with main** — recovery applies the SAME
 *     effectiveness + confidence gates as `topPitfalls` so it cannot
 *     re-admit pitfalls the main pass intentionally dropped for being
 *     below `LOW_EFFECTIVENESS_THRESHOLD` or below
 *     `CORRECTION_PASS_MIN_CONFIDENCE`. Pre-Commit-5 this was a subtle
 *     divergence: recovery sorted by raw impact_count, so a pitfall
 *     with impact=10 / surface=100 / effectiveness=0.22 would be
 *     dropped by main (< 0.25 threshold) and then resurrected here.
 *
 *  4. **Same SNR guards as main** — cross-project guard + same-project
 *     relevance gate + cold-start policy (narrow vs broad based on
 *     meaningful token count). Shares the exact code path used by
 *     `topPitfalls` in `renderTier1` / `compileIndexBriefing`.
 *
 *  5. **Capped output** — at most `CORRECTION_PASS_MAX_ITEMS` lines,
 *     each truncated to `CORRECTION_PASS_MAX_CHARS`. Drops down to 1
 *     line or null when the full output wouldn't fit the remaining
 *     budget. Marked with `[!]` so Claude distinguishes recovery items
 *     from the main pitfall list.
 *
 * # Why not delete it?
 *
 * Considered in the Commit 5 audit. Recovery is still the only path
 * that surfaces high-impact memories after main's reduction passes
 * dropped them. Main's reduction picks the lowest-effectiveness
 * pitfalls to drop first; recovery adds back the highest-impact_count
 * items that ALSO pass the effectiveness + confidence gates. The two
 * rankings agree on the floor (both drop low-effectiveness) but differ
 * on the ceiling (main orders by effectiveness, recovery by impact
 * count) — so recovery can legitimately surface a high-raw-impact item
 * that main ranked just below the budget cutoff.
 */
export function recoverDroppedPitfalls(
  memoryRepo: MemoryRepository,
  project: string | null,
  includedPitfallIds: string[],
  remainingTokenBudget: number,
  queryFp?: ContextFingerprint,
): string | null {
  if (remainingTokenBudget < BRIEFING_ALLOCATION.CORRECTION_PASS_MIN_BUDGET) return null;

  const droppedRaw = memoryRepo.highImpactPitfalls(
    project,
    includedPitfallIds,
    BRIEFING_ALLOCATION.CORRECTION_PASS_MIN_IMPACT,
    BRIEFING_ALLOCATION.CORRECTION_PASS_MAX_ITEMS,
  );

  // SNR v3 Commit 3: cold-start policy also applies to the recovery pass.
  // This is the `highImpactPitfalls` SQL leak path — `project = ? OR
  // project IS NULL` returns null-project globals but the cross-project
  // guard drops them because overlap against the (possibly thin)
  // synthesised fp is zero. The same-project relevance gate uses the
  // broad variant when meaningful token count is below threshold so a
  // cold recovery pass still re-admits legitimate same-project drops.
  //
  // queryFp is kept optional on this exported signature for back-compat
  // with tests that don't build one; internally the empty-fingerprint
  // fallback (`{ lang: [], framework: [], module: [] }`) gives the
  // cold-start path the broad-query semantics.
  const identityTokens = deriveProjectIdentityTokens(project);
  const effectiveFp: ContextFingerprint = queryFp ?? { lang: [], framework: [], module: [] };
  const useNarrow = meaningfulTokenCount(effectiveFp, narrowPolicyExclusions(project)) >= NARROW_OVERLAP_MIN_MEANINGFUL_TOKENS;
  const relevanceFp = useNarrow ? effectiveFp : broadRelevanceFp(effectiveFp);
  // SNR v3 Commit 5 audit fix: apply the same effectiveness + confidence
  // floor the main briefing uses, so recovery can't re-admit pitfalls
  // main intentionally dropped for being below quality thresholds.
  const dropped = droppedRaw
    .filter(isMemoryEligibleForInjection)
    .filter(m => passesCrossProjectGuard(m, project, effectiveFp))
    .filter(m => passesSameProjectRelevance(m, relevanceFp, null, identityTokens))
    .filter(m => computeEffectiveness(m) >= BRIEFING_ALLOCATION.LOW_EFFECTIVENESS_THRESHOLD)
    .filter(m => m.confidence >= BRIEFING_ALLOCATION.CORRECTION_PASS_MIN_CONFIDENCE);

  if (dropped.length === 0) return null;

  const lines: string[] = [];
  for (const m of dropped) {
    lines.push(`  - [!] ${formatMemoryContent({ ...m, content: truncate(m.content, BRIEFING_ALLOCATION.CORRECTION_PASS_MAX_CHARS) })}`);
  }

  const text = lines.join('\n');
  if (estimateTokensFast(text) <= remainingTokenBudget) {
    return text;
  }

  if (lines.length > 1 && estimateTokensFast(lines[0]) <= remainingTokenBudget) {
    return lines[0];
  }

  return null;
}
