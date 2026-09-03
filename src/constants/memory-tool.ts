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

/** Rendering cache for materialized views. */
export const RENDER_CACHE = {
  MAX_ENTRIES: 8,
  TTL_MS: 5 * 60_000,
  MAX_AGGREGATE_BYTES: 4 * 1024 * 1024,
} as const;

/** More rows than this in one category is treated as corruption, not content. */
export const RECORD_SANITY_LIMIT = 10_000;

/** Shortest id prefix a CAS token may carry; the check and the message it
 *  throws must move together, so both read it from here. */
export const TOKEN_ID_PREFIX_MIN_CHARS = 8;
