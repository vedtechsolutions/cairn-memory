import type Database from 'better-sqlite3';

import { SHAREABLE_KINDS } from 'waykeep-contract';

/**
 * Semantic-change journal (Phase 2 brief D3.1) — written by repository
 * code in the SAME transaction as the memory mutation it records, never
 * by a trigger (a trigger cannot distinguish an administrative rescope
 * from a semantic edit, and `moveProjectRows` must not journal — X9).
 *
 * Admission is deliberately ROW-LOCAL and frozen-protocol only: a
 * shareable kind in an exact non-null project. The journal is an intent
 * record for the (paid, out-of-process) sync worker and a local audit
 * trail — it is NEVER authorization to upload; the full eligibility
 * predicate (enrollment, privacy, config health, share_state policy)
 * runs worker-side at enqueue and transmit (D10).
 *
 * Retraction semantics decided here (per the slice-2 review's entry
 * criteria):
 *  - deleteById / invalidate / explicit bulk deletion (cleanup filters,
 *    forgetProject) journal `tombstone` ops — explicit local retractions
 *    must be able to travel.
 *  - Supersession journals an `upsert` op for the retired row (its
 *    superseded_by state changed); it is a semantic retirement WITH a
 *    successor and must never masquerade as an ordinary tombstone.
 *  - Promote (project → global) journals a `tombstone` under the OLD
 *    project: the row departed the only scope team sync can see.
 *  - Autonomous maintenance (TTL expiry, confidence decay, dead-tail and
 *    invalidated pruning) journals NOTHING and is barred from deleting
 *    sync-bound rows entirely — background hygiene never gains authority
 *    to retract team data (see the bound-row exclusions in decay.ts).
 *  - Replicated applications (the future sync-apply) pass `suppressed`
 *    so remote ops never echo back out (D13).
 */

export type JournalOp = 'upsert' | 'tombstone';

export interface JournalEntryInput {
  memoryId: string;
  project: string | null;
  kind: string;
  op: JournalOp;
  /** The row's revision at (or produced by) the mutation. */
  revision: number;
}

export interface JournalOptions {
  /** D13: set by replicated applications — remote ops never re-journal. */
  suppressed?: boolean;
}

export function isJournalAdmissible(kind: string, project: string | null): boolean {
  return project !== null && (SHAREABLE_KINDS as readonly string[]).includes(kind);
}

/** Record one semantic mutation. No-op for inadmissible rows and
 *  suppressed (replicated/administrative) mutations. Callers hold the
 *  enclosing transaction. */
export function journalMutation(db: Database.Database, entry: JournalEntryInput, opts?: JournalOptions): void {
  if (opts?.suppressed) return;
  if (!isJournalAdmissible(entry.kind, entry.project)) return;
  db.prepare(`
    INSERT INTO sync_journal (project, memory_id, op, row_revision, created_at)
    VALUES (?, ?, ?, ?, datetime('now'))
  `).run(entry.project, entry.memoryId, entry.op, entry.revision);
}

/** Current revision of a row (post-trigger reads after an UPDATE). */
export function currentRevision(db: Database.Database, id: string): number {
  const row = db.prepare('SELECT revision FROM memories WHERE id = ?').get(id) as { revision: number } | undefined;
  return row?.revision ?? 1;
}

/** Bulk helper: journal tombstones for every admissible row in `ids`,
 *  reading scope/kind/revision from the still-present rows. Call BEFORE
 *  the deleting statement, inside its transaction. */
export function journalTombstonesForIds(db: Database.Database, ids: readonly string[]): void {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => '?').join(',');
  const kindPlaceholders = SHAREABLE_KINDS.map(() => '?').join(',');
  db.prepare(`
    INSERT INTO sync_journal (project, memory_id, op, row_revision, created_at)
    SELECT project, id, 'tombstone', revision, datetime('now')
    FROM memories
    WHERE id IN (${placeholders}) AND project IS NOT NULL AND kind IN (${kindPlaceholders})
  `).run(...ids, ...SHAREABLE_KINDS);
}
