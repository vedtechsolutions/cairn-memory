/**
 * One truncation. The output never exceeds `maxChars` once the budget covers
 * the ellipsis; a budget smaller than the ellipsis yields the ellipsis alone
 * (the old copies produced a negative slice there — no caller passes such a
 * budget, every budget is a named constant). Seven copies (two named, five
 * inline) with two glyphs and their own off-by-one arithmetic lived in the
 * briefing, transcript, plan, signal, decision and scanner code (audit).
 */
import { ELLIPSIS } from '../constants/budgets.js';

export function truncate(text: string, maxChars: number, ellipsis: string = ELLIPSIS.UNICODE): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, Math.max(0, maxChars - ellipsis.length)) + ellipsis;
}

/** The ASCII form: transcript snapshots and plan text, whose consumers expect "...". */
export function truncateAscii(text: string, maxChars: number): string {
  return truncate(text, maxChars, ELLIPSIS.ASCII);
}
