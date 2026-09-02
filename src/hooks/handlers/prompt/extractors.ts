/**
 * Prompt-derived memory extractors — decision detection and goal-staleness.
 * Both are exported through the prompt-handler facade for tests.
 */
import { isMetaGoal } from '../../shared/transcript-parser.js';
import { LIMITS } from '../../../constants/index.js';
import type { Memory } from '../../../db/memory-repository.js';

/**
 * v3.1 staleness gate for kind=goal memories surfaced via prompt-handler
 * recall paths (goal pre-flight + Layer 1a/1b/1c).
 *
 * Two rejection rules; either trips the gate:
 *   1. isMetaGoal(content) — catches session-continuity blurbs ("Resume
 *      point: …", "Next: … then commit", "continue this was where you
 *      were…") that were stored via waykeep_learn but aren't durable goals.
 *   2. Age > GOAL_REMINDER_MAX_AGE_HOURS — even a well-formed goal memory
 *      stops being relevant once enough time has passed; session-scoped
 *      context rots fast and padding the prompt with last week's plan
 *      hurts SNR more than helps recall.
 *
 * Non-goal memories pass through unchanged — this gate is goal-kind only.
 * The briefing compiler applies equivalent staleness via evaluateCarriedGoal
 * and renderGoalTiers; this helper closes the parallel recall path that
 * v3 didn't scope.
 */
export function isGoalMemoryStale(mem: Memory, nowMs: number = Date.now()): boolean {
  if (mem.kind !== 'goal') return false;
  if (isMetaGoal(mem.content)) return true;
  const createdMs = Date.parse(mem.created_at);
  if (Number.isNaN(createdMs)) return false;
  const ageHours = (nowMs - createdMs) / (1000 * 60 * 60);
  return ageHours > LIMITS.GOAL_REMINDER_MAX_AGE_HOURS;
}

/** Detect an explicit user decision (choice verb + rationale) in a prompt.
 *  Exported for tests — prompt-check.test.ts previously asserted against
 *  private regex copies that could never catch a real regression. */
import { isPastedShape, isRejectedSentence, splitSentences, stripPrependedContext } from '../../shared/capture-shapes.js';

export function extractDecision(prompt: string): string | null {
  // Prepended IDE-context blocks are removed first: what remains is the
  // user's authored message (recheck finding — the tag and the trailing text
  // often share one unpunctuated "sentence").
  prompt = stripPrependedContext(prompt);
  // Pasted material (attribution envelopes, transcript glyphs) is checked
  // against the WHOLE prompt: an envelope in sentence 1 must not launder a
  // clean-looking sentence 2 (step-1 review, block 2).
  if (isPastedShape(prompt)) return null;

  const lower = prompt.toLowerCase();

  // Precision-first auto-capture: requests for agent work and conversational
  // meta-discussion describe what to do, not a durable product/architecture
  // choice. This explicitly closes the live "ask Codex to evaluate/review"
  // false-positive family.
  const conversationalOrTasking = [
    /\b(?:ask(?:s|ed|ing)?|review(?:s|ed|ing)?|evaluat(?:e|es|ed|ing|ion))\b/,
    /^\s*(?:please\b|can\s+you\b|could\s+you\b|would\s+you\b|will\s+you\b)/,
    /\b(?:what\s+(?:are\s+your\s+thoughts|do\s+you\s+think)|take\s+a\s+look)\b/,
  ];
  if (conversationalOrTasking.some(pattern => pattern.test(lower))) return null;

  const hasRationale = /\b(because|since|so\s+that|reason\s+is|due\s+to)\b/.test(lower);
  if (!hasRationale) return null;

  const decisionPatterns = [
    /\b(let'?s\s+(use|go\s+with)|we'?ll\s+use|decided?\s+to|choosing|chose|going\s+with|picked|selected|prefer)\b/,
    /\b(use\s+\w+\s+(instead|over|rather))\b/,
    /\b(switch\s+to|move\s+to|adopt|stick\s+with)\b/,
  ];

  if (!decisionPatterns.some(p => p.test(lower))) return null;

  const normalized = prompt.replace(/\s+/g, ' ').trim();

  // Short prompts keep the historical whole-capture semantics: a short
  // message that trips the trigger IS the decision.
  // Short prompts capture whole — UNLESS an IDE-context block is present, in
  // which case they use the same sentence selection as long prompts: the
  // block's sentence is ineligible, the user's own trailing sentence is not.
  // (Blanket-rejecting short prompts here suppressed genuine decisions after
  // a <=200-char IDE prelude — recheck finding.)
  if (normalized.length <= 200 && !isRejectedSentence(normalized)) {
    return normalized;
  }

  // Long prompts: the trigger may be buried anywhere, and storing the prompt
  // PREFIX persisted 83 unrelated fragments as "decisions" in the live store
  // (one an <ide_opened_file> IDE injection). Capture the SENTENCE that
  // carries the trigger — and require its rationale in the SAME sentence, so
  // an unrelated "because" elsewhere cannot launder a non-decision — or
  // capture nothing at all. The prefix is never an acceptable output.
  // Split the RAW prompt: normalizing first fuses unpunctuated paste lines
  // into their neighbors, so the captured "sentence" drags log lines along.
  for (const rawSentence of splitSentences(prompt)) {
    const sentence = rawSentence.replace(/\s+/g, ' ').trim();
    const sLower = sentence.toLowerCase();
    if (!decisionPatterns.some(p => p.test(sLower))) continue;
    if (!/\b(because|since|so\s+that|reason\s+is|due\s+to)\b/.test(sLower)) continue;
    if (isRejectedSentence(sentence)) continue;
    // A "sentence" that exceeds the cap is a run-on or an unterminated paste
    // fragment — slicing it would reintroduce exactly the mid-thought
    // truncation this gate exists to end. Skip it and keep looking.
    if (sentence.length > 200) continue;
    return sentence;
  }
  return null;
}
