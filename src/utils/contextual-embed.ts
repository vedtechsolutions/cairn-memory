/**
 * Contextual embedding text (roadmap W2 item 5) — the cheap, LLM-free
 * variant of contextual retrieval: instead of embedding raw content, embed
 * `[kind] content | why | how_to_apply | <fingerprint terms>` so the
 * vector carries the memory's structured context. Document-side only —
 * queries always embed raw.
 *
 * Note for benchmark A/Bs: LongMemEval corpora carry kind='fact' and no
 * context/fingerprints, so there this construction degenerates to a
 * uniform "[fact] " prefix — the benchmark measures prefix impact, not
 * structured-context enrichment (which only production memories exercise).
 */

export interface ContextualEmbedInput {
  kind: string;
  content: string;
  context?: { why?: string; how_to_apply?: string } | null;
  /** Flattened fingerprint terms (languages, frameworks, domains…). */
  fingerprintTerms?: readonly string[] | null;
}

/** Build the document-side embedding text. Empty and whitespace-only
 *  segments are omitted — a memory with no context and no fingerprint
 *  embeds as "[kind] content".
 *
 *  TODO(production wiring — gated on the offline eval): before any
 *  production use, define deterministic fingerprint flattening (field
 *  order, dedup, term ordering) and token-budget behavior — with content
 *  first and memories up to the 2000-char chunk bound, appended enrichment
 *  can be truncated away by the model's sequence limit. */
export function buildContextualEmbedText(input: ContextualEmbedInput): string {
  const segments = [`[${input.kind}] ${input.content}`];
  const why = input.context?.why?.trim();
  const how = input.context?.how_to_apply?.trim();
  if (why) segments.push(why);
  if (how) segments.push(how);
  const terms = (input.fingerprintTerms ?? []).map(t => t.trim()).filter(t => t.length > 0);
  if (terms.length > 0) segments.push(terms.join(' '));
  return segments.join(' | ');
}
