/**
 * Approach-note, winning-pattern, and error-output extraction from
 * transcript content.
 */
import { LEARNABLE_ERROR_PATTERNS, NOISE_ERROR_PATTERNS } from '../../../constants/index.js';

/**
 * Filter approach notes to strategy-like content, skipping conversational
 * responses ("Go ahead", "Here's the summary", "Let me check").
 */
export function isApproachNote(text: string): boolean {
  const lower = text.toLowerCase().trim();
  // Skip short conversational responses
  if (lower.length < 80) return false;
  // Skip common conversational starters that aren't strategy
  const conversational = [
    /^(go ahead|sure|ok|yes|no|done|perfect|great|got it|understood)/,
    /^(here'?s|here are|let me|i'?ll|i'?m going to|now (let me|i'?ll))/,
    /^(all done|that'?s|this (is|was)|the (fix|issue|problem|error))/,
    /^(good point|right[,. —]|fair|agreed|exactly|you're right|i agree|interesting|nice )/,
    /^(found it|there it is|that explains|that'?s (?:the|why|what|it))/,  // Debugging conclusions
    /^\*\*/,  // Markdown bold headers (status updates like "**201 tests pass**")
    /^all (changes|fixes|updates|tasks|items|modifications)\b/,  // Summary openers
    /^(in summary|to summarize|to recap|recap:)/,                 // Recap openers
  ];
  if (conversational.some(p => p.test(lower))) return false;
  // Skip code/regex discussion — debugging internals, not forward-looking strategy
  if (/[`]/.test(text) || /\\[bBdDwWsS]|\(\?[:<!=]/.test(text)) return false;
  // Skip status updates / progress reports (pure noise in approach notes)
  const statusNoise = [
    /\b\d+\s+(tests?|benchmarks?)\s+(pass|passing|passed|fail)/,
    /\bbuild\s+(clean|pass|succeed|ok)\b/,
    /\ball\s+\d+\s+tests?\b/,
    /\bexit\s+code:?\s*0\b/,
    /\bbug\s*#?\d+\b.*\b(is|was)\s+(fixed|resolved)\b/,
  ];
  if (statusNoise.some(p => p.test(lower))) return false;
  // Skip structured documentation / retrospective reports
  const documentNoise = [
    /\n#{1,3}\s/,                           // Contains markdown headers = structured report
    /\bsummary of (what|the|all|each)\b/,   // "summary of what each fix addresses..."
  ];
  if (documentNoise.some(p => p.test(lower))) return false;
  // Approach notes must show planning/strategy signals.
  // Short texts (<200 chars): require BOTH approach + reasoning to avoid false positives.
  // Longer texts (≥200 chars): a single approach signal suffices — length itself
  // indicates substantive content, and the conversational/status filters above
  // already reject noise.
  const approachSignals = [
    /\b(approach|strategy|design|architecture|pattern)\b/,
    /\b(implement|adopt|choose|prefer|use)\b.*\b(instead|over|rather than|for)\b/,
    /\b(first|then|next|finally|step \d)\b/,
  ];
  const reasoningSignals = [
    /\b(because|since|reason|trade-?off|alternative|rationale|therefore|so that)\b/,
  ];
  const hasApproach = approachSignals.some(p => p.test(lower));
  const hasReasoning = reasoningSignals.some(p => p.test(lower));
  if (lower.length >= 200) return hasApproach || hasReasoning;
  return hasApproach && hasReasoning;
}

/**
 * Extract a winning-pattern statement from assistant text (Phase 3).
 * Requires BOTH an approach signal (what was done) AND a success marker
 * (worked, clean build, tests green, first try). Distilled pattern
 * sentences are stored as kind='pattern' memories on successful sessions
 * so they can be surfaced as positive examples on future similar tasks.
 *
 * Conservatively gated — we only want distilled wins, not victory laps or
 * conversational celebrations. Rejects markdown headers, bullet lists,
 * and status recaps.
 */
export function extractWinningPattern(text: string): string | null {
  const lower = text.toLowerCase().trim();
  if (lower.length < 40 || lower.length > 400) return null;

  // Reject structured reports, recaps, bullet lists
  if (/^#{1,3}\s/.test(text.trim())) return null;
  if ((text.match(/\*\*/g) ?? []).length >= 3) return null;
  if ((text.match(/^\s*-\s/gm) ?? []).length >= 3) return null;

  // Reject conversational openers and pure status lines
  if (/^(here'?s|let me|i'?ll|ok[,. ]|now |done\b|all done|all tests? pass)/i.test(lower)) return null;
  if (/^(good (point|question|work)|great|perfect|nice|excellent|interesting|got it)/i.test(lower)) return null;

  // Must contain an approach signal (the "what")
  const approachSignals = [
    /\b(approach|strategy|pattern|solution|fix|refactor|implementation)\b/,
    /\b(used|adopted|applied|wrote|built|introduced|added|switched to)\b/,
  ];
  if (!approachSignals.some(p => p.test(lower))) return null;

  // Must contain a success signal (the "worked" evidence)
  const successSignals = [
    /\b(worked (?:on (?:the )?first try|cleanly|perfectly|well))\b/,
    /\b(tests?\s+(?:all\s+)?(?:pass|passed|green))\b/,
    /\b(clean build|build (?:is )?clean|no (?:errors|failures|issues))\b/,
    /\b(zero (?:regressions|failures))\b/,
    /\b(first\s*try|first\s*attempt|in one shot)\b/,
  ];
  if (!successSignals.some(p => p.test(lower))) return null;

  // Reject generic confirmations that hit the word matches without substance
  if (/^(all tests pass|tests pass|build (?:clean|passes|ok))\.?$/i.test(lower)) return null;

  let pattern = text.replace(/\s+/g, ' ').trim();
  if (pattern.length > 200) {
    pattern = pattern.slice(0, 197) + '...';
  }
  return pattern;
}

/** Reject-by-default error capture: only accept tool_result content that matches
 *  a known error pattern. Rejects source code, noise errors, and generic text
 *  that happens to contain "error" in identifiers. */
export function isLikelyErrorOutput(text: string): boolean {
  const lines = text.split('\n').slice(0, 3);
  const head = lines.join('\n');
  const firstLine = lines[0]?.trim() ?? '';
  // Reject Read/Grep tool output (line-numbered source code)
  if (/^\d+[\t\s]/.test(firstLine)) return false;
  // Reject code declarations/comments (import, const, /**, etc.)
  if (/^\s*(const |let |var |function |import |export |\/\*|\/\/|\* |class |interface )/.test(firstLine)) return false;
  // Reject noise patterns (transient env issues: timeouts, permissions, signals)
  if (NOISE_ERROR_PATTERNS.some(p => p.test(head))) return false;
  // Accept only known error patterns — reject everything else
  return LEARNABLE_ERROR_PATTERNS.some(p => p.pattern.test(head));
}

/** Extract deduplicated error summary from tool_result error blocks.
 *  Uses a normalized key for dedup but preserves the original text for display. */
export function extractErrorContext(
  errorOutputs: Array<{ error: string; file: string | null }>,
): Array<{ errorKey: string; errorText: string; count: number; lastFile: string | null }> {
  const errorMap = new Map<string, { errorText: string; count: number; lastFile: string | null }>();

  for (const { error, file } of errorOutputs) {
    const firstLine = error.split('\n')[0]?.trim().slice(0, 80) ?? 'unknown';
    // Dedup key: normalize digits and quoted strings so similar errors collapse
    const key = firstLine.replace(/\d+/g, 'N').replace(/['"][^'"]*['"]/g, '""').slice(0, 60);
    const existing = errorMap.get(key);
    if (existing) {
      existing.count++;
      existing.lastFile = file ?? existing.lastFile;
    } else {
      errorMap.set(key, { errorText: firstLine, count: 1, lastFile: file });
    }
  }

  return Array.from(errorMap.entries())
    .map(([errorKey, { errorText, count, lastFile }]) => ({ errorKey, errorText, count, lastFile }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);
}
