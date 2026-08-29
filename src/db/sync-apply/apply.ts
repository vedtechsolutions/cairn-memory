import type Database from 'better-sqlite3';
import {
  type SyncEvent, type SyncUpsertEvent, type SyncTombstoneEvent,
  type SyncAliasEvent, type SyncConflictOpenEvent, type SyncResolveCommitEvent,
} from 'waykeep-contract';

import { generateId } from '../../utils/index.js';
import {
  getByEntityId, closeEntry, recordAlias, mergeContributors, contributorsOf,
  openConflictSet, resolveConflictSet, bumpGeneration, readGeneration, bindEntity,
} from './entity-map.js';
import { projectionHashOfRow } from './projection.js';
import { validateBatch, validatePayload } from './validator.js';
import { applyUpsert, insertProjectedRow, writeForkNotice, hasUnpushedLocalIntent, type InertProjection, type UpsertOutcome } from './upsert-apply.js';
import { ApplyValidationError, ProtocolInvariantError } from './errors.js';

/**
 * Free-core sync apply (brief D8 item 3; §6 M1 rows): every record is
 * untrusted — neutralize + scrub + shape validation run unconditionally
 * (via projection.ts, deliberately unlike restore); id-preserving,
 * version-guarded, tombstone-honoring, non-reinforcing. The whole batch
 * is ONE immediate transaction — apply + entity map + aliases +
 * conflicts + contributor projection + cursor + durable generation
 * commit together (D3) — and events within it apply in seq order.
 *
 * Core is enrollment-ignorant (D2/X27): the caller supplies the target
 * project binding — the paid worker supplies the enrolled binding, the
 * free bounded-restore path supplies its own local project.
 *
 * D13: applied ops are replicated mutations — no journal writes, no
 * outbound echo, received ids/versions preserved.
 */

export type EventOutcome = UpsertOutcome
  | 'tombstoned' | 'fork-preserved' | 'assoc-closed'
  | 'aliased' | 'conflict-opened' | 'resolved' | 'replay-noop';

export interface ApplyBatchResult {
  outcomes: Array<{ seq: number; type: string; outcome: EventOutcome }>;
  generation: number;
  cursor: number;
}

const CURSOR_NS = 'apply';

function readCursor(db: Database.Database, project: string): number {
  const row = db.prepare('SELECT v FROM sync_state WHERE ns = ? AND k = ?').get(CURSOR_NS, `cursor:${project}`) as { v: string } | undefined;
  return row ? Number(row.v) : 0;
}

function writeCursor(db: Database.Database, project: string, seq: number): void {
  db.prepare(`
    INSERT INTO sync_state (ns, k, v, updated_at) VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(ns, k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at
  `).run(CURSOR_NS, `cursor:${project}`, String(seq));
}

function tombstoneLocalRow(db: Database.Database, memoryId: string): void {
  db.prepare(`
    INSERT INTO memory_tombstones (memory_id, action, project, kind, content, deleted_at)
    SELECT id, 'delete', project, kind, content, datetime('now') FROM memories WHERE id = ?
  `).run(memoryId);
  db.prepare('DELETE FROM memories WHERE id = ?').run(memoryId);
}

function applyTombstone(db: Database.Database, targetProject: string, ev: SyncTombstoneEvent): EventOutcome {
  const entry = getByEntityId(db, ev.entity_id);
  if (!entry) return 'replay-noop';
  // Project boundary: a batch for project A must never touch project
  // B's rows — a cross-project tombstone previously deleted them
  // (slice-4 Codex gate #1).
  if (entry.project !== targetProject) {
    throw new ApplyValidationError(`tombstone for entity ${ev.entity_id} targets project '${entry.project}', not the caller's binding`);
  }
  // Version guard: a tombstone older than the bound version is stale
  // stream history, not a retraction of newer state (gate #5).
  if (ev.entity_version <= entry.canonical_version) return 'replay-noop';
  if (entry.state === 'shadow-assoc') {
    // S3: close the association only — the local row is untouched.
    closeEntry(db, ev.entity_id);
    return 'assoc-closed';
  }
  const localHash = projectionHashOfRow(db, entry.local_memory_id);
  if (localHash !== null && hasUnpushedLocalIntent(db, entry.local_memory_id, entry)) {
    // S9 fork-preserve: an unpushed local edit — including a pending
    // local retraction, which the projection cannot see (review C3) —
    // is never destroyed: close the binding and force the row local-only.
    db.prepare("UPDATE memories SET share_state = 'local' WHERE id = ?").run(entry.local_memory_id);
    writeForkNotice(db, entry.local_memory_id, { entity: ev.entity_id, path: 'S9', seq: ev.seq });
    closeEntry(db, ev.entity_id);
    return 'fork-preserved';
  }
  // S5: clean — the row vanishes, generation-proven to peers.
  tombstoneLocalRow(db, entry.local_memory_id);
  closeEntry(db, ev.entity_id);
  return 'tombstoned';
}

function applyAlias(db: Database.Database, project: string, ev: SyncAliasEvent): EventOutcome {
  const fromEntry = getByEntityId(db, ev.from_entity_id);
  if (fromEntry && ev.as_of_version < fromEntry.canonical_version) {
    // Stale alias: the local binding has already advanced past the
    // alias's basis version — stream history, never destructive work
    // (slice-4b Codex gate #3, mirroring the tombstone guard).
    return 'replay-noop';
  }
  recordAlias(db, ev.from_entity_id, ev.to_entity_id, ev.as_of_version, ev.seq);
  if (!fromEntry) return 'replay-noop';

  // Validate BEFORE deleting anything: the loser's row may be the only
  // local representation, and an absent or cross-project target must
  // fail the transaction, never erase it (slice-4 Codex gate #7).
  if (fromEntry.project !== project) {
    throw new ApplyValidationError(`alias source entity ${ev.from_entity_id} belongs to project '${fromEntry.project}', not the caller's binding`);
  }
  const toEntry = getByEntityId(db, ev.to_entity_id);
  if (!toEntry) {
    throw new ApplyValidationError(`alias target entity ${ev.to_entity_id} is unknown — stream order violation`);
  }
  if (toEntry.project !== project) {
    throw new ApplyValidationError(`alias target entity ${ev.to_entity_id} belongs to project '${toEntry.project}', not the caller's binding`);
  }
  if (toEntry.state === 'shadow-assoc' && !toEntry.inert_projection) {
    throw new ApplyValidationError(`alias target entity ${ev.to_entity_id} is shadowed without an inert projection — not materializable`);
  }

  // T6: tombstone L's row; if E is not materialized, materialize it
  // from the assoc's inert projection Π (X26); merge provenance.
  if (fromEntry.state === 'bound') tombstoneLocalRow(db, fromEntry.local_memory_id);
  closeEntry(db, ev.from_entity_id);
  if (toEntry.state === 'shadow-assoc' && toEntry.inert_projection) {
    // The assoc's local row is the opted-out row, NOT E's content: E
    // materializes as its OWN new row (team content must not vanish).
    const inert = JSON.parse(toEntry.inert_projection) as InertProjection;
    const newId = generateId();
    insertProjectedRow(db, newId, inert);
    closeEntry(db, ev.to_entity_id);
    bindEntity(db, {
      entityId: ev.to_entity_id, localMemoryId: newId, project,
      version: toEntry.canonical_version, canonicalHash: toEntry.canonical_hash,
      projectionHash: projectionHashOfRow(db, newId) ?? toEntry.projection_hash,
    });
    // The assoc's contributor snapshot C is part of E's provenance.
    if (toEntry.contributors) {
      mergeContributors(db, ev.to_entity_id, JSON.parse(toEntry.contributors) as string[], ev.seq);
    }
  }
  // Provenance lives in the sync_contributors projection — the map's
  // snapshot column is populated only for shadow-assocs (review C5).
  mergeContributors(db, ev.to_entity_id, contributorsOf(db, ev.from_entity_id), ev.seq);
  return 'aliased';
}

function applyConflictOpen(db: Database.Database, project: string, ev: SyncConflictOpenEvent): EventOutcome {
  // Every named member must be a known entity of the CALLER'S project
  // (slice-4b Codex gate #1): a project-A set naming project-B members
  // previously committed. Ordered streams deliver member upserts first,
  // so an unknown member is a stream-order violation, not a skip.
  for (const memberId of ev.member_entity_ids) {
    const member = getByEntityId(db, memberId);
    if (!member) throw new ApplyValidationError(`conflict-open ${ev.conflict_set_id}: member entity ${memberId} is unknown`);
    if (member.project !== project) {
      throw new ApplyValidationError(`conflict-open ${ev.conflict_set_id}: member entity ${memberId} belongs to project '${member.project}'`);
    }
  }
  openConflictSet(db, {
    conflictSetId: ev.conflict_set_id, project,
    memberEntityIds: ev.member_entity_ids, reason: ev.reason,
    openedBy: ev.opened_by, openedSeq: ev.seq,
  });
  return 'conflict-opened';
}

function applyResolveCommit(db: Database.Database, project: string, ev: SyncResolveCommitEvent): EventOutcome {
  const record = validatePayload(ev.canonical, project);
  // The named set must exist in the CALLER'S project, and the resolve's
  // tombstones must be members of exactly that set (slice-4b Codex gate
  // #1 — a project-A resolve previously mutated a project-B set).
  const set = db.prepare('SELECT project, member_entity_ids, status FROM sync_conflict_sets WHERE conflict_set_id = ?')
    .get(ev.conflict_set_id) as { project: string; member_entity_ids: string; status: string } | undefined;
  if (!set) throw new ApplyValidationError(`resolve-commit names unknown conflict set ${ev.conflict_set_id}`);
  if (set.project !== project) {
    throw new ApplyValidationError(`resolve-commit targets conflict set of project '${set.project}', not the caller's binding`);
  }
  const members = new Set(JSON.parse(set.member_entity_ids) as string[]);
  for (const t of ev.tombstoned_entity_ids) {
    if (!members.has(t)) throw new ApplyValidationError(`resolve-commit tombstones ${t}, which is not a member of set ${ev.conflict_set_id}`);
  }
  // D1 (frozen): within composed applications, TOMBSTONES BEFORE
  // UPSERTS. The reverse order let the canonical's exact-match see a
  // still-live member — minting a spurious near-dup set, or, when the
  // canonical carries a tombstoned member's hash (the ordinary "pick
  // one member" resolution), halting the project on T8a (review C1).
  for (const entityId of ev.tombstoned_entity_ids) {
    if (entityId === ev.canonical.entity_id) continue;
    // A resolve tombstone always supersedes the member's bound version.
    const member = getByEntityId(db, entityId);
    applyTombstone(db, project, {
      type: 'tombstone', seq: ev.seq, entity_id: entityId,
      entity_version: (member?.canonical_version ?? 0) + 1, deleted_by: '', deleted_at: '',
    });
  }
  applyUpsert(db, project, ev.canonical, record);
  mergeContributors(db, ev.canonical.entity_id, ev.contributors, ev.seq);
  resolveConflictSet(db, ev.conflict_set_id, ev.seq);
  return 'resolved';
}

/** Apply one ordered event batch for one project. Idempotent: events at
 *  or below the durable cursor are skipped; every handler is also
 *  individually replay-safe. A ProtocolInvariantError (T8a) or
 *  validation failure rolls the WHOLE batch back — nothing applies. */
export function applyEventBatch(db: Database.Database, targetProject: string, events: readonly SyncEvent[]): ApplyBatchResult {
  return db.transaction((): ApplyBatchResult => {
    const startCursor = readCursor(db, targetProject);
    let cursor = startCursor;
    const outcomes: ApplyBatchResult['outcomes'] = [];
    // Fail-closed validation of the WHOLE batch before any handler
    // runs: closed vocabulary, per-event runtime shape, bounds, unique
    // sequences (validator.ts). Nothing malformed advances the cursor.
    validateBatch(events);
    const changesBefore = (db.prepare('SELECT total_changes() n').get() as { n: number }).n;
    const ordered = [...events].sort((a, b) => a.seq - b.seq);
    for (const ev of ordered) {
      if (ev.seq <= startCursor) {
        outcomes.push({ seq: ev.seq, type: ev.type, outcome: 'replay-noop' });
        continue;
      }
      let outcome: EventOutcome;
      switch (ev.type) {
        case 'upsert': {
          const up = ev as SyncUpsertEvent;
          outcome = applyUpsert(db, targetProject, up.entity, validatePayload(up.entity, targetProject));
          break;
        }
        case 'tombstone': outcome = applyTombstone(db, targetProject, ev as SyncTombstoneEvent); break;
        case 'alias': outcome = applyAlias(db, targetProject, ev as SyncAliasEvent); break;
        case 'conflict-open': outcome = applyConflictOpen(db, targetProject, ev as SyncConflictOpenEvent); break;
        case 'resolve-commit': outcome = applyResolveCommit(db, targetProject, ev as SyncResolveCommitEvent); break;
      }
      outcomes.push({ seq: ev.seq, type: ev.type, outcome });
      cursor = Math.max(cursor, ev.seq);
    }
    // The generation invalidates every peer's memory-derived caches —
    // bump only when some event actually WROTE state, measured by the
    // connection's total_changes delta across the handlers (before the
    // cursor write). Outcome labels are not evidence: a lost-map replay
    // rebinds while reporting replay-noop, and peers must learn
    // (slice-4b Codex gate #4). Empty and byte-for-byte replay batches
    // write nothing and flush nothing.
    const wrote = (db.prepare('SELECT total_changes() n').get() as { n: number }).n > changesBefore;
    writeCursor(db, targetProject, cursor);
    const generation = wrote ? bumpGeneration(db) : readGeneration(db);
    return { outcomes, generation, cursor };
  }).immediate();
}

export { ApplyValidationError, ProtocolInvariantError };
