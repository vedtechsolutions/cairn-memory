import type { Memory } from '../db/memory-repository.js';
import { neutralizeMemoryText } from './validation.js';

/**
 * Explicit retirement markers accepted at the start of pitfall content.
 *
 * Keep this anchored: prose such as "the issue is resolved by retrying"
 * can still be a useful lesson. These forms mean the memory itself has been
 * marked resolved and must no longer enter agent context.
 */
const RESOLVED_PITFALL_MARKER = /^\s*(?:[-*]\s*)?(?:resolved\b|status\s*:\s*resolved\b|\[(?:status\s*:\s*)?resolved\])/i;

export function isResolvedPitfallContent(content: string): boolean {
  return RESOLVED_PITFALL_MARKER.test(content);
}

/**
 * THE single team-content formatter (brief D7/D8 item 7): every surface
 * that renders memory content — briefing tiers, prompt recall, pitfall
 * warnings, subagent context, both agents — routes content through this
 * function. TEAM content (author non-null: the server-stamped account
 * id only sync-apply writes) is labeled with provenance the CONTENT
 * cannot forge: the apply path neutralizes leading bracket markers at
 * ingest, and this label is added at RENDER time, after that
 * neutralization — so a payload carrying its own "[team …]" prefix has
 * it stripped before storage while genuine labels are minted fresh
 * here. Local rows render with the same cleaning, no label.
 *
 * KNOWN LIMIT (stated, not hidden): Unicode homoglyphs of the brand
 * (e.g. a Cyrillic 'а') cannot be closed by string matching — a
 * lookalike label can render visually similar. Zero-width splits ARE
 * closed (stripped in neutralizeMemoryText); the POSITION is the
 * signal: a genuine label is always at offset 0, minted here.
 */
// Anchors cover every line-break form: a BARE \r returns the carriage
// in a terminal, so `ok\r[waykeep-team: …]` rendered at the visual line
// start (formatter review C1).
const LINE_LEADING_MARKERS = /(^|[\r\n])(?:\s*\[\s*(?:cairn|waykeep)\b[^\]\n]*\]\s*)+/gi;

export function formatMemoryContent(
  memory: Pick<Memory, 'content'> & { author?: string | null; origin_client?: string },
): string {
  // Render-side defense-in-depth: the ingest neutralizer is
  // START-anchored, so a payload can smuggle a line-leading fake label
  // mid-content past it (newlines survive sanitization). Strip EVERY
  // line-leading [cairn…]/[waykeep…] marker at render — for local and
  // team rows alike — then mint the genuine label fresh.
  const cleaned = neutralizeMemoryText(memory.content).replace(LINE_LEADING_MARKERS, '$1').trim();
  if (memory.author === null || memory.author === undefined) return cleaned;
  const client = memory.origin_client ? ` via ${memory.origin_client}` : '';
  // The label sits INSIDE the ingest neutralizer's protected class
  // ('waykeep' + word boundary): a payload arriving WITH this exact
  // prefix has it stripped at apply, so only this function mints it.
  return `[waykeep-team: ${memory.author}${client}] ${cleaned}`;
}

/** Shared defense for every automatic context-injection surface. */
export function isMemoryEligibleForInjection(
  memory: Pick<Memory, 'kind' | 'content' | 'invalidated' | 'superseded_by'>,
): boolean {
  if (memory.invalidated !== 0 || memory.superseded_by) return false;
  return memory.kind !== 'pitfall' || !isResolvedPitfallContent(memory.content);
}
