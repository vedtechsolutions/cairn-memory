/**
 * How the memory-tool contract messages SPELL a limit. The values live in
 * src/constants/memory-tool.ts; these formatters stay beside the messages
 * that use them (errors.ts cannot import view-renderer's humanSize without
 * a cycle, which is why this module exists).
 */

/** Grouped thousands, locale pinned: an ambient locale would change contract-visible text. */
export const formatLimit = (n: number): string => n.toLocaleString('en-US');

/** '64KB', '16MB' — the contract's byte spelling. */
export function formatBytes(bytes: number): string {
  const MB = 1024 * 1024;
  return bytes >= MB ? `${bytes / MB}MB` : `${bytes / 1024}KB`;
}
