/**
 * Tokened-block update application (W4 v3.1 §5) — content changes go
 * through the repository's versioned update (history + confidence/source
 * stamping); why/how/tags consolidate into ONE statement because the v27
 * revision trigger fires per UPDATE, keeping one CAS bump per field edit.
 * MUST run inside the caller's write transaction.
 */
import type Database from 'better-sqlite3';
import { update as versionedContentUpdate } from '../db/memory-repository/writes.js';
import { journalUpsertForId } from '../db/memory-repository/journal.js';
import type { ParsedBlock } from './block-parser.js';
import { ERR } from './errors.js';

export function applyRecordUpdate(
  db: Database.Database,
  id: string,
  currentContent: string,
  block: ParsedBlock,
): void {
  // The inner content update's journal write is suppressed: a mixed
  // content+metadata edit is ONE semantic mutation and journals once,
  // below, at the transaction's final revision (journal.ts VFS
  // semantics) — never at the intermediate revision.
  const contentChanged = block.content !== currentContent;
  if (contentChanged && !versionedContentUpdate(db, id, block.content, { suppressed: true })) {
    throw new Error(ERR.updateFailed(id));
  }
  const metaChanged = block.why !== undefined || block.how !== undefined || block.tags !== undefined;
  if (!metaChanged) {
    if (contentChanged) journalUpsertForId(db, id);
    return;
  }
  const row = db.prepare('SELECT context, tags FROM memories WHERE id = ?').get(id) as { context: string | null; tags: string };
  const ctx = row.context ? JSON.parse(row.context) as { why?: string; how_to_apply?: string } : {};
  if (block.why !== undefined) { if (block.why === null) delete ctx.why; else ctx.why = block.why; }
  if (block.how !== undefined) { if (block.how === null) delete ctx.how_to_apply; else ctx.how_to_apply = block.how; }
  const context = (ctx.why || ctx.how_to_apply) ? JSON.stringify(ctx) : null;
  const tags = block.tags !== undefined ? JSON.stringify(block.tags) : row.tags;
  db.prepare('UPDATE memories SET context = ?, tags = ? WHERE id = ?').run(context, tags, id);
  journalUpsertForId(db, id);
}
