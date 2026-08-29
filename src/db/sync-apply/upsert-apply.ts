import type Database from 'better-sqlite3';
import type { SyncEntityEnvelope, PortableRecord } from 'waykeep-contract';

import { generateId } from '../../utils/index.js';
import {
  projectPayload, canonicalRowBytes, hashCanonical, canonicalHashOfRow, isLocallyRetracted,
  type ProjectionFields,
} from './projection.js';
import {
  getByEntityId, getByLocalMemoryId, bindEntity, writeShadowAssoc,
  mergeContributors, openConflictSet, deterministicConflictSetId,
} from './entity-map.js';
import { ProtocolInvariantError } from './errors.js';

/**
 * The upsert side of the §6 transition table — rows T1, T2, T3(minimal),
 * T4, T5, T8a, T8b. Every write happens inside the caller's batch
 * transaction; every path is replay-idempotent; nothing here journals
 * (replicated mutations, D13) or reinforces (no confidence boost, no
 * dedup-merge — replay must be byte-stable).
 */

export interface InertProjection {
  /** The projected (as-would-be-stored) record — P applied. */
  record: ProjectionFields;
  confidence: number;
  source: string;
  author: string;
  origin_client: string;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
}

export function buildInertProjection(env: SyncEntityEnvelope, record: PortableRecord): InertProjection {
  return {
    record: projectPayload(record),
    confidence: record.confidence,
    source: record.source,
    author: env.author,
    origin_client: env.origin_client,
    created_at: env.created_at,
    updated_at: env.updated_at,
    expires_at: record.expires_at,
  };
}

/** Insert a projected record as a local row, id-preserved. Direct SQL —
 *  never repo.create(): apply is non-reinforcing and never journals. */
export function insertProjectedRow(db: Database.Database, id: string, p: InertProjection): void {
  db.prepare(`
    INSERT INTO memories (id, content, kind, project, tags, confidence, source, origin_client, author,
                          created_at, updated_at, recall_count, invalidated, expires_at, context, anchor)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?)
  `).run(id, p.record.content, p.record.kind, p.record.project, JSON.stringify(p.record.tags),
    p.confidence, p.source, p.origin_client, p.author, p.created_at, p.updated_at,
    p.expires_at, p.record.context ? JSON.stringify(p.record.context) : null, p.record.anchor);
}

function storedHashes(env: SyncEntityEnvelope, projected: ProjectionFields): { ch: string; ph: string } {
  // S6/R22: ph is the hash of the EXACT stored bytes (the projection),
  // never of bytes that were not stored; ch is the server's canonical
  // identity hash, used only canonical-to-canonical.
  return { ch: env.canonical_content_hash, ph: hashCanonical(canonicalRowBytes(projected)) };
}

/** Durable fork marker (§6 "conflict notice", M1 form): without it a
 *  forked row is indistinguishable from a deliberate opt-out and M3's
 *  conflict inbox could never reconstruct what happened (review C9). */
export function writeForkNotice(db: Database.Database, memoryId: string, notice: { entity: string; path: 'T3' | 'S9'; seq: number }): void {
  db.prepare(`
    INSERT INTO sync_state (ns, k, v, updated_at) VALUES ('fork-notice', ?, ?, datetime('now'))
    ON CONFLICT(ns, k) DO NOTHING
  `).run(memoryId, JSON.stringify(notice));
}

export type UpsertOutcome =
  | 'applied-new'          // T1
  | 'applied-edit'         // T2
  | 'forked'               // T3 (M1-minimal mechanics)
  | 'shadow-assoc'         // T4
  | 'twin-inserted'        // T5
  | 'coexist-conflict'     // T8b
  | 'assoc-refreshed'      // S8 (refresh half)
  | 'replay-noop';

/** One exact-match check at apply (D2/R14). Precedence among matching
 *  rows: bound-to-another-entity > opted-out > unbound, stable
 *  lowest-id tie-break within a class. Returns the selected row. */
function selectExactMatch(
  db: Database.Database,
  project: string,
  projected: ProjectionFields,
  pHash: string,
): { id: string; share_state: string | null; boundTo?: ReturnType<typeof getByLocalMemoryId> } | undefined {
  const candidates = db.prepare(`
    SELECT id, share_state FROM memories
    WHERE project = ? AND kind = ? AND content = ? AND invalidated = 0 AND superseded_by IS NULL
    ORDER BY id
  `).all(project, projected.kind, projected.content) as Array<{ id: string; share_state: string | null }>;

  const classes: Array<Array<{ id: string; share_state: string | null; boundTo?: ReturnType<typeof getByLocalMemoryId> }>> = [[], [], []];
  for (const c of candidates) {
    if (canonicalHashOfRow(db, c.id) !== pHash) continue;
    const entry = getByLocalMemoryId(db, c.id);
    if (entry?.state === 'bound') { classes[0].push({ ...c, boundTo: entry }); continue; }
    // A row already carrying a shadow-assoc is EXCLUDED before the
    // opted-out class, not just from it: cardinality (X26) allows one
    // association per row, and selecting it for a second T4 would
    // destroy the first assoc's Π unmaterialized — the no-vanish
    // violation of review C4. The incoming entity falls through to T1
    // and coexists as its own row instead.
    if (entry) continue;
    if (c.share_state === 'local') classes[1].push(c);
    else classes[2].push(c);
  }
  return classes[0][0] ?? classes[1][0] ?? classes[2][0];
}

export function applyUpsert(db: Database.Database, project: string, env: SyncEntityEnvelope, record: PortableRecord): UpsertOutcome {
  const projected = projectPayload(record);
  const { ch, ph } = storedHashes(env, projected);
  const existing = getByEntityId(db, env.entity_id);

  if (existing) {
    if (env.entity_version <= existing.canonical_version) return 'replay-noop';
    if (existing.state === 'shadow-assoc') {
      // S8 (refresh half): still projection-equal ⇒ update the assoc in
      // place. The materializing half is the worker milestone.
      const localHash = canonicalHashOfRow(db, existing.local_memory_id);
      if (localHash === ph) {
        writeShadowAssoc(db, {
          entityId: env.entity_id, localMemoryId: existing.local_memory_id, project,
          version: env.entity_version, canonicalHash: ch, projectionHash: ph,
          inertProjection: JSON.stringify(buildInertProjection(env, record)),
          contributors: env.contributors,
        });
        return 'assoc-refreshed';
      }
      // Diverged remote edit of a shadowed row (S8 materializing half)
      // is out of M1 scope: leave the assoc at its version — the worker
      // milestone materializes. Deliberately no row write.
      return 'replay-noop';
    }
    // Bound: T2 (clean) or T3 (diverged).
    const localHash = canonicalHashOfRow(db, existing.local_memory_id);
    if (localHash !== existing.projection_hash || isLocallyRetracted(db, existing.local_memory_id)) {
      // T3 fork (M1-minimal): the incoming edit materializes as a NEW
      // row and takes the binding; the locally-edited row — including a
      // locally-RETRACTED one, which the projection hash cannot see
      // (review C3) — is unbound and forced 'local': the user's edit or
      // retraction is never destroyed.
      const forkId = generateId();
      insertProjectedRow(db, forkId, buildInertProjection(env, record));
      db.prepare("UPDATE memories SET share_state = 'local' WHERE id = ?").run(existing.local_memory_id);
      writeForkNotice(db, existing.local_memory_id, { entity: env.entity_id, path: 'T3', seq: env.entity_version });
      bindEntity(db, { entityId: env.entity_id, localMemoryId: forkId, project, version: env.entity_version, canonicalHash: ch, projectionHash: ph });
      mergeContributors(db, env.entity_id, env.contributors, env.entity_version);
      return 'forked';
    }
    db.prepare(`
      UPDATE memories SET content = ?, tags = ?, context = ?, anchor = ?, confidence = ?,
        embedding = NULL, embedding_model = NULL
      WHERE id = ?
    `).run(projected.content, JSON.stringify(projected.tags),
      projected.context ? JSON.stringify(projected.context) : null,
      projected.anchor, record.confidence, existing.local_memory_id);
    // The revision trigger just stamped the local clock; the SERVER
    // timestamp is authoritative for replicated state (D13 — review
    // C10). updated_at is not in the trigger's UPDATE OF list, so this
    // does not re-fire it. The old vector described the old content —
    // cleared above for the backfill worker to re-embed (review C6).
    db.prepare('UPDATE memories SET updated_at = ? WHERE id = ?').run(env.updated_at, existing.local_memory_id);
    bindEntity(db, { entityId: env.entity_id, localMemoryId: existing.local_memory_id, project, version: env.entity_version, canonicalHash: ch, projectionHash: ph });
    mergeContributors(db, env.entity_id, env.contributors, env.entity_version);
    return 'applied-edit';
  }

  const match = selectExactMatch(db, project, projected, ph);
  if (match?.boundTo) {
    // Bound to another entity F: identity classification is
    // canonical-to-canonical ONLY (D2).
    if (match.boundTo.canonical_hash === ch) {
      throw new ProtocolInvariantError(
        `two active canonicals share canonical hash (${env.entity_id}, ${match.boundTo.entity_id})`,
      );
    }
    // T8b: projection-equal, canonically distinct — coexist + client-
    // minted deterministic near-dup set.
    if (db.prepare('SELECT 1 FROM memories WHERE id = ?').get(record.id!) === undefined) {
      insertProjectedRow(db, record.id!, buildInertProjection(env, record));
    }
    bindEntity(db, { entityId: env.entity_id, localMemoryId: record.id!, project, version: env.entity_version, canonicalHash: ch, projectionHash: ph });
    mergeContributors(db, env.entity_id, env.contributors, env.entity_version);
    const members = [env.entity_id, match.boundTo.entity_id];
    openConflictSet(db, {
      conflictSetId: deterministicConflictSetId(members, 'near-duplicate'),
      project, memberEntityIds: members, reason: 'near-duplicate', openedBy: 'client', openedSeq: env.entity_version,
    });
    return 'coexist-conflict';
  }
  if (match && match.share_state === 'local') {
    // T4: shadow association — no memory-row write, no upload authority.
    writeShadowAssoc(db, {
      entityId: env.entity_id, localMemoryId: match.id, project,
      version: env.entity_version, canonicalHash: ch, projectionHash: ph,
      inertProjection: JSON.stringify(buildInertProjection(env, record)),
      contributors: env.contributors,
    });
    return 'shadow-assoc';
  }
  if (match) {
    // The matched unbound row IS the incoming row (replay after a lost
    // map entry): rebind — never a twin of itself.
    const isSelf = match.id === record.id;
    // T5: offline twin — insert incoming id-preserved; the temporary
    // content duplicate is legal and the later alias event resolves it.
    if (!isSelf && db.prepare('SELECT 1 FROM memories WHERE id = ?').get(record.id!) === undefined) {
      insertProjectedRow(db, record.id!, buildInertProjection(env, record));
    }
    // S6/R22: ph is the hash of the bytes actually stored — on a rebind
    // of a pre-existing row those may not be the incoming payload's
    // (review C8).
    bindEntity(db, { entityId: env.entity_id, localMemoryId: record.id!, project, version: env.entity_version, canonicalHash: ch, projectionHash: canonicalHashOfRow(db, record.id!) ?? ph });
    mergeContributors(db, env.entity_id, env.contributors, env.entity_version);
    return isSelf ? 'replay-noop' : 'twin-inserted';
  }

  // T1: genuinely new entity.
  if (db.prepare('SELECT 1 FROM memories WHERE id = ?').get(record.id!) !== undefined) {
    // Replay after a lost map (or an id collision): never silently
    // duplicate and never clobber — rebind to the existing row, with
    // the AS-STORED projection hash (S6/R22 — review C8).
    bindEntity(db, { entityId: env.entity_id, localMemoryId: record.id!, project, version: env.entity_version, canonicalHash: ch, projectionHash: canonicalHashOfRow(db, record.id!) ?? ph });
    mergeContributors(db, env.entity_id, env.contributors, env.entity_version);
    return 'replay-noop';
  }
  insertProjectedRow(db, record.id!, buildInertProjection(env, record));
  bindEntity(db, { entityId: env.entity_id, localMemoryId: record.id!, project, version: env.entity_version, canonicalHash: ch, projectionHash: ph });
  mergeContributors(db, env.entity_id, env.contributors, env.entity_version);
  return 'applied-new';
}
