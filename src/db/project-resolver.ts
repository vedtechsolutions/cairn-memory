import type Database from 'better-sqlite3';

/**
 * Resolve a user/agent-typed `project` parameter from an MCP tool.
 *
 * Hooks always pass an already-resolved id (projectId(cwd)); the ambiguity only
 * arises when a human or another agent types a raw string. An already-shaped id
 * ("cairn-2f161aa3") passes through with zero DB cost. A bare name ("cairn") is
 * prefix-matched against the name segment of known ids and resolves ONLY when
 * exactly one match exists. Ambiguous or unknown names pass through unresolved
 * (fail closed): the query then legitimately returns nothing rather than
 * guessing and leaking another project's data.
 */

/** An id ends with a hyphen + 8 hex chars (the sha256 prefix). */
const FULL_ID_SHAPE = /-[0-9a-f]{8}$/;

export function resolveProjectParam(
  db: Database.Database,
  raw: string | null | undefined,
): string | null | undefined {
  // Preserve null vs undefined — callers rely on the distinction (null =
  // "global only", undefined = "all projects"). Only bare-name strings resolve.
  if (raw === null || raw === undefined) return raw;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (FULL_ID_SHAPE.test(trimmed)) return trimmed;

  // Bare name: match "<name>-<8 chars>" across the id-bearing tables an agent
  // would query. `_` is SQLite's single-char wildcard; escape any in the name.
  const escaped = trimmed.replace(/[\\%_]/g, '\\$&');
  const pattern = `${escaped}-________`;
  const rows = db.prepare(`
    SELECT project FROM memories WHERE project LIKE ? ESCAPE '\\'
    UNION SELECT project FROM plans WHERE project LIKE ? ESCAPE '\\'
    UNION SELECT project FROM sessions WHERE project LIKE ? ESCAPE '\\'
  `).all(pattern, pattern, pattern) as Array<{ project: string }>;
  return rows.length === 1 ? rows[0].project : trimmed;
}
