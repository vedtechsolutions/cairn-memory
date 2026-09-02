// ============================================================================
// Memory-tool limits — a leaf module with no imports.
//
// These live apart from the code that enforces them because the CONTRACT ERROR
// MESSAGES also need them, and errors.ts cannot import from free-form-store.ts
// or view-renderer.ts: both of those import ERR from errors.ts, so the
// dependency would be a cycle. A leaf module lets every consumer share one
// definition and keeps the messages from drifting away from the enforcement.
// ============================================================================

export const FREE_FORM_LIMITS = {
  FILE_BYTES: 65_536,
  MAX_FILES: 256,
  AGGREGATE_BYTES: 16 * 1024 * 1024,
} as const;

/** Longest file the view renderer will number, and the widest single view. */
export const MAX_FILE_LINES = 999_999;
export const MAX_VIEW_CHARS = 16_000;

/**
 * Render a limit the way the contract messages spell it (grouped thousands).
 * The locale is pinned: an ambient locale would change contract-visible text.
 */
export const formatLimit = (n: number): string => n.toLocaleString('en-US');

/**
 * Render a byte limit the way the contract messages spell it: '64KB', '16MB'.
 * Deliberately not the humanSize() in view-renderer.ts — errors.ts cannot
 * import that without a cycle, which is why this module exists.
 */
export function formatBytes(bytes: number): string {
  const MB = 1024 * 1024;
  return bytes >= MB ? `${bytes / MB}MB` : `${bytes / 1024}KB`;
}
