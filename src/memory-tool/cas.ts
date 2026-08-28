/**
 * Token resolution + revision CAS (W4 v3.1 §4/§5) — the checks that make
 * edits stateless-safe. MUST be called INSIDE the write transaction so no
 * write can land between check and apply. Old blocks are verified against
 * their CANONICAL rendered form (collision-extended prefix, exact lines):
 * a token alone never authorizes replacing content the model has not
 * actually seen. Thrown messages carry no `Error: ` prefix (§9).
 */
import type Database from 'better-sqlite3';
import type { Memory, MemoryRow } from '../db/memory-repository/types.js';
import { rowToMemory } from '../db/memory-repository/reads.js';
import type { BlockToken, ParsedBlock } from './block-parser.js';
import {
  assignTokenPrefixes, loadActiveRecords, partitionRenderable, renderBlock,
  type Log, type MaterializableCategory,
} from './materializer.js';
import { ERR } from './errors.js';
import { CATEGORY_KINDS } from './path-router.js';
import { KIND_CODES, CODE_KINDS } from './token-codes.js';

const tokenText = (t: BlockToken): string => `[${t.code}:${t.idPrefix}@${t.revision}]`;

export interface ResolvedRecord {
  record: Memory;
  token: BlockToken;
}

/** Collision-extended prefix per active record id in one file's scope —
 *  the SAME assignment the renderer uses, so every token this module
 *  emits or verifies matches what a view shows. */
export function canonicalPrefixes(
  db: Database.Database,
  project: string | null,
  category: MaterializableCategory,
  log: Log,
): Map<string, string | null> {
  const { records } = loadActiveRecords(db, project, category, log);
  const { valid } = partitionRenderable(records, log);
  return assignTokenPrefixes(valid);
}

/** CAS token for a record using the file's canonical (collision-extended)
 *  prefix — an 8-char slice of a colliding id would be ambiguous and
 *  therefore unusable in a follow-up edit. */
export function canonicalTokenFor(
  db: Database.Database,
  record: Memory,
  category: MaterializableCategory,
  project: string | null,
  log: Log,
): string {
  const prefix = canonicalPrefixes(db, project, category, log).get(record.id) ?? record.id;
  return `[${KIND_CODES[record.kind] ?? '???'}:${prefix}@${record.revision}]`;
}

/** Resolve a token to exactly one ACTIVE record in the given exact scope
 *  and CAS-check its revision. Errors (all fail-closed): unknown code /
 *  wrong kind for the file, no match, ambiguous prefix, stale revision. */
export function resolveAndCheck(
  db: Database.Database,
  token: BlockToken,
  project: string | null,
  path: string,
  allowedKinds: readonly string[],
): ResolvedRecord {
  const kind = CODE_KINDS[token.code];
  if (!kind || !allowedKinds.includes(kind)) {
    throw new Error(ERR.tokenWrongFile(tokenText(token), path));
  }
  const scopeClause = project === null ? 'project IS NULL' : 'project = ?';
  const args: unknown[] = project === null
    ? [`${token.idPrefix}%`, kind]
    : [`${token.idPrefix}%`, kind, project];
  const rows = db.prepare(`
    SELECT * FROM memories
    WHERE id LIKE ? AND kind = ? AND ${scopeClause}
      AND invalidated = 0 AND superseded_by IS NULL
    LIMIT 2
  `).all(...args) as MemoryRow[];

  if (rows.length === 0) {
    throw new Error(ERR.tokenNoMatch(tokenText(token), path));
  }
  if (rows.length > 1) {
    throw new Error(ERR.tokenAmbiguous(token.idPrefix, path));
  }
  const record = rowToMemory(rows[0]);
  if (record.revision !== token.revision) {
    throw new Error(ERR.tokenStale(tokenText(token), record.revision, path));
  }
  return { record, token };
}

/** Resolve ALL old_str blocks: CAS-check each, reject duplicate record
 *  identities, and require every block to equal its canonical rendered
 *  form verbatim. Returns resolutions keyed by canonical id prefix.
 *  MUST run inside the write transaction. */
export function verifyOldBlocks(
  db: Database.Database,
  oldBlocks: readonly ParsedBlock[],
  project: string | null,
  category: MaterializableCategory,
  path: string,
  log: Log,
): Map<string, ResolvedRecord> {
  const allowedKinds: readonly string[] = CATEGORY_KINDS[category];
  const prefixes = canonicalPrefixes(db, project, category, log);
  const resolved = new Map<string, ResolvedRecord>();
  const seenIds = new Set<string>();
  for (const block of oldBlocks) {
    const r = resolveAndCheck(db, block.token!, project, path, allowedKinds);
    if (seenIds.has(r.record.id)) {
      throw new Error(ERR.oldBlockDuplicate(tokenText(block.token!)));
    }
    seenIds.add(r.record.id);
    const canonicalPrefix = prefixes.get(r.record.id);
    const canonical = canonicalPrefix ? renderBlock(r.record, canonicalPrefix) : null;
    if (canonical === null || block.token!.idPrefix !== canonicalPrefix || block.raw.join('\n') !== canonical.join('\n')) {
      throw new Error(ERR.oldBlockNotCanonical(tokenText(block.token!), path));
    }
    resolved.set(canonicalPrefix, r);
  }
  return resolved;
}
