/**
 * apply_patch envelope parsing (parity D8) — header lines only, never
 * patch bodies. Codex's apply_patch tool_input is a patch blob in a
 * `command` field:
 *
 *   *** Begin Patch
 *   *** Update File: src/foo.ts
 *   *** Move to: src/bar.ts
 *   ...
 *   *** End Patch
 *
 * Extracting the target paths lets the file-level feedback loop (pitfall
 * warnings, confidence boosts, edit counts) treat a Codex patch like a
 * Claude Write/Edit instead of an opaque blob. Body lines cannot spoof
 * headers: added content renders as `+*** Update File: …`, and the '+'
 * breaks the zero-column anchor.
 */
import { isAbsolute, resolve } from 'node:path';

/** Add/Update/Delete File targets plus Move-to rename destinations —
 *  the full header grammar of the installed Codex binary. */
const PATCH_HEADER_RE = /^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+)$/gm;

/**
 * File paths named by a patch envelope's headers, deduped, order kept.
 * Real Codex patches mix absolute and relative paths — a cwd normalizes
 * relatives so surfacedPitfalls/editCountsByFile keys can't split when one
 * file is patched under both forms (Claude's convention is absolute).
 */
export function extractPatchFilePaths(patchText: string, cwd?: string): string[] {
  const paths: string[] = [];
  PATCH_HEADER_RE.lastIndex = 0;
  let match;
  while ((match = PATCH_HEADER_RE.exec(patchText)) !== null) {
    // trim() also strips the '\r' of CRLF patches — Codex preserves line
    // endings (CODEX_APPLY_PATCH_PRESERVE_LINE_ENDINGS), so they are real.
    let path = match[1].trim();
    if (!path) continue;
    if (cwd && !isAbsolute(path)) path = resolve(cwd, path);
    if (!paths.includes(path)) paths.push(path);
  }
  return paths;
}

/** The patch blob for an apply_patch tool_input, or null for other tools. */
export function patchTextOf(input: { tool_name: string; tool_input: Record<string, unknown> }): string | null {
  if (input.tool_name !== 'apply_patch') return null;
  const command = input.tool_input.command;
  return typeof command === 'string' ? command : null;
}
