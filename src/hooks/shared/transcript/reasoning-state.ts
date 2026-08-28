/**
 * Phase 5: Reasoning state extraction — hypotheses and open questions
 * mined from assistant text, with resolution detection.
 */

// Sentence-level patterns — matched against individual sentences extracted from
// multi-line assistant text. Capture group 1 gets the substantive clause.
const HYPOTHESIS_PATTERNS = [
  /\bi (?:think|suspect|believe) ((?:that )?[^.;!?]{10,})/i,
  /\bthis (?:might|could|may) be (?:because|due to|caused by) ([^.;!?]{10,})/i,
  /\bmy (?:guess|hypothesis|theory) is (?:that )?([^.;!?]{10,})/i,
  /\bit (?:looks|seems|appears) (?:like|as if|as though) ([^.;!?]{10,})/i,
  /\bprobably (?:because|due to|caused by|related to) ([^.;!?]{10,})/i,
];

const OPEN_QUESTION_PATTERNS = [
  /\b(?:need to|should|must|have to) (?:check|verify|confirm|test|investigate|figure out|determine) ([^.;!?]{10,})/i,
  /\bnot (?:sure|certain|clear) (?:why|whether|if|how|what) ([^.;!?]{10,})/i,
  /\b(?:unclear|unknown) (?:why|whether|if|how|what) ([^.;!?]{10,})/i,
  /\bquestion (?:is|remains) (?:whether )?([^.;!?]{10,})/i,
  /\bstill (?:need to|trying to) (?:understand|figure out|determine) ([^.;!?]{10,})/i,
];

// Resolution indicators — when these appear in later text with overlapping keywords,
// the corresponding hypothesis/question is considered resolved
const RESOLUTION_PATTERNS = [
  /\b(?:confirmed|verified|found that) /i,
  /\bthe (?:issue|problem|bug|cause) was /i,
  /\b(?:this (?:works|worked|fixed)|successfully|resolved|that was (?:correct|right)) /i,
  /\b(?:turns out|it was|root cause|the fix (?:is|was)) /i,
];

/** Detect meta-reasoning: assistant discussing code, regex, tests, or quoting text.
 *  These sentences contain hypothesis-like patterns but aren't real hypotheses —
 *  e.g., "the test says 'I think the bug is in the RRF scoring'" matches
 *  HYPOTHESIS_PATTERNS on the quoted part. */
function isMetaReasoning(sentence: string): boolean {
  // Backticks = code discussion
  if (sentence.includes('`')) return true;
  // Regex syntax (escaped chars, non-capturing groups, pattern delimiters)
  if (/\\[bBdDwWsS]|\(\?[:<!=]|\/[gimsuy]+\b/.test(sentence)) return true;
  // Quoted substantial text — quoting, not hypothesizing
  if (/[""][^""]{10,}[""]/.test(sentence)) return true;
  // Discussing patterns, regex, or test cases (meta-context)
  if (/\b(pattern|regex|regexp|test case|test text|match(?:es|ing)?(?:\s+the)?(?:\s+pattern))\b/i.test(sentence)) return true;
  return false;
}

/** Split text into sentences, handling multi-line assistant text.
 *  Joins lines before splitting on sentence boundaries. */
function extractSentences(text: string): string[] {
  // Normalize: join lines, collapse whitespace, then split on sentence boundaries
  const normalized = text.replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim();
  // Split on sentence-ending punctuation followed by space or end
  const raw = normalized.split(/(?<=[.!?])\s+/);
  return raw.filter(s => s.length >= 15);
}

/** Extract significant keywords from text for resolution matching */
function extractKeywords(text: string): Set<string> {
  const stopwords = new Set(['the', 'is', 'in', 'to', 'for', 'and', 'or', 'a', 'an', 'that', 'this', 'it', 'of', 'be', 'not', 'was', 'are', 'has', 'have', 'had', 'but', 'with', 'from', 'we', 'need', 'should', 'would', 'could', 'may', 'might', 'if', 'how', 'why', 'what', 'whether', 'been', 'being', 'will', 'can']);
  return new Set(
    text.toLowerCase().split(/\W+/).filter(w => w.length >= 3 && !stopwords.has(w))
  );
}

/** Check if a later text resolves an earlier hypothesis/question.
 *  Requires: a resolution indicator pattern + at least 2 overlapping keywords. */
function isResolved(item: string, laterTexts: string[]): boolean {
  const itemKeywords = extractKeywords(item);
  if (itemKeywords.size === 0) return false;

  for (const text of laterTexts) {
    const hasResolutionLang = RESOLUTION_PATTERNS.some(p => p.test(text));
    if (!hasResolutionLang) continue;
    const textKeywords = extractKeywords(text);
    let overlap = 0;
    for (const kw of itemKeywords) {
      if (textKeywords.has(kw)) overlap++;
    }
    if (overlap >= 2) return true;
  }
  return false;
}

/** Extract hypotheses and open questions from assistant text blocks.
 *  Uses sentence-level extraction with resolution detection — items resolved
 *  in later assistant texts are excluded from the output. */
export function extractReasoningState(
  assistantTexts: string[],
): { hypotheses: string[]; openQuestions: string[] } {
  const rawHypotheses: Array<{ text: string; index: number }> = [];
  const rawQuestions: Array<{ text: string; index: number }> = [];
  const seenHyp = new Set<string>();
  const seenQ = new Set<string>();

  for (let i = 0; i < assistantTexts.length; i++) {
    const sentences = extractSentences(assistantTexts[i]);
    for (const sentence of sentences) {
      // Skip meta-reasoning: code discussion, regex analysis, quoted test text
      if (isMetaReasoning(sentence)) continue;
      for (const pat of HYPOTHESIS_PATTERNS) {
        const match = sentence.match(pat);
        if (match) {
          const hyp = match[1].trim().slice(0, 150);
          const key = hyp.toLowerCase().slice(0, 50);
          if (!seenHyp.has(key)) {
            seenHyp.add(key);
            rawHypotheses.push({ text: hyp, index: i });
          }
        }
      }
      for (const pat of OPEN_QUESTION_PATTERNS) {
        const match = sentence.match(pat);
        if (match) {
          const q = match[1].trim().slice(0, 150);
          const key = q.toLowerCase().slice(0, 50);
          if (!seenQ.has(key)) {
            seenQ.add(key);
            rawQuestions.push({ text: q, index: i });
          }
        }
      }
    }
  }

  // Resolution filtering: check if later assistant texts resolve earlier items
  const hypotheses = rawHypotheses
    .filter(h => !isResolved(h.text, assistantTexts.slice(h.index + 1)))
    .map(h => h.text)
    .slice(0, 3);

  const openQuestions = rawQuestions
    .filter(q => !isResolved(q.text, assistantTexts.slice(q.index + 1)))
    .map(q => q.text)
    .slice(0, 3);

  return { hypotheses, openQuestions };
}
