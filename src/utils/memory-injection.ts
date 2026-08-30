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
 * HOMOGLYPHS (e.g. a Cyrillic 'а') cannot be closed by string matching
 * — so POSITION closes them: a genuine label is always at offset 0,
 * minted here, and a LOCAL row's leading bracket (any bracket, any
 * spelling) is defanged, so nothing else can occupy that offset.
 * Zero-width splits are stripped in neutralizeMemoryText. The middle
 * dot in "[·…]" is the DEFANG marker, not a rendering bug — do not
 * "fix" it; Waykeep's own captured log prefixes ([cairn]) degrade to
 * [·cairn] by design.
 */
// Anchors cover every line-break form: a BARE \r returns the carriage
// in a terminal, so `ok\r[waykeep-team: …]` rendered at the visual line
// start (formatter review C1).
const LINE_LEADING_MARKERS = /(^|[\r\n])(?:\s*\[\s*(?:cairn|waykeep)\b[^\]\n]*\]\s*)+/gi;

// Inline brand-marker DEFANG (Codex m1s7 #3/#4): the apply sanitizer
// collapses newlines, turning line-leading attacks into inline ones, so
// inline occurrences are the reachable smuggling form — a middle dot
// breaks the exact-brand match while staying readable, and legitimate
// quoting degrades gracefully to "[·waykeep…]".
const INLINE_BRAND_MARKERS = /\[(\s*)(cairn|waykeep)\b/gi;

// Render-side identity escape (defense in depth behind the validator's
// token charset): whatever reaches the label slot cannot carry bracket,
// backslash, or line-break structure.
const escapeIdentity = (v: string): string => v.replace(/[^A-Za-z0-9._@-]/g, '_').slice(0, 128);

export function formatMemoryContent(
  memory: Pick<Memory, 'content'> & { author?: string | null; origin_client?: string },
): string {
  // Render-side defense-in-depth: the ingest neutralizer is
  // START-anchored, so a payload can smuggle a line-leading fake label
  // mid-content past it (newlines survive sanitization). Strip EVERY
  // line-leading [cairn…]/[waykeep…] marker at render — for local and
  // team rows alike — then mint the genuine label fresh.
  const cleaned = neutralizeMemoryText(memory.content)
    .replace(LINE_LEADING_MARKERS, '$1')
    .replace(INLINE_BRAND_MARKERS, '[\u00B7$1$2')
    .trim();
  if (memory.author === null || memory.author === undefined) {
    // OFFSET-0 is a real signal, not an aspiration (review N1): a local
    // row never opens with a bracket — ANY leading bracket defangs, so
    // a homoglyph label (Cyrillic а, future confusables, spellings
    // nobody enumerated) cannot occupy the one position a genuine label
    // owns. String matching cannot close homoglyphs; position can.
    return cleaned.startsWith('[') ? `[\u00B7${cleaned.slice(1)}` : cleaned;
  }
  const client = memory.origin_client ? ` via ${escapeIdentity(memory.origin_client)}` : '';
  // The label sits INSIDE the ingest neutralizer's protected class
  // ('waykeep' + word boundary): a payload arriving WITH this exact
  // prefix has it stripped at apply, so only this function mints it.
  return `[waykeep-team: ${escapeIdentity(memory.author)}${client}] ${cleaned}`;
}

/** Auxiliary render cleaning (Codex m1s7 delta): context.why /
 *  how_to_apply and tags are the same untrusted class as content — the
 *  apply fold turns line-leading markers inline there too — but they
 *  never carry the provenance label (the row's content line owns it).
 *  Same strip + defang, no minting. */
export function formatAuxText(text: string): string {
  return neutralizeMemoryText(text)
    .replace(LINE_LEADING_MARKERS, '$1')
    .replace(INLINE_BRAND_MARKERS, '[\u00B7$1$2')
    .trim();
}

/** Shared defense for every automatic context-injection surface. */
export function isMemoryEligibleForInjection(
  memory: Pick<Memory, 'kind' | 'content' | 'invalidated' | 'superseded_by'>,
): boolean {
  if (memory.invalidated !== 0 || memory.superseded_by) return false;
  return memory.kind !== 'pitfall' || !isResolvedPitfallContent(memory.content);
}
