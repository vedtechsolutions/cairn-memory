import { createHash } from 'node:crypto';

import type Database from 'better-sqlite3';

/**
 * Typed access to the free-core replica tables (brief D3 ownership map):
 * sync_entity_map, sync_alias_log, sync_conflict_sets, sync_contributors
 * and the durable memory generation in sync_state. Every writer here is
 * called INSIDE the apply batch transaction — nothing opens its own.
 *
 * Cardinality (X26): a local row carries at most one association —
 * enforced by the UNIQUE(local_memory_id) constraint; creating a binding
 * deletes any existing association for that row in the same transaction.
 */

export type EntityMapState = 'bound' | 'shadow-assoc';

export interface EntityMapEntry {
  entity_id: string;
  local_memory_id: string;
  project: string;
  state: EntityMapState;
  canonical_version: number;
  canonical_hash: string;
  projection_hash: string;
  inert_projection: string | null;
  contributors: string | null;
}

export function getByEntityId(db: Database.Database, entityId: string): EntityMapEntry | undefined {
  return db.prepare('SELECT * FROM sync_entity_map WHERE entity_id = ?').get(entityId) as EntityMapEntry | undefined;
}

export function getByLocalMemoryId(db: Database.Database, memoryId: string): EntityMapEntry | undefined {
  return db.prepare('SELECT * FROM sync_entity_map WHERE local_memory_id = ?').get(memoryId) as EntityMapEntry | undefined;
}

export interface BindInput {
  entityId: string;
  localMemoryId: string;
  project: string;
  version: number;
  canonicalHash: string;
  projectionHash: string;
}

/** Create or update a binding. Closes any other association the row
 *  carries and any prior entry under this entity id (rebind after
 *  alias/fork) — cardinality holds in both directions. */
export function bindEntity(db: Database.Database, input: BindInput): void {
  db.prepare('DELETE FROM sync_entity_map WHERE local_memory_id = ? AND entity_id != ?')
    .run(input.localMemoryId, input.entityId);
  db.prepare(`
    INSERT INTO sync_entity_map (entity_id, local_memory_id, project, state, canonical_version, canonical_hash, projection_hash, inert_projection, contributors, updated_at)
    VALUES (?, ?, ?, 'bound', ?, ?, ?, NULL, NULL, datetime('now'))
    ON CONFLICT(entity_id) DO UPDATE SET
      local_memory_id = excluded.local_memory_id, project = excluded.project,
      state = 'bound', canonical_version = excluded.canonical_version,
      canonical_hash = excluded.canonical_hash, projection_hash = excluded.projection_hash,
      inert_projection = NULL, contributors = NULL, updated_at = excluded.updated_at
  `).run(input.entityId, input.localMemoryId, input.project, input.version, input.canonicalHash, input.projectionHash);
}

export interface ShadowAssocInput extends BindInput {
  /** Inert projection Π — the projected (as-would-be-stored) payload,
   *  JSON, so the entity is materializable offline (X26). */
  inertProjection: string;
  /** Contributor snapshot C (server-stamped account ids). */
  contributors: string[];
}

export function writeShadowAssoc(db: Database.Database, input: ShadowAssocInput): void {
  db.prepare('DELETE FROM sync_entity_map WHERE local_memory_id = ? AND entity_id != ?')
    .run(input.localMemoryId, input.entityId);
  db.prepare(`
    INSERT INTO sync_entity_map (entity_id, local_memory_id, project, state, canonical_version, canonical_hash, projection_hash, inert_projection, contributors, updated_at)
    VALUES (?, ?, ?, 'shadow-assoc', ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(entity_id) DO UPDATE SET
      local_memory_id = excluded.local_memory_id, project = excluded.project,
      state = 'shadow-assoc', canonical_version = excluded.canonical_version,
      canonical_hash = excluded.canonical_hash, projection_hash = excluded.projection_hash,
      inert_projection = excluded.inert_projection, contributors = excluded.contributors,
      updated_at = excluded.updated_at
  `).run(input.entityId, input.localMemoryId, input.project, input.version, input.canonicalHash,
    input.projectionHash, input.inertProjection, JSON.stringify(input.contributors));
}

export function closeEntry(db: Database.Database, entityId: string): void {
  db.prepare('DELETE FROM sync_entity_map WHERE entity_id = ?').run(entityId);
}

export function recordAlias(db: Database.Database, fromEntityId: string, toEntityId: string, asOfVersion: number, seq: number): void {
  db.prepare(`
    INSERT INTO sync_alias_log (from_entity_id, to_entity_id, as_of_version, seq, applied_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(from_entity_id) DO NOTHING
  `).run(fromEntityId, toEntityId, asOfVersion, seq);
}

/** Append-only contributor projection: existing rows are never removed
 *  or restamped (first_seq is first-observation provenance). */
export function mergeContributors(db: Database.Database, entityId: string, accountIds: readonly string[], seq: number): void {
  const stmt = db.prepare(`
    INSERT INTO sync_contributors (entity_id, account_id, first_seq)
    VALUES (?, ?, ?) ON CONFLICT(entity_id, account_id) DO NOTHING
  `);
  for (const accountId of accountIds) stmt.run(entityId, accountId, seq);
}

export function contributorsOf(db: Database.Database, entityId: string): string[] {
  const rows = db.prepare('SELECT account_id FROM sync_contributors WHERE entity_id = ? ORDER BY first_seq, account_id')
    .all(entityId) as Array<{ account_id: string }>;
  return rows.map((r) => r.account_id);
}

/** Deterministic client-minted conflict-set id (§6 T8b): both replicas
 *  of the same pair mint the same id, so the mint is replay-idempotent
 *  and server reconciliation can dedup. */
export function deterministicConflictSetId(memberEntityIds: readonly string[], reason: string): string {
  const basis = `${reason}:${[...memberEntityIds].sort().join(',')}`;
  return `cs-${createHash('sha256').update(basis, 'utf8').digest('hex').slice(0, 32)}`;
}

export function openConflictSet(
  db: Database.Database,
  input: { conflictSetId: string; project: string; memberEntityIds: readonly string[]; reason: string; openedBy: string; openedSeq: number },
): void {
  db.prepare(`
    INSERT INTO sync_conflict_sets (conflict_set_id, project, member_entity_ids, reason, opened_by, opened_seq, status)
    VALUES (?, ?, ?, ?, ?, ?, 'open') ON CONFLICT(conflict_set_id) DO NOTHING
  `).run(input.conflictSetId, input.project, JSON.stringify([...input.memberEntityIds].sort()), input.reason, input.openedBy, input.openedSeq);
}

export function resolveConflictSet(db: Database.Database, conflictSetId: string, resolvedSeq: number): void {
  db.prepare("UPDATE sync_conflict_sets SET status = 'resolved', resolved_seq = ? WHERE conflict_set_id = ?")
    .run(resolvedSeq, conflictSetId);
}

const GENERATION_NS = 'memory';
const GENERATION_KEY = 'generation';

/** Durable memory generation (D3/X16): every committed apply batch bumps
 *  it; every memory-derived cache reader checks it before trusting a
 *  cached view. Read outside transactions is legal (single INTEGER). */
export function readGeneration(db: Database.Database): number {
  const row = db.prepare('SELECT v FROM sync_state WHERE ns = ? AND k = ?').get(GENERATION_NS, GENERATION_KEY) as { v: string } | undefined;
  return row ? Number(row.v) : 0;
}

export function bumpGeneration(db: Database.Database): number {
  const next = readGeneration(db) + 1;
  db.prepare(`
    INSERT INTO sync_state (ns, k, v, updated_at) VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(ns, k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at
  `).run(GENERATION_NS, GENERATION_KEY, String(next));
  return next;
}
