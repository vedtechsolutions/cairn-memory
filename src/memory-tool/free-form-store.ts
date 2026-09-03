/**
 * Free-form memory files (W4 v3.1 §6) — the `memory_files`-backed side of
 * the /memories tree: byte-capped documents with contract str_replace /
 * insert semantics. Each mutating operation is ONE immediate write
 * transaction — read, validation, cap arithmetic, and write together, so
 * no concurrent writer can slip between them. The schema-level 64KiB
 * CHECK is the last line of defense. Thrown messages carry no `Error: `
 * prefix (§9).
 */
import type Database from 'better-sqlite3';
import { ERR } from './errors.js';
import { FREE_FORM_LIMITS } from '../constants/memory-tool.js';
import { renderFileView } from './view-renderer.js';

export { FREE_FORM_LIMITS } from '../constants/memory-tool.js';

/** Escape LIKE wildcards for use with `ESCAPE '\'` — base64url project
 *  segments legitimately contain `_`, which LIKE treats as a wildcard. */
export const escapeLike = (s: string): string => s.replace(/[\\%_]/g, '\\$&');

export function readFreeForm(db: Database.Database, path: string): string | null {
  const row = db.prepare('SELECT content FROM memory_files WHERE path = ?').get(path) as { content: string } | undefined;
  return row?.content ?? null;
}

/** Cap checks + upsert. NOT transactional by itself — every caller wraps
 *  it (with any preceding reads) in one immediate transaction. */
function writeWithinTransaction(db: Database.Database, path: string, content: string): void {
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > FREE_FORM_LIMITS.FILE_BYTES) throw new Error(ERR.fileTooLarge());
  const existing = db.prepare(
    'SELECT length(CAST(content AS BLOB)) AS bytes FROM memory_files WHERE path = ?'
  ).get(path) as { bytes: number } | undefined;
  const stats = db.prepare(
    'SELECT COUNT(*) AS n, COALESCE(SUM(length(CAST(content AS BLOB))), 0) AS bytes FROM memory_files'
  ).get() as { n: number; bytes: number };
  if (!existing && stats.n >= FREE_FORM_LIMITS.MAX_FILES) throw new Error(ERR.storeFullFiles());
  // Overwrites replace the old bytes — count the delta, not the sum.
  // (256 × 64KiB equals the 16MiB aggregate exactly, so this check
  // binds only if the individual caps ever diverge from that ratio.)
  const prospective = stats.bytes - (existing?.bytes ?? 0) + bytes;
  if (prospective > FREE_FORM_LIMITS.AGGREGATE_BYTES) throw new Error(ERR.storeFullBytes());
  db.prepare(`
    INSERT INTO memory_files (path, content, created_at, updated_at)
    VALUES (?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(path) DO UPDATE SET content = excluded.content, updated_at = datetime('now')
  `).run(path, content);
}

/** Create or overwrite one file, enforcing every cap atomically. */
export function writeFreeForm(db: Database.Database, path: string, content: string): void {
  db.transaction(() => writeWithinTransaction(db, path, content)).immediate();
}

export function freeFormReplace(db: Database.Database, path: string, oldStr: string, newStr: string): string {
  let next = '';
  const run = db.transaction(() => {
    const content = readFreeForm(db, path);
    if (content === null) throw new Error(ERR.nonexistent(path));
    const first = content.indexOf(oldStr);
    if (first === -1) {
      throw new Error(ERR.oldStrNotFound(oldStr, path));
    }
    if (content.indexOf(oldStr, first + 1) !== -1) {
      const lineNumbers = content.split('\n')
        .map((line, i) => (line.includes(oldStr.split('\n')[0]) ? i + 1 : null)).filter(n => n !== null).join(', ');
      throw new Error(ERR.oldStrMultiple(oldStr, lineNumbers));
    }
    next = content.slice(0, first) + newStr + content.slice(first + oldStr.length);
    writeWithinTransaction(db, path, next);
  });
  run.immediate();
  return `The memory file has been edited.\n${renderFileView(path, next.split('\n'))}`;
}

export function freeFormInsert(db: Database.Database, path: string, insertLine: number, insertText: string): string {
  const run = db.transaction(() => {
    const content = readFreeForm(db, path);
    if (content === null) throw new Error(ERR.nonexistent(path));
    const lines = content.split('\n');
    if (!Number.isSafeInteger(insertLine) || insertLine < 0 || insertLine > lines.length) {
      throw new Error(ERR.invalidInsertLine(insertLine, lines.length));
    }
    lines.splice(insertLine, 0, insertText.replace(/\n$/, ''));
    writeWithinTransaction(db, path, lines.join('\n'));
  });
  run.immediate();
  return `The file ${path} has been edited.`;
}

export function freeFormRename(db: Database.Database, oldPath: string, newPath: string): string {
  const run = db.transaction(() => {
    const source = db.prepare('SELECT 1 FROM memory_files WHERE path = ?').get(oldPath);
    if (!source) throw new Error(ERR.nonexistent(oldPath));
    const dest = db.prepare('SELECT 1 FROM memory_files WHERE path = ?').get(newPath);
    if (dest) throw new Error(ERR.destinationExists(newPath));
    db.prepare("UPDATE memory_files SET path = ?, updated_at = datetime('now') WHERE path = ?").run(newPath, oldPath);
  });
  run.immediate();
  return `Successfully renamed ${oldPath} to ${newPath}`;
}

export function freeFormDelete(db: Database.Database, path: string): string {
  const result = db.prepare('DELETE FROM memory_files WHERE path = ?').run(path);
  if (result.changes === 0) throw new Error(ERR.nonexistent(path));
  return `Successfully deleted ${path}`;
}

/** Delete every file strictly under `dir` (no trailing slash). Wildcards
 *  in the directory name are matched literally. Returns the count. NOT
 *  transactional by itself — callers wrap it. */
export function freeFormDeleteUnder(db: Database.Database, dir: string): number {
  return db.prepare("DELETE FROM memory_files WHERE path LIKE ? ESCAPE '\\'")
    .run(`${escapeLike(dir)}/%`).changes;
}
