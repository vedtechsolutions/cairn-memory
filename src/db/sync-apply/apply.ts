import type Database from 'better-sqlite3';
import {
  SYNC_PROTOCOL_VERSION, CANONICALIZATION_VERSION, CONTENT_HASH_VERSION,
  isSyncEventType, validateRecordPayload, MEMORY_KINDS,
  type SyncEvent, type SyncUpsertEvent, type SyncTombstoneEvent,
  type SyncAliasEvent, type SyncConflictOpenEvent, type SyncResolveCommitEvent,
  type SyncEntityEnvelope, type PortableRecord,
} from 'waykeep-contract';

import { generateId } from '../../utils/index.js';
import {
  getByEntityId, closeEntry, recordAlias, mergeContributors,
  openConflictSet, resolveConflictSet, bumpGeneration, bindEntity,
} from './entity-map.js';
import { canonicalHashOfRow } from './projection.js';
import { applyUpsert, insertProjectedRow, type InertProjection, type UpsertOutcome } from './upsert-apply.js';
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

/** Inbound apply predicate (D2, enrollment-free): versions supported,
 *  shape valid, kind known, project matches the caller's binding. */
function validateEnvelope(env: SyncEntityEnvelope, targetProject: string): PortableRecord {
  if (env.canonicalization_version !== CANONICALIZATION_VERSION || env.hash_version !== CONTENT_HASH_VERSION) {
    throw new ApplyValidationError(`unsupported canonicalization/hash version (${env.canonicalization_version}/${env.hash_version})`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(env.payload);
  } catch {
    throw new ApplyValidationError(`entity ${env.entity_id}: payload is not valid JSON`);
  }
  const record = validateRecordPayload(parsed);
  if (!record.id) throw new ApplyValidationError(`entity ${env.entity_id}: payload record carries no id`);
  if (!(MEMORY_KINDS as readonly string[]).includes(record.kind)) {
    throw new ApplyValidationError(`entity ${env.entity_id}: unknown kind '${record.kind}'`);
  }
  if (record.kind === 'rule') throw new ApplyValidationError('rule memories never replicate');
  if (record.project !== targetProject) {
    throw new ApplyValidationError(`entity ${env.entity_id}: record project does not match the caller's target binding`);
  }
  return record;
}

function tombstoneLocalRow(db: Database.Database, memoryId: string): void {
  db.prepare(`
    INSERT INTO memory_tombstones (memory_id, action, project, kind, content, deleted_at)
    SELECT id, 'delete', project, kind, content, datetime('now') FROM memories WHERE id = ?
  `).run(memoryId);
  db.prepare('DELETE FROM memories WHERE id = ?').run(memoryId);
}

function applyTombstone(db: Database.Database, ev: SyncTombstoneEvent): EventOutcome {
  const entry = getByEntityId(db, ev.entity_id);
  if (!entry) return 'replay-noop';
  if (entry.state === 'shadow-assoc') {
    // S3: close the association only — the local row is untouched.
    closeEntry(db, ev.entity_id);
    return 'assoc-closed';
  }
  const localHash = canonicalHashOfRow(db, entry.local_memory_id);
  if (localHash !== null && localHash !== entry.projection_hash) {
    // S9 fork-preserve: an unpushed local edit is never destroyed —
    // close the binding and force the row local-only.
    db.prepare("UPDATE memories SET share_state = 'local' WHERE id = ?").run(entry.local_memory_id);
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
  recordAlias(db, ev.from_entity_id, ev.to_entity_id, ev.as_of_version, ev.seq);
  if (!fromEntry) return 'replay-noop';

  const toEntry = getByEntityId(db, ev.to_entity_id);
  // T6: tombstone L's row; if E is not materialized, materialize it
  // from an assoc's inert projection Π (X26); merge provenance.
  if (fromEntry.state === 'bound') tombstoneLocalRow(db, fromEntry.local_memory_id);
  closeEntry(db, ev.from_entity_id);
  if (toEntry?.state === 'shadow-assoc' && toEntry.inert_projection) {
    // The assoc's local row is the opted-out row, NOT E's content: E
    // materializes as its OWN new row (team content must not vanish).
    const inert = JSON.parse(toEntry.inert_projection) as InertProjection;
    const newId = generateId();
    insertProjectedRow(db, newId, inert);
    bindEntity(db, {
      entityId: ev.to_entity_id, localMemoryId: newId, project,
      version: toEntry.canonical_version, canonicalHash: toEntry.canonical_hash, projectionHash: toEntry.projection_hash,
    });
  }
  mergeContributors(db, ev.to_entity_id, fromEntry.contributors ? (JSON.parse(fromEntry.contributors) as string[]) : [], ev.seq);
  return 'aliased';
}

function applyConflictOpen(db: Database.Database, project: string, ev: SyncConflictOpenEvent): EventOutcome {
  openConflictSet(db, {
    conflictSetId: ev.conflict_set_id, project,
    memberEntityIds: ev.member_entity_ids, reason: ev.reason,
    openedBy: ev.opened_by, openedSeq: ev.seq,
  });
  return 'conflict-opened';
}

function applyResolveCommit(db: Database.Database, project: string, ev: SyncResolveCommitEvent): EventOutcome {
  const record = validateEnvelope(ev.canonical, project);
  applyUpsert(db, project, ev.canonical, record);
  for (const entityId of ev.tombstoned_entity_ids) {
    applyTombstone(db, { type: 'tombstone', seq: ev.seq, entity_id: entityId, entity_version: 0, deleted_by: '', deleted_at: '' });
  }
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
    const ordered = [...events].sort((a, b) => a.seq - b.seq);
    for (const ev of ordered) {
      if (!isSyncEventType(ev.type)) {
        // Closed vocabulary: an unknown event type is a protocol failure,
        // never a skip (contract header policy).
        throw new ApplyValidationError(`unknown event type '${(ev as { type: string }).type}' in the closed vocabulary`);
      }
      if (ev.seq <= startCursor) {
        outcomes.push({ seq: ev.seq, type: ev.type, outcome: 'replay-noop' });
        continue;
      }
      let outcome: EventOutcome;
      switch (ev.type) {
        case 'upsert': {
          const up = ev as SyncUpsertEvent;
          outcome = applyUpsert(db, targetProject, up.entity, validateEnvelope(up.entity, targetProject));
          break;
        }
        case 'tombstone': outcome = applyTombstone(db, ev as SyncTombstoneEvent); break;
        case 'alias': outcome = applyAlias(db, targetProject, ev as SyncAliasEvent); break;
        case 'conflict-open': outcome = applyConflictOpen(db, targetProject, ev as SyncConflictOpenEvent); break;
        case 'resolve-commit': outcome = applyResolveCommit(db, targetProject, ev as SyncResolveCommitEvent); break;
      }
      outcomes.push({ seq: ev.seq, type: ev.type, outcome });
      cursor = Math.max(cursor, ev.seq);
    }
    writeCursor(db, targetProject, cursor);
    const generation = bumpGeneration(db);
    return { outcomes, generation, cursor };
  }).immediate();
}

export { ApplyValidationError, ProtocolInvariantError, SYNC_PROTOCOL_VERSION };
