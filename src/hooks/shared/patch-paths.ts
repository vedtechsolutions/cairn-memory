/**
 * apply_patch envelope parsing (parity D8) — header lines only, never
 * patch bodies. Codex's apply_patch tool_input is a patch blob in a
 * `command` field:
 *
 *   *** Begin Patch
 *   *** Update File: src/foo.ts
 *   ...
 *   *** End Patch
 *
 * Extracting the target paths lets the file-level feedback loop (pitfall
 * warnings, confidence boosts, edit counts) treat a Codex patch like a
 * Claude Write/Edit instead of an opaque blob.
 */

const PATCH_HEADER_RE = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm;

/** File paths named by a patch envelope's headers, deduped, order kept. */
export function extractPatchFilePaths(patchText: string): string[] {
  const paths: string[] = [];
  PATCH_HEADER_RE.lastIndex = 0;
  let match;
  while ((match = PATCH_HEADER_RE.exec(patchText)) !== null) {
    const path = match[1].trim();
    if (path && !paths.includes(path)) paths.push(path);
  }
  return paths;
}

/** The patch blob for an apply_patch tool_input, or null for other tools. */
export function patchTextOf(input: { tool_name: string; tool_input: Record<string, unknown> }): string | null {
  if (input.tool_name !== 'apply_patch') return null;
  const command = input.tool_input.command;
  return typeof command === 'string' ? command : null;
}
