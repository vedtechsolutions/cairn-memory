import type Database from 'better-sqlite3';

import { ApplyValidationError } from './errors.js';

/**
 * The CORE-OWNED half of the §7 journal-consumption handshake (brief
 * D3's ownership map: "classification/ack records and the consumption
 * cursor — the ack side of the X28 handshake is core-owned"). The paid
 * worker CALLS this; core OWNS the durability:
 *
 *  - classifications are written on the journal rows themselves
 *    (the v32 `classification` column: enqueued |
 *    permanently-ineligible | deferred-pending-eligibility);
 *  - the consumption cursor (sync_state ns 'journal', key
 *    'cursor:<project>') advances ONLY in the same transaction as the
 *    classifications it acknowledges — §7 J1: "consumption cursor
 *    advances only on durable classification";
 *  - the cursor is MONOTONIC: a regression is refused, never applied.
 *
 * Kill-safety: one immediate transaction covers every classification
 * write and the cursor advance — a crash leaves either the previous
 * cursor with unclassified rows (re-read from cursor, §7 J1 replay) or
 * the new cursor with every row classified. No intermediate state.
 */

export const JOURNAL_CLASSIFICATIONS = ['enqueued', 'permanently-ineligible', 'deferred-pending-eligibility'] as const;
export type JournalClassification = (typeof JOURNAL_CLASSIFICATIONS)[number];

const CURSOR_NS = 'journal';

export function journalConsumptionCursor(db: Database.Database, project: string): number {
  const row = db.prepare('SELECT v FROM sync_state WHERE ns = ? AND k = ?').get(CURSOR_NS, `cursor:${project}`) as { v: string } | undefined;
  return row ? Number(row.v) : 0;
}

export interface ClassificationItem {
  entryId: number;
  classification: JournalClassification;
}

/** Durably classify a batch of consumed journal entries and advance the
 *  cursor — atomically. Fail-closed validation: unknown classifications,
 *  entries outside (oldCursor, newCursor], a non-monotonic cursor, and
 *  unclassified gaps in the range are all refused whole. */
export function classifyAndAdvance(
  db: Database.Database,
  project: string,
  items: readonly ClassificationItem[],
  cursorTo: number,
): void {
  for (const item of items) {
    if (!Number.isSafeInteger(item.entryId) || item.entryId <= 0) {
      throw new ApplyValidationError(`entry id ${item.entryId} is not a positive integer`);
    }
    if (!(JOURNAL_CLASSIFICATIONS as readonly string[]).includes(item.classification)) {
      throw new ApplyValidationError(`unknown classification '${item.classification}'`);
    }
  }
  if (!Number.isSafeInteger(cursorTo) || cursorTo < 0) {
    throw new ApplyValidationError('cursor must be a non-negative integer');
  }
  db.transaction(() => {
    const from = journalConsumptionCursor(db, project);
    if (cursorTo < from) {
      throw new ApplyValidationError(`cursor regression refused: ${from} → ${cursorTo}`);
    }
    for (const item of items) {
      if (item.entryId <= from || item.entryId > cursorTo) {
        throw new ApplyValidationError(`entry ${item.entryId} lies outside the consumed range (${from}, ${cursorTo}]`);
      }
      const changed = db.prepare(
        'UPDATE sync_journal SET classification = ? WHERE entry_id = ? AND project = ?',
      ).run(item.classification, item.entryId, project).changes;
      if (changed !== 1) {
        throw new ApplyValidationError(`entry ${item.entryId} does not exist in project '${project}'`);
      }
    }
    // Every in-range entry for the project must now carry a durable
    // classification — a gap would advance the cursor past unconsumed
    // work, losing it forever (§7 J1).
    const gap = db.prepare(`
      SELECT entry_id FROM sync_journal
      WHERE project = ? AND entry_id > ? AND entry_id <= ? AND classification IS NULL
      LIMIT 1
    `).get(project, from, cursorTo) as { entry_id: number } | undefined;
    if (gap) {
      throw new ApplyValidationError(`entry ${gap.entry_id} in the consumed range has no classification — refusing the advance`);
    }
    db.prepare(`
      INSERT INTO sync_state (ns, k, v, updated_at) VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(ns, k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at
    `).run(CURSOR_NS, `cursor:${project}`, String(cursorTo));
  }).immediate();
}
