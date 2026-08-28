/**
 * Tool-input extraction helpers for the pitfall check.
 */
import type { PreToolUseInput } from '../../shared/hook-io.js';
import { extractPatchFilePaths, patchTextOf } from '../../shared/patch-paths.js';
import { PROACTIVE } from '../../../constants/index.js';

/** Extract file paths from tool_input — handles MultiEdit edits[] array
 *  and Codex apply_patch envelopes (D8). */
export function extractFilePaths(input: PreToolUseInput): string[] {
  const patchText = patchTextOf(input);
  if (patchText !== null) return extractPatchFilePaths(patchText, input.cwd);

  const paths: string[] = [];
  const fp = (input.tool_input.file_path ?? input.tool_input.path) as string | undefined;
  if (fp) paths.push(fp);

  if (input.tool_name === 'MultiEdit' && Array.isArray(input.tool_input.edits)) {
    for (const edit of input.tool_input.edits) {
      const editFp = (edit as Record<string, unknown>).file_path as string | undefined;
      if (editFp && !paths.includes(editFp)) paths.push(editFp);
    }
  }
  return paths;
}

/** Extract code content from tool_input for content-aware FTS matching */
export function extractCodeContent(input: PreToolUseInput): string | null {
  const maxChars = PROACTIVE.CONTENT_QUERY_MAX_CHARS;

  // apply_patch: the ADDED lines are the code content — the counterpart of
  // Edit's new_string. Envelope headers and context/removed lines are
  // boilerplate that would drown the FTS query.
  const patchText = patchTextOf(input);
  if (patchText !== null) {
    const added = patchText
      .split('\n')
      .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
      .map((l) => l.slice(1))
      .join(' ');
    return added.length > 0 ? added.slice(0, maxChars) : null;
  }

  if (input.tool_name === 'Edit') {
    const newStr = input.tool_input.new_string as string | undefined;
    return newStr ? newStr.slice(0, maxChars) : null;
  }

  if (input.tool_name === 'Write') {
    const content = input.tool_input.content as string | undefined;
    return content ? content.slice(0, maxChars) : null;
  }

  if (input.tool_name === 'MultiEdit' && Array.isArray(input.tool_input.edits)) {
    const parts: string[] = [];
    let total = 0;
    for (const edit of input.tool_input.edits) {
      const newStr = (edit as Record<string, unknown>).new_string as string | undefined;
      if (newStr && total < maxChars) {
        const chunk = newStr.slice(0, maxChars - total);
        parts.push(chunk);
        total += chunk.length;
      }
    }
    return parts.length > 0 ? parts.join(' ') : null;
  }

  return null;
}
