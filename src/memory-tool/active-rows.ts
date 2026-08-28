/**
 * Raw exact-scope active-row queries (W4 corrective) — file EXISTENCE and
 * bulk mutations (delete, rename) must see every active row, including
 * rows whose domain mapping or validation fails. Deciding existence from
 * successfully-mapped records made corrupt-but-active rows invisible:
 * create treated the file as absent, delete and rename left them behind.
 */
import type Database from 'better-sqlite3';

export interface ActiveRow {
  id: string;
  kind: string;
}

/** Every active row for the given kinds in ONE exact scope, straight from
 *  SQL — no domain mapping, no validation, nothing dropped. */
export function activeRows(
  db: Database.Database,
  project: string | null,
  kinds: readonly string[],
): ActiveRow[] {
  const placeholders = kinds.map(() => '?').join(',');
  const scopeClause = project === null ? 'project IS NULL' : 'project = ?';
  const args: unknown[] = project === null ? [...kinds] : [...kinds, project];
  return db.prepare(`
    SELECT id, kind FROM memories
    WHERE kind IN (${placeholders}) AND ${scopeClause}
      AND invalidated = 0 AND superseded_by IS NULL
    ORDER BY id
  `).all(...args) as ActiveRow[];
}
