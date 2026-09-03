/**
 * Decision mining from assistant text: legacy prose extraction (Layer 1b)
 * and explicit `[dec: …]` sigil parsing (Layer 1a).
 */
import { isPastedShape, isRejectedSentence, splitSentences, stripPrependedContext } from '../capture-shapes.js';
import { SIGIL } from '../../../constants/index.js';

/**
 * Extract decision-like statements from assistant text (Layer 1b).
 * Requires BOTH a choice signal AND a rationale signal to avoid noise.
 * Returns a distilled decision string or null.
 */
export function extractAssistantDecision(text: string): string | null {
  const lower = text.toLowerCase().trim();
  // Skip short texts, long-form analysis, and conversational starters
  if (lower.length < 40 || lower.length > 500) return null;
  if (/^(here'?s|let me|i'?ll (check|read|look)|now |done|ok)/.test(lower)) return null;

  // Reject conversational openers — these are responses to user questions, not decisions
  if (/^(good question|great question|honest (answer|assessment)|fair point|interesting|that'?s a|absolutely|excellent question)/i.test(lower)) return null;

  // Reject long-form analysis responses (markdown headers or heavy formatting)
  if (/^#{1,3}\s/.test(text.trim()) || (text.match(/\*\*/g) ?? []).length >= 3) return null;

  // Must contain a choice/decision signal
  const choiceSignals = [
    /\b(i'll use|going with|the fix is to|chose|choosing|i chose)\b/,
    /\b(the approach is|we'll use|switching to|adopting|opted for)\b/,
    /\b(use \w+ instead of|use \w+ over|prefer \w+ to)\b/,
    /\b(decided to|the design|the strategy is)\b/,
  ];
  if (!choiceSignals.some(p => p.test(lower))) return null;

  // Must contain a rationale signal — this prevents "I'll use Read to check" false positives
  const rationaleSignals = [
    /\b(because|since|so that|the reason|due to|trade-?off|this (lets|allows|ensures|prevents|avoids))\b/,
  ];
  if (!rationaleSignals.some(p => p.test(lower))) return null;

  text = stripPrependedContext(text);
  // Pasted material never becomes a decision, whatever else matched.
  if (isPastedShape(text)) return null;

  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= 200 && !isRejectedSentence(normalized)) return normalized;

  // 201–500 chars: this path stored `slice(0,197)+'…'` — the same
  // prefix-truncation defect as the prompt extractors, and the source of the
  // 29 source='learned' polluting rows (step-1 review, block 1). Select the
  // sentence carrying BOTH signals, or capture nothing; never the prefix.
  for (const rawSentence of splitSentences(text)) {
    const sentence = rawSentence.replace(/\s+/g, ' ').trim();
    if (sentence.length > 200) continue;
    const sLower = sentence.toLowerCase();
    if (!choiceSignals.some(p => p.test(sLower))) continue;
    if (!rationaleSignals.some(p => p.test(sLower))) continue;
    if (isRejectedSentence(sentence)) continue;
    return sentence;
  }
  return null;
}

/** Matches `[dec: content]` anywhere in text. Content capped via post-match
 *  truncation, not the regex itself, so pathological inputs can't cause
 *  catastrophic backtracking. */
const SIGIL_PATTERN = /\[dec:\s*([^\]\n]{1,400})\]/gi;

/**
 * Extract decision sigils from assistant text.
 *
 * A sigil is explicit authorship: the agent (me) writes `[dec: chose X
 * because Y]` inline when making an architectural decision. Parsing is
 * cheap and has zero false-positive risk — unlike regex-based extraction
 * from natural prose, which fails on modern markdown-heavy output.
 *
 * Code fences and inline backticks are stripped first so documentation
 * examples of the sigil syntax don't self-capture.
 *
 * Returns an array of distilled sigil contents (up to SIGIL.MAX_PER_TURN).
 */
export function extractDecisionSigils(text: string): string[] {
  if (!text || text.length < 6) return [];

  // Strip code fences and inline code so sigil examples in docs/code are
  // never captured. Fenced blocks first (non-greedy across lines), then
  // inline backticks.
  const cleaned = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ');

  const results: string[] = [];
  const seen = new Set<string>();
  let match: RegExpExecArray | null;
  SIGIL_PATTERN.lastIndex = 0;
  while ((match = SIGIL_PATTERN.exec(cleaned)) !== null) {
    if (results.length >= SIGIL.MAX_PER_TURN) break;
    const content = match[1].replace(/\s+/g, ' ').trim();
    if (content.length === 0) continue;
    // Step-4 review finding: over-long sigils were TRUNCATED to the exact
    // slice+'...' signature the 88-row remediation just cleaned — the
    // pollution would re-accumulate. Step-1 doctrine applies here too:
    // reject, never slice. A sigil is supposed to be a one-sentence
    // distillation; an over-cap one is misuse, not a lesson.
    if (content.length > SIGIL.MAX_LENGTH) continue;
    // Dedup within a single turn — repeated sigils collapse to one store.
    const key = content.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    results.push(content);
  }
  return results;
}
