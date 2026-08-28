/**
 * Decision mining from assistant text: legacy prose extraction (Layer 1b)
 * and explicit `[dec: …]` sigil parsing (Layer 1a).
 */

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

  // Extract first 200 chars, clean up
  let decision = text.replace(/\s+/g, ' ').trim();
  if (decision.length > 200) {
    decision = decision.slice(0, 197) + '...';
  }
  return decision;
}

/** Max content length for a single sigil decision (matches legacy extractor cap). */
const SIGIL_MAX_LENGTH = 200;

/** Max distinct sigils returned per turn. Guards against pathological input. */
const SIGIL_MAX_PER_TURN = 8;

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
 * Returns an array of distilled sigil contents (up to SIGIL_MAX_PER_TURN).
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
    if (results.length >= SIGIL_MAX_PER_TURN) break;
    let content = match[1].replace(/\s+/g, ' ').trim();
    if (content.length === 0) continue;
    if (content.length > SIGIL_MAX_LENGTH) {
      content = content.slice(0, SIGIL_MAX_LENGTH - 3) + '...';
    }
    // Dedup within a single turn — repeated sigils collapse to one store.
    const key = content.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    results.push(content);
  }
  return results;
}
