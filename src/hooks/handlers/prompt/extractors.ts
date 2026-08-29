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
 *      were…") that were stored via cairn_learn but aren't durable goals.
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
export function extractDecision(prompt: string): string | null {
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

  let decision = prompt.replace(/\s+/g, ' ').trim();
  if (decision.length > 200) {
    decision = decision.slice(0, 197) + '...';
  }
  return decision;
}
