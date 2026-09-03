/**
 * A JSON object proper — not null, not an array. The shape guard every
 * "parse a JSON document, then read its fields" site needs before it may
 * touch a property; five inline spellings of it lived across the CLI, the
 * config loader, sync eligibility and the owner RPC (audit).
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
