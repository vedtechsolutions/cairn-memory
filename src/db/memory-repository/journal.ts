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
 * Retraction semantics (slice-2 entry criteria + slice-3 review fold):
 *  - deleteById / invalidate / explicit bulk deletion (cleanup filters,
 *    forgetProject) journal `tombstone` ops — explicit local retractions
 *    must be able to travel.
 *  - Supersession journals a `tombstone` for the retired row carrying
 *    `cause: 'superseded-by:<successor>'`. The portable payload has no
 *    supersession fields, so the earlier upsert decision canonicalized
 *    to unchanged bytes — a no-op on the wire (slice-3 review). The
 *    cause marker keeps it distinct from an ordinary tombstone; the
 *    worker maps it to the closed wire vocabulary (tombstone + the
 *    successor's own upsert, which journals independently).
 *  - Promote (project → global) journals a `tombstone` under the OLD
 *    project: the row departed the only scope team sync can see. The
 *    Memory Tool's materialized rename is the same class of USER scope
 *    move: tombstone under the old scope + upsert under the new one.
 *  - Memory Tool (VFS) writes are explicit user actions: deletions
 *    retire through the shared helpers below; a record edit journals
 *    ONE upsert at the transaction's final revision (a mixed
 *    content+metadata edit must not journal an intermediate revision).
 *  - Explicit trust changes (cairn_strengthen / cairn_weaken) journal
 *    upserts — confidence is a portable field; a terminal weaken is a
 *    retraction (tombstone log + journal tombstone). AUTONOMOUS trust
 *    churn (precision loop, error-learning) journals nothing, and its
 *    terminal invalidation is barred for sync-bound rows.
 *  - Autonomous hygiene (TTL expiry, confidence decay, dead-tail and
 *    invalidated pruning) journals NOTHING and is barred from deleting
 *    sync-BOUND rows (state='bound' — a shadow-assoc row is purely
 *    local and prunes normally; see decay.ts). Consolidation and
 *    auto-promotion are NOT hygiene — they are semantic compression and
 *    scope moves — so they are barred from bound rows entirely and
 *    journal their effects on unbound shareable rows.
 *  - Anchor repair (git-rename tracking) mutates LOCALLY and journals
 *    nothing: rename detection is local-git-driven — possibly an
 *    uncommitted rename — so pushing it teamwide would be premature.
 *    The corrected anchor rides the row's next semantic upsert.
 *  - Consolidation-member tombstones deliberately carry NO cause: the
 *    member is a genuine local retraction of an unbound row (never on
 *    the wire), unlike supersession, whose successor identity the
 *    worker must map.
 *  - Replicated applications (the future sync-apply) pass `suppressed`
 *    so remote ops never echo back out (D13).
 *
 * Revision identity rule (worker contract): a `tombstone` entry's
 * `row_revision` is the LAST SHAREABLE revision — read before the
 * mutation. For survivors (invalidate, promote, supersession) the
 * revision trigger bumps the live row afterwards, and administrative
 * rescopes bump revisions without journaling, so `row_revision` is
 * identity-at-journal-time only and must NEVER be compared to the live
 * row. Note for the M3 worker: a dedup merge that changes only
 * confidence journals an upsert whose content bytes are unchanged —
 * canonicalize/dedup at enqueue or the outbox carries confidence-ratchet
 * pushes.
 */

export type JournalOp = 'upsert' | 'tombstone';

/** Cause marker prefix for supersession tombstones: `superseded-by:<id>`. */
export const JOURNAL_CAUSE_SUPERSEDED_PREFIX = 'superseded-by:';

export interface JournalEntryInput {
  memoryId: string;
  project: string | null;
  kind: string;
  op: JournalOp;
  /** The row's revision at (or produced by) the mutation. */
  revision: number;
  /** Local-only marker distinguishing special retirements for the worker
   *  (e.g. `superseded-by:<id>`). Never a wire field. */
  cause?: string;
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
    INSERT INTO sync_journal (project, memory_id, op, row_revision, cause, created_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
  `).run(entry.project, entry.memoryId, entry.op, entry.revision, entry.cause ?? null);
}

/** Current revision of a row (post-trigger reads after an UPDATE). */
export function currentRevision(db: Database.Database, id: string): number {
  const row = db.prepare('SELECT revision FROM memories WHERE id = ?').get(id) as { revision: number } | undefined;
  return row?.revision ?? 1;
}

/** Whether a row is sync-BOUND (has upload authority / team presence).
 *  A shadow-assoc entry does not count: it is purely local (§6 T4). */
export function isRowSyncBound(db: Database.Database, id: string): boolean {
  return db.prepare(
    "SELECT 1 FROM sync_entity_map WHERE local_memory_id = ? AND state = 'bound'",
  ).get(id) !== undefined;
}

/** The subset of `ids` that are sync-bound. For autonomous semantic
 *  operations (consolidation, auto-promotion) that must never touch
 *  team-visible rows. */
export function syncBoundIds(db: Database.Database, ids: readonly string[]): Set<string> {
  if (ids.length === 0) return new Set();
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT local_memory_id FROM sync_entity_map WHERE state = 'bound' AND local_memory_id IN (${placeholders})`,
  ).all(...ids) as Array<{ local_memory_id: string }>;
  return new Set(rows.map((r) => r.local_memory_id));
}

/** Bulk helper: journal tombstones for every admissible row in `ids`,
 *  reading scope/kind/revision from the still-present rows. Call BEFORE
 *  the retiring statement, inside its transaction. */
export function journalTombstonesForIds(db: Database.Database, ids: readonly string[], opts?: JournalOptions): void {
  if (opts?.suppressed || ids.length === 0) return;
  const placeholders = ids.map(() => '?').join(',');
  const kindPlaceholders = SHAREABLE_KINDS.map(() => '?').join(',');
  db.prepare(`
    INSERT INTO sync_journal (project, memory_id, op, row_revision, created_at)
    SELECT project, id, 'tombstone', revision, datetime('now')
    FROM memories
    WHERE id IN (${placeholders}) AND project IS NOT NULL AND kind IN (${kindPlaceholders})
  `).run(...ids, ...SHAREABLE_KINDS);
}

/** Bulk helper: journal upserts for every admissible row in `ids` at the
 *  row's CURRENT revision. Call AFTER the mutation, inside its
 *  transaction. */
export function journalUpsertsForIds(db: Database.Database, ids: readonly string[], opts?: JournalOptions): void {
  if (opts?.suppressed || ids.length === 0) return;
  const placeholders = ids.map(() => '?').join(',');
  const kindPlaceholders = SHAREABLE_KINDS.map(() => '?').join(',');
  db.prepare(`
    INSERT INTO sync_journal (project, memory_id, op, row_revision, created_at)
    SELECT project, id, 'upsert', revision, datetime('now')
    FROM memories
    WHERE id IN (${placeholders}) AND project IS NOT NULL AND kind IN (${kindPlaceholders})
  `).run(...ids, ...SHAREABLE_KINDS);
}

/** Single-row convenience over journalUpsertsForIds. */
export function journalUpsertForId(db: Database.Database, id: string, opts?: JournalOptions): void {
  journalUpsertsForIds(db, [id], opts);
}

/** Shared retirement discipline for bulk invalidation (Memory Tool
 *  deletions, consolidation members): tombstone-log EVERY row (audit),
 *  journal admissible ones, then invalidate — one transaction (nests as
 *  a savepoint under a caller's). Returns rows invalidated. */
export function retireIdsByInvalidation(db: Database.Database, ids: readonly string[], opts?: JournalOptions): number {
  if (ids.length === 0) return 0;
  const placeholders = ids.map(() => '?').join(',');
  return db.transaction(() => {
    db.prepare(`
      INSERT INTO memory_tombstones (memory_id, action, project, kind, content, deleted_at)
      SELECT id, 'invalidate', project, kind, content, datetime('now')
      FROM memories WHERE id IN (${placeholders}) AND kind != 'rule'
    `).run(...ids);
    journalTombstonesForIds(db, ids, opts);
    return db.prepare(
      `UPDATE memories SET invalidated = 1 WHERE id IN (${placeholders}) AND kind != 'rule'`,
    ).run(...ids).changes;
  })();
}
