import { countTokens } from '@anthropic-ai/tokenizer';

/**
 * Accurate Claude token count via @anthropic-ai/tokenizer.
 *
 * WARNING: This is SLOW — ~130 ms per call even warm, ~780 ms first call.
 * The tokenizer initializes a WASM module on first use and performs real
 * BPE tokenization on every subsequent call. Use this only when you need
 * an authoritative count (e.g. final hard-truncation safety net).
 *
 * For budget checks in hot loops (briefing compilation, incremental token
 * tracking, tier reduction passes) use estimateTokensFast instead — it is
 * ~1,000,000x faster and overestimates conservatively.
 */
export function estimateTokens(text: string): number {
  return countTokens(text);
}

/**
 * Fast, conservative char-based token estimate.
 *
 * Empirical measurement on real briefing lines: the aggregate chars-per-token
 * ratio on typical briefing content is about 3.75. Dividing by 3.0 gives a
 * safe overestimate (~25% headroom on aggregate). Individual lines vary —
 * very short headers can undershoot, long prose slightly overshoots — but for
 * incremental budget tracking in compileBriefing the aggregate safety margin
 * is what matters.
 *
 * Use this everywhere the cost of a ~130 ms countTokens call dominates the
 * value of exact precision. Use estimateTokens (real tokenizer) only when
 * an authoritative count is required.
 *
 * Cost: a few microseconds per call. No initialization overhead.
 */
export function estimateTokensFast(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil(text.length / 3.0);
}

/**
 * Truncate text to fit within a token budget, preserving whole lines.
 *
 * Uses the fast char-based estimator (over-counts slightly, never under-counts
 * in aggregate) so the session-start critical path does not pay the ~130 ms
 * cost of a real countTokens call. The tier-based reducer in
 * briefing-compiler.ts already keeps output well under budget, so this acts
 * purely as a safety net — precision here does not affect correctness.
 */
export function truncateToTokenBudget(text: string, maxTokens: number): string {
  if (estimateTokensFast(text) <= maxTokens) return text;

  const lines = text.split('\n');
  let result = '';
  for (const line of lines) {
    const candidate = result ? `${result}\n${line}` : line;
    if (estimateTokensFast(candidate) > maxTokens) break;
    result = candidate;
  }
  return result || text.slice(0, maxTokens * 3); // fallback: rough char estimate
}
