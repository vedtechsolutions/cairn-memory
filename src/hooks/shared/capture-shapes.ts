/**
 * Shared shapes and sentence utilities for every auto-capture write path
 * (remediation plan, step 1).
 *
 * Three extractors persist memory rows from free text — user decisions
 * (`prompt/extractors.ts`), user corrections (`prompt/helpers.ts`), and
 * assistant decisions (`transcript/decision-extraction.ts`). All three
 * previously stored a 197-char PREFIX of the whole text, which put 88
 * unrelated fragments in the live store. They now share one definition of
 * "pasted, not authored" and one sentence splitter, so the gate cannot drift
 * per path again.
 */

/**
 * Provenance/attribution envelopes and transcript glyphs. Text carrying any
 * of these ANYWHERE is pasted material — an IDE injection, a tool result, a
 * relayed message — never an authored decision or lesson. Checked against
 * the WHOLE text: review showed an attribution tag in sentence 1 laundering
 * a clean-looking sentence 2 (`<agent-message from="reviewer">External
 * report. We'll use SQLite because…`).
 *
 * Deliberately NOT a generic XML match: bare tags like `<placeholders>` or
 * `<Button>` are ordinary technical prose (a live decision row was lost to
 * exactly that false positive). What marks an envelope is a KNOWN provenance
 * tag name, or any tag carrying an attribute.
 */
export const ATTRIBUTION_SHAPES: readonly RegExp[] = [
  // NOTE: <ide_opened_file> is deliberately NOT here. Claude Code PREPENDS
  // that block to genuine user messages, so whole-text rejection would
  // swallow every real decision typed after it. It lives in
  // SENTENCE_REJECT_SHAPES instead: the sentence carrying it is ineligible,
  // the user's own trailing sentences stay eligible.
  /<\/?(?:system-reminder|teammate-message|agent-message|command-name|command-message|command-args|tool_use|tool_result|local-command-stdout|task-notification|antml:[a-z]+)\b/i,
  /<[a-z][a-z0-9_-]*\s+[a-z_-]+\s*=/i, // any tag with an attribute: envelope, not prose
  // Exactly the glyphs observed in the polluting rows (● bullet, ⎿ elbow)
  // plus the box-drawing block transcripts use.
  /[●⎿─-╿]/,
];

/**
 * Shapes that disqualify only the SENTENCE that carries them: prepended
 * context blocks whose surrounding message is still the user's own.
 */
export const SENTENCE_REJECT_SHAPES: readonly RegExp[] = [
  /<\/?ide_opened_file\b/i,
];

/** True when this one sentence is ineligible even in an authored message. */
export function isRejectedSentence(sentence: string): boolean {
  return SENTENCE_REJECT_SHAPES.some(r => r.test(sentence));
}

/**
 * Remove well-formed prepended context blocks (Claude Code prepends
 * `<ide_opened_file>…</ide_opened_file>` to genuine user messages). What
 * remains is the user's own text and is processed normally at any length —
 * the tag and the trailing message often share one "sentence" (no punctuation
 * after the closing tag), so sentence selection alone cannot separate them.
 * Unclosed/leftover tags still fall to isRejectedSentence.
 */
export function stripPrependedContext(text: string): string {
  return text.replace(/<ide_opened_file\b[^>]*>[\s\S]*?<\/ide_opened_file>/gi, ' ').trim();
}

/** True when the text is pasted material that must never be captured. */
export function isPastedShape(text: string): boolean {
  return ATTRIBUTION_SHAPES.some(r => r.test(text));
}

/** Sentence boundaries good enough for capture selection. */
export function splitSentences(text: string): string[] {
  // Newlines are boundaries too: newline-delimited pastes otherwise fuse
  // into one over-cap "sentence" and legitimate decisions inside them are
  // lost outright (step-1 review F5).
  return text.split(/(?<=[.!?])\s+|\n+/).map(t => t.trim()).filter(Boolean);
}
