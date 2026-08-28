/**
 * Pure helper predicates and extractors for the prompt-check handler.
 * No DB or shared state — moved verbatim from prompt-handler.ts.
 */
import { existsSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { basename } from 'node:path';

export function isSystemMessage(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.startsWith('<task-notification') || trimmed.startsWith('<system-reminder')
    || trimmed.startsWith('<system>') || trimmed.startsWith('<command-name>')
    || trimmed.startsWith('<command-message>')
    || trimmed.startsWith('<local-command-')) return true;
  if (trimmed.startsWith('This session is being continued from a previous conversation')) return true;
  if (trimmed.startsWith('Base directory for this skill:')) return true;
  return false;
}

export function extractCorrectionLesson(prompt: string): string {
  let lesson = prompt
    .replace(/^(no[,.]?\s*|stop\s+|don'?t\s+)/i, '')
    .replace(/\s+/g, ' ')
    .trim();

  const taskInstructionPatterns = [
    /^(let'?s|i need to|i want to|we (need|should|have) to|can you|please|go back|i('m| am) going)/i,
    /^(based on|given that|considering|regarding|about the|for the|when you)/i,
    /^(so i|ok |yeah|hey |um |hmm|well |right |sure |i am back|lets do|lets go)/i,
    /\b(discuss|analyze|investigate|research|explore|review|check|look at|figure out)\b/i,
  ];
  if (taskInstructionPatterns.some(p => p.test(lesson))) return '';

  if (lesson.length > 200) {
    lesson = lesson.slice(0, 197) + '...';
  }
  return lesson;
}

export function checkTranscriptForCairnCalls(transcriptPath: string): boolean {
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
    return /mcp__cairn__|"cairn_(recall|plan|learn|export|remind)"/.test(text);
  } catch {
    return false;
  }
}

export function summarizeRecentActions(events: Array<{ tool: string; file?: string; success?: boolean; timestamp?: number }>): string | null {
  const writeOrEdit = events.filter(e => (e.tool === 'Write' || e.tool === 'Edit') && e.file);
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
