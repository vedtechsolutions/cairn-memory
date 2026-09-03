/**
 * Memory-tool limits — a LEAF module (no imports): the contract error
 * messages in src/memory-tool/errors.ts need these too, and that module
 * cannot import the store or the renderer without a cycle. One definition
 * keeps the messages from drifting away from the enforcement.
 */
export const FREE_FORM_LIMITS = {
  FILE_BYTES: 65_536,
  MAX_FILES: 256,
  AGGREGATE_BYTES: 16 * 1024 * 1024,
} as const;

/** Longest file the view renderer will number, and the widest single view. */
export const MAX_FILE_LINES = 999_999;
export const MAX_VIEW_CHARS = 16_000;
