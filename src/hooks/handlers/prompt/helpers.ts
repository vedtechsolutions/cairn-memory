/**
 * Pure helper predicates and extractors for the prompt-check handler.
 * No DB or shared state — moved verbatim from prompt-handler.ts.
 */
import { existsSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { basename } from 'node:path';
import { TOOL, MCP_SERVER_NAME } from '../../../constants/mcp.js';

export function isSystemMessage(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.startsWith('<task-notification') || trimmed.startsWith('<system-reminder')
    || trimmed.startsWith('<system>') || trimmed.startsWith('<command-name>')
    || trimmed.startsWith('<command-message>')
    || trimmed.startsWith('<local-command-')
    // Relayed peer/teammate messages: the ENTIRE prompt is quoted third-party
    // content, never the user's own words — 6 of the 9 XML-shaped polluting
    // rows were this family (step-1 review F2).
    || trimmed.startsWith('<agent-message') || trimmed.startsWith('<teammate-message')) return true;
  if (trimmed.startsWith('This session is being continued from a previous conversation')) return true;
  if (trimmed.startsWith('Base directory for this skill:')) return true;
  return false;
}

import { isPastedShape, isRejectedSentence, splitSentences, stripPrependedContext } from '../../shared/capture-shapes.js';
import { CORRECTION_TRIGGER_PATTERNS } from '../../../utils/intent-classifier.js';

export function extractCorrectionLesson(prompt: string): string {
  prompt = stripPrependedContext(prompt);
  let lesson = prompt
    // 'no,' and 'stop' are detachable lead-ins; "don't" is INTEGRAL — the
    // old strip turned "Don't use Redis again" into "use Redis again",
    // inverting the lesson (pre-existing; exposed by the step-1 recheck).
    .replace(/^(no[,.]?\s*|stop[,.]?\s+)/i, '')
    .replace(/\s+/g, ' ')
    .trim();

  const taskInstructionPatterns = [
    /^(let'?s|i need to|i want to|we (need|should|have) to|can you|please|go back|i('m| am) going|proceed|go ahead|continue)/i,
    /^(based on|given that|considering|regarding|about the|for the|when you)/i,
    /^(so i|ok |yeah|hey |um |hmm|well |right |sure |i am back|lets do|lets go)/i,
    /\b(discuss|analyze|investigate|research|explore|review|check|look at|figure out)\b/i,
  ];
  if (taskInstructionPatterns.some(p => p.test(lesson))) return '';

  // Pasted-shape rejection: attribution envelopes and transcript glyphs are
  // never lessons, at any length — 5 such fragments reached the live store
  // as high-confidence corrections. Whole-text check, so an envelope in one
  // sentence cannot launder another.
  if (isPastedShape(lesson)) return '';

  // Short lessons keep the historical whole-capture semantics — unless an
  // IDE-context block is present, in which case sentence selection below
  // applies at any length (a short IDE prelude must not suppress a genuine
  // trailing correction — recheck finding).
  if (lesson.length <= 200 && !isRejectedSentence(lesson)) return lesson;

  // Long prompts: the old code stored the first 197 characters of the WHOLE
  // prompt, so the stored "lesson" was usually the opening of a paste with
  // the actual correction buried later or absent. Select the first sentence
  // that itself matches a CORRECTION TRIGGER — the same vocabulary that made
  // the classifier fire — so the stored lesson is the sentence that caused
  // the classification, never an unrelated one (an independent marker list
  // stored "The report only covers…" off a trailing "Don't use Redis again").
  for (const rawSentence of splitSentences(prompt)) {
    const sentence = rawSentence
      .replace(/^(no[,.]?\s*|stop\s+|don'?t\s+)/i, (m) => m) // triggers stay intact per sentence
      .replace(/\s+/g, ' ')
      .trim();
    if (sentence.length > 200) continue;
    const sLower = sentence.toLowerCase();
    if (!CORRECTION_TRIGGER_PATTERNS.some(p => p.test(sLower))) continue;
    if (isRejectedSentence(sentence)) continue;
    if (taskInstructionPatterns.some(p => p.test(sentence))) continue;
    return sentence;
  }
  return '';
}

/**
 * Matches a Waykeep tool call in raw transcript text — either the qualified
 * `mcp__<server>__` form or a quoted bare tool name. Built from the MCP
 * constants so a namespace change carries: a stale copy here would stop
 * recognizing calls and emit false "no explicit recall" nudges, with nothing
 * failing to signal it.
 */
const TOOL_CALL_PATTERN = new RegExp(
  `mcp__${MCP_SERVER_NAME}__|"(?:${[TOOL.RECALL, TOOL.PLAN, TOOL.LEARN, TOOL.EXPORT, TOOL.REMIND].join('|')})"`,
);

export function checkTranscriptForMemoryToolCalls(transcriptPath: string | null): boolean {
  try {
    if (!transcriptPath || !existsSync(transcriptPath)) return false;

    const fileSize = statSync(transcriptPath).size;
    const readSize = Math.min(fileSize, 64 * 1024);
    const offset = Math.max(0, fileSize - readSize);
    const buf = Buffer.alloc(readSize);
    const fd = openSync(transcriptPath, 'r');
    try {
      readSync(fd, buf, 0, readSize, offset);
    } finally {
      closeSync(fd);
    }
    const text = buf.toString('utf-8');
    return TOOL_CALL_PATTERN.test(text);
  } catch {
    return false;
  }
}

export function summarizeRecentActions(events: Array<{ tool: string; file?: string; success?: boolean; timestamp?: number }>): string | null {
  const writeOrEdit = events.filter(e => (e.tool === 'Write' || e.tool === 'Edit' || e.tool === 'apply_patch') && e.file);
  if (writeOrEdit.length === 0) return null;

  const lastAction = writeOrEdit[writeOrEdit.length - 1];
  const fileName = lastAction.file ? basename(lastAction.file) : 'unknown';

  const lastActionIdx = events.indexOf(lastAction);
  const bashAfterEdit = events.slice(lastActionIdx + 1).some(e => e.tool === 'Bash' && e.success);
  const successContext = bashAfterEdit ? ' (verified)' : '';

  return `User confirmed approach: ${lastAction.tool} on ${fileName}${successContext}`;
}

export function hasEntityTerms(prompt: string): boolean {
  const lower = prompt.toLowerCase();
  return /[\/\\.][\w]+/.test(prompt)
    || /\b\w+[(_]\w+/.test(prompt)
    || /\b(fix|implement|add|create|update|refactor|debug|test|deploy|migrate|build|configure)\b/.test(lower)
    || /\b(error|bug|issue|feature|api|database|schema|config|module|component|endpoint)\b/.test(lower);
}
