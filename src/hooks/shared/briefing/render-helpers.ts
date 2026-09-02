/** Shared line-level helpers for the briefing renderers — truncation,
 *  quality filters, tier measurement, plan/cursor line formatting. */
import type { Plan } from '../../../db/plan-repository.js';
import { LIMITS } from '../../../constants/index.js';
import { estimateTokensFast } from '../../../utils/tokens.js';
import { basename } from 'node:path';
import { existsSync as fsExistsSync } from 'node:fs';
import type { BriefingContext } from './types.js';
import { TOOL } from '../../../constants/mcp.js';

/** T1↔T2 decision dedup Jaccard threshold (GAP F). Slightly looser than staleness. */
export const DECISION_DEDUP_JACCARD = 0.55;

/** Truncate text to maxChars, adding ellipsis if cut */
export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars - 1) + '…';
}

/** Format the Phase 2 resume cursor as a briefing line, or return null when
 *  the cursor is absent, stale (>RESUME_CURSOR_STALE_MS), or points to a
 *  file that no longer exists. "Resume: <basename>:<line> (<tool>, Nm ago)".
 *  The ":<line>" segment is omitted entirely when line extraction failed —
 *  the file, tool, and age still render so Claude sees what was touched. */
export function renderResumeCursor(cursor: BriefingContext['lastEditCursor']): string | null {
  if (!cursor || !cursor.file || !cursor.at) return null;

  const age = Date.now() - cursor.at;
  if (age < 0 || age > LIMITS.RESUME_CURSOR_STALE_MS) return null;

  // Suppress cursors pointing at files that no longer exist (e.g. git clean
  // between sessions). Best-effort — wrapped in try/catch so an fs error
  // doesn't poison the briefing. Uses fsExistsSync imported at the top so
  // ESM doesn't need a dynamic require.
  try {
    if (!fsExistsSync(cursor.file)) return null;
  } catch { /* best-effort */ }

  const file = basename(cursor.file);
  const linePart = cursor.line != null ? `:${cursor.line}` : '';
  const ageMins = Math.round(age / 60_000);
  const ageLabel = ageMins < 1 ? 'just now' : `${ageMins}m ago`;
  return `Resume: ${file}${linePart} (${cursor.tool}, ${ageLabel})`;
}

/** Detect decisions describing completed historical work — noise in briefings.
 *  Matches: "all implemented and verified", "completed/released in vX.Y", etc. */
export function isCompletedDecision(content: string): boolean {
  const lower = content.toLowerCase();
  // "all implemented and verified in vX.Y.Z" — historical completed work
  if (/\ball\s+implemented\b.*\bverified\b/.test(lower)) return true;
  // "completed/released/shipped and verified/confirmed in vX.Y"
  if (/\b(?:completed|released|shipped)\s+(?:and\s+)?(?:verified|confirmed)\s+in\s+v\d/.test(lower)) return true;
  // "— all implemented" at end of decision (common pattern)
  if (/—\s*all\s+implemented\b/.test(lower)) return true;
  return false;
}

/** Filter conversational text from approach notes (defense-in-depth on top of isApproachNote) */
export function isConversationalApproach(text: string): boolean {
  const lower = text.toLowerCase().trim();
  return /^(good point|here are|right[,. —]|fair|agreed|exactly|nice |interesting|you're right|i agree|that makes sense|all \d+)/.test(lower);
}

/** Correction quality gate — reject raw conversational/task text that isn't a distilled lesson.
 *  Real corrections are actionable directives: "always X", "use X not Y", "never do Z".
 *  Noise: raw user messages like "lets discuss so i need to ensure..." */
export function isCorrectionQuality(content: string): boolean {
  const lower = content.toLowerCase().trim();
  if (lower.length < 15) return false;
  if (/^(let'?s|i need|i want|we (need|should)|can you|please|go back|i('m| am) going|based on|given)/i.test(lower)) return false;
  if (/^(so i?|ok |yeah|hey |um |hmm|well |right |sure |i am back|lets do|lets go)/i.test(lower)) return false;
  if (/\b(discuss|analyze|investigate|research|explore|lets)\b/.test(lower) && !/\b(don'?t|never|avoid|stop)\b/.test(lower)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Tier renderers — each returns lines + token estimate
// ---------------------------------------------------------------------------

export interface TierResult {
  lines: string[];
  tokens: number;
}

export function emptyTier(): TierResult { return { lines: [], tokens: 0 }; }

export function measureLines(lines: string[]): TierResult {
  const text = lines.join('\n');
  return { lines, tokens: estimateTokensFast(text) };
}

export function formatPlanSummary(plan: Plan, interrupted: boolean): string {
  const total = plan.steps.length;
  const done = plan.steps.filter(s => s.status === 'done').length;
  const current = plan.steps.find(s => s.status === 'in_progress');
  const allComplete = total > 0 && done === total;
  const flag = interrupted ? ' [interrupted]' : allComplete ? ' [complete]' : '';

  let line = `Plan: "${plan.name}" — step ${done}/${total}${flag}`;

  if (current) {
    line += `\n  Current: ${current.step_id}. ${current.description}`;
    if (current.notes.length > 0) {
      const latest = current.notes[current.notes.length - 1];
      line += ` (${latest.note})`;
    }
  }

  const nextPending = plan.steps.find(s => s.status === 'pending');
  if (nextPending) {
    line += `\n  Next: ${nextPending.step_id}. ${nextPending.description}`;
  }

  const blocked = plan.steps.filter(s => s.status === 'blocked');
  if (blocked.length > 0) {
    line += `\n  Blocked: ${blocked.map(s => `${s.step_id}(${s.blockers})`).join(', ')}`;
  }

  if (plan.decisions.length > 0) {
    line += `\n  Decisions: ${plan.decisions.length} recorded (call ${TOOL.PLAN} get for full map)`;
  }

  return line;
}
