/**
 * Shared importer helpers — ONE kind-inference heuristic and ONE slug
 * shape across all sources (three divergent copies invited drift;
 * review). Inference is deliberately conservative: imports land at
 * default confidence, and Waykeep's decay/feedback loops correct
 * misclassification over time.
 */
import type { LearnSection } from './learn-pipeline.js';

/** Wording → kind. Decision requires CHOICE phrasing — bare 'over'
 *  matches "iterate over rows" (review). */
export function inferKind(text: string): LearnSection['kind'] {
  if (/\b(never|avoid|don'?t|broke|breaks|fails?|error|pitfall|gotcha|warning|race|leak|crash|bug)\b/i.test(text)) return 'pitfall';
  if (/\b(chose|decided|opted|picked)\b/i.test(text)
    || /\bprefer(red)?\b[\s\S]{0,60}\bover\b/i.test(text)
    || /\binstead of\b/i.test(text)) return 'decision';
  return 'fact';
}

/** `prefix:slug-of-value`, capped — the one tag shape for provenance. */
export function slugTag(prefix: string, value: string): string {
  return `${prefix}:${value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)}`;
}
