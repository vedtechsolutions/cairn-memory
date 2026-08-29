import type Database from 'better-sqlite3';
import type { SyncEntityEnvelope, PortableRecord } from 'waykeep-contract';

import { generateId } from '../../utils/index.js';
import {
  projectPayload, canonicalRowBytes, hashCanonical, projectionHashOfRow, isLocallyRetracted, isRowOptedOut, cleanDeep,
  type ProjectionFields,
} from './projection.js';
import { ApplyValidationError } from './errors.js';
import {
  getByEntityId, getByLocalMemoryId, bindEntity, writeShadowAssoc, closeEntry,
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
  fingerprint: Record<string, unknown> | null;
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
    fingerprint: record.fingerprint === null ? null : (cleanDeep(record.fingerprint) as Record<string, unknown>),
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
                          created_at, updated_at, recall_count, invalidated, expires_at, fingerprint, context, anchor)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?)
  `).run(id, p.record.content, p.record.kind, p.record.project, JSON.stringify(p.record.tags),
    p.confidence, p.source, p.origin_client, p.author, p.created_at, p.updated_at,
    p.expires_at, p.fingerprint ? JSON.stringify(p.fingerprint) : null,
    p.record.context ? JSON.stringify(p.record.context) : null, p.record.anchor);
}

/** "Unpushed local intent" — the dirty half of the clean/diverged
 *  partition (slice-4 gates, both reviewers; N1 fold). Projection
 *  equality alone is NOT intent equality: local retractions set flags
 *  outside the projection, and an explicit confidence change journals
 *  without changing projected bytes. Dirty ⟺ projection differs, OR the
 *  row is locally retracted, OR an UNCONSUMED journal entry exists for
 *  the row — §7 J1-pending (classification NULL) or J4-deferred: both
 *  are precisely "not yet pushed". A classified J2/J3 entry has a
 *  durable outcome and is no longer intent — the earlier timestamp
 *  fence could not express "already pushed" and false-forked every
 *  successful round-trip (review N1). Autonomous churn journals
 *  nothing, so it never false-forks. */
export function hasUnpushedLocalIntent(db: Database.Database, memoryId: string, entry: { projection_hash: string }): boolean {
  const localHash = projectionHashOfRow(db, memoryId);
  if (localHash !== entry.projection_hash) return true;
  if (isLocallyRetracted(db, memoryId)) return true;
  // §6 S4: opting a bound row out IS intent — its upload eligibility
  // ended, so remote edits fork (T3) and tombstones fork-preserve (S9).
  if (isRowOptedOut(db, memoryId)) return true;
  return db.prepare(`
    SELECT 1 FROM sync_journal
    WHERE memory_id = ? AND (classification IS NULL OR classification = 'deferred-pending-eligibility')
    LIMIT 1
  `).get(memoryId) !== undefined;
}

/** Erase-protection predicate (final-verification adjudication): distinct
 *  from the FORK predicate. Codex proved a byte-equal echo and a clean
 *  remote edit both ERASED pending local confidence changes; the Claude
 *  gate had ruled volatile overwrite "the field-set decision's
 *  consequence". Both stand: volatile fields are never FORK evidence,
 *  and pending volatile intent is never ERASED. J2-enqueued counts here
 *  — §7 J2 is prepared + core-acked, NOT server-acked — while for the
 *  fork decision it is consumed. Once the worker's push round-trips,
 *  the local value returns as canonical; preservation is self-healing. */
function hasPendingVolatileIntent(db: Database.Database, memoryId: string): boolean {
  return db.prepare(`
    SELECT 1 FROM sync_journal
    WHERE memory_id = ? AND (classification IS NULL OR classification IN ('deferred-pending-eligibility', 'enqueued'))
    LIMIT 1
  `).get(memoryId) !== undefined;
}

/** A pre-existing row may be reused for a binding ONLY when it provably
 *  is the same row: same project, same as-stored projection bytes. Any
 *  other coincidence of ids is a UUID collision and fails the batch
 *  closed (slice-4 Codex gate #2 — a cross-project same-id probe
 *  corrupted the map and the R22 hash). */
function assertRebindLegal(db: Database.Database, id: string, project: string, pHash: string): void {
  const row = db.prepare('SELECT project, invalidated, superseded_by FROM memories WHERE id = ?').get(id) as
    | { project: string | null; invalidated: number; superseded_by: string | null } | undefined;
  if (!row) return;
  if (row.project !== project || projectionHashOfRow(db, id) !== pHash) {
    throw new ApplyValidationError(`id ${id} exists with different project or bytes — refusing collision rebind`);
  }
  // ACTIVE state is part of the proof: binding an entity to a locally
  // invalidated/superseded row would map it to retrieval-invisible
  // bytes (slice-4b Codex gate #2).
  if (row.invalidated === 1 || row.superseded_by !== null) {
    throw new ApplyValidationError(`id ${id} exists but is retired locally — refusing rebind to invisible bytes`);
  }
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
    if (projectionHashOfRow(db, c.id) !== pHash) continue;
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
      const localHash = projectionHashOfRow(db, existing.local_memory_id);
      if (localHash === ph) {
        writeShadowAssoc(db, {
          entityId: env.entity_id, localMemoryId: existing.local_memory_id, project,
          version: env.entity_version, canonicalHash: ch, projectionHash: ph,
          inertProjection: JSON.stringify(buildInertProjection(env, record)),
          contributors: env.contributors,
        });
        return 'assoc-refreshed';
      }
      // S8 materializing half: the remote edit diverged from the local
      // row, so the edit must not stay invisible AND must not be
      // consumed unrepresentably (slice-4 Codex gate #6 — the previous
      // no-op advanced the cursor past an unrecoverable edit). Close
      // the assoc and materialize E from the NEW payload as its own
      // row (§6 S8).
      const s8Id = generateId();
      insertProjectedRow(db, s8Id, buildInertProjection(env, record));
      closeEntry(db, env.entity_id);
      bindEntity(db, {
        entityId: env.entity_id, localMemoryId: s8Id, project,
        version: env.entity_version, canonicalHash: ch,
        projectionHash: projectionHashOfRow(db, s8Id) ?? ph,
      });
      mergeContributors(db, env.entity_id, env.contributors, env.entity_version);
      return 'applied-edit';
    }
    // Bound: T2 (clean) or T3 (diverged — any unpushed local intent).
    // Convergent-echo rule (N1's second half): when the INCOMING
    // projected bytes equal the local row's current bytes, the event is
    // the row's own push echoing back (or an independently identical
    // edit) — applying it changes nothing user-visible, so it advances
    // the binding cleanly even while the push's journal entry is still
    // unconsumed. A pending RETRACTION still forks first: byte equality
    // cannot outrank an explicit local retraction.
    // The echo rule never applies to an opted-out row: an S4 row does
    // not push, so a byte-equal event is not its own echo — it forks
    // per T3 like any other remote edit onto it.
    const localPh = projectionHashOfRow(db, existing.local_memory_id);
    if (!isLocallyRetracted(db, existing.local_memory_id) && !isRowOptedOut(db, existing.local_memory_id) && localPh === ph) {
      // fall through to the clean T2 update below
    } else if (hasUnpushedLocalIntent(db, existing.local_memory_id, existing)) {
      // T3 fork (M1-minimal): the incoming edit materializes as a NEW
      // row and takes the binding; the locally-edited row — including a
      // locally-RETRACTED one, which the projection hash cannot see
      // (review C3) — is unbound and forced 'local': the user's edit or
      // retraction is never destroyed.
      const forkId = generateId();
      insertProjectedRow(db, forkId, buildInertProjection(env, record));
      db.prepare("UPDATE memories SET share_state = 'local' WHERE id = ?").run(existing.local_memory_id);
      writeForkNotice(db, existing.local_memory_id, { entity: env.entity_id, path: 'T3', seq: env.entity_version });
      // The old row keeps its binding row-side until closeEntry via the
      // ON CONFLICT rebind below; ph from the row as written (R22).
      bindEntity(db, { entityId: env.entity_id, localMemoryId: forkId, project, version: env.entity_version, canonicalHash: ch, projectionHash: projectionHashOfRow(db, forkId) ?? ph });
      mergeContributors(db, env.entity_id, env.contributors, env.entity_version);
      return 'forked';
    }
    // Every MUTABLE wire field applies — kind, source, fingerprint and
    // expires_at were previously left stale (slice-4 Codex gate #4).
    // Immutable: id, created_at, author (the creator). ERASE-PROTECTION:
    // when the row carries pending volatile intent (see
    // hasPendingVolatileIntent), the volatile fields keep their LOCAL
    // values — a delayed echo or clean remote edit must never roll back
    // an unacknowledged strengthen. The embedding clears only when the
    // content bytes actually changed (a byte-equal echo keeps its
    // still-valid vector).
    const inert = buildInertProjection(env, record);
    const preserveVolatile = hasPendingVolatileIntent(db, existing.local_memory_id);
    const bytesChanged = localPh !== ph;
    if (preserveVolatile) {
      db.prepare(`
        UPDATE memories SET content = ?, kind = ?, tags = ?, context = ?, anchor = ?
          ${bytesChanged ? ', embedding = NULL, embedding_model = NULL' : ''}
        WHERE id = ?
      `).run(projected.content, projected.kind, JSON.stringify(projected.tags),
        projected.context ? JSON.stringify(projected.context) : null,
        projected.anchor, existing.local_memory_id);
    } else {
      db.prepare(`
        UPDATE memories SET content = ?, kind = ?, tags = ?, context = ?, anchor = ?, confidence = ?,
          source = ?, fingerprint = ?, expires_at = ?
          ${bytesChanged ? ', embedding = NULL, embedding_model = NULL' : ''}
        WHERE id = ?
      `).run(projected.content, projected.kind, JSON.stringify(projected.tags),
        projected.context ? JSON.stringify(projected.context) : null,
        projected.anchor, record.confidence, record.source,
        inert.fingerprint ? JSON.stringify(inert.fingerprint) : null, record.expires_at,
        existing.local_memory_id);
    }
    // The revision trigger just stamped the local clock; the SERVER
    // timestamp is authoritative for replicated state (D13 — review
    // C10). updated_at is not in the trigger's UPDATE OF list, so this
    // does not re-fire it. The old vector described the old content —
    // cleared above for the backfill worker to re-embed (review C6).
    db.prepare('UPDATE memories SET updated_at = ? WHERE id = ?').run(env.updated_at, existing.local_memory_id);
    // R22: ph is recomputed from the row AS WRITTEN, never assumed from
    // the incoming projection (slice-4 Codex gate #3).
    bindEntity(db, {
      entityId: env.entity_id, localMemoryId: existing.local_memory_id, project,
      version: env.entity_version, canonicalHash: ch,
      projectionHash: projectionHashOfRow(db, existing.local_memory_id) ?? ph,
    });
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
    // minted deterministic near-dup set. Reusing an existing row id
    // requires proof it IS this row (collision guard).
    assertRebindLegal(db, record.id!, project, ph);
    if (db.prepare('SELECT 1 FROM memories WHERE id = ?').get(record.id!) === undefined) {
      insertProjectedRow(db, record.id!, buildInertProjection(env, record));
    }
    bindEntity(db, { entityId: env.entity_id, localMemoryId: record.id!, project, version: env.entity_version, canonicalHash: ch, projectionHash: projectionHashOfRow(db, record.id!) ?? ph });
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
    // Reusing an existing id that is NOT the matched row requires the
    // collision guard.
    if (!isSelf) assertRebindLegal(db, record.id!, project, ph);
    if (!isSelf && db.prepare('SELECT 1 FROM memories WHERE id = ?').get(record.id!) === undefined) {
      insertProjectedRow(db, record.id!, buildInertProjection(env, record));
    }
    // S6/R22: ph is the hash of the bytes actually stored — on a rebind
    // of a pre-existing row those may not be the incoming payload's
    // (review C8).
    bindEntity(db, { entityId: env.entity_id, localMemoryId: record.id!, project, version: env.entity_version, canonicalHash: ch, projectionHash: projectionHashOfRow(db, record.id!) ?? ph });
    mergeContributors(db, env.entity_id, env.contributors, env.entity_version);
    return isSelf ? 'replay-noop' : 'twin-inserted';
  }

  // T1: genuinely new entity.
  if (db.prepare('SELECT 1 FROM memories WHERE id = ?').get(record.id!) !== undefined) {
    // Replay after a lost map entry: rebind is legal ONLY when this is
    // provably the same row — same project, same as-stored bytes; a
    // UUID collision fails the batch instead of corrupting the map
    // (slice-4 Codex gate #2). ph is the AS-STORED hash (S6/R22).
    assertRebindLegal(db, record.id!, project, ph);
    bindEntity(db, { entityId: env.entity_id, localMemoryId: record.id!, project, version: env.entity_version, canonicalHash: ch, projectionHash: projectionHashOfRow(db, record.id!) ?? ph });
    mergeContributors(db, env.entity_id, env.contributors, env.entity_version);
    return 'replay-noop';
  }
  insertProjectedRow(db, record.id!, buildInertProjection(env, record));
  bindEntity(db, { entityId: env.entity_id, localMemoryId: record.id!, project, version: env.entity_version, canonicalHash: ch, projectionHash: projectionHashOfRow(db, record.id!) ?? ph });
  mergeContributors(db, env.entity_id, env.contributors, env.entity_version);
  return 'applied-new';
}
