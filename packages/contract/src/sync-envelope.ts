/**
 * Sync envelope — the replication contract for Waykeep Team (Phase 2).
 *
 * Types and constants only, zero dependencies, additive-stability
 * guaranteed: values may be added, never changed or removed within a
 * major version, and consumers must tolerate unknown values. The
 * normative behavior behind every name here is the Phase 2 design
 * brief; this module is its wire vocabulary.
 *
 * Deliberately absent: retention windows, policy mirrors, seat-ledger
 * shapes, server URLs — product/server internals, never contract. The
 * payload of an envelope is the portable round-trip record (see
 * round-trip.ts) as canonical JSON; this module does not redefine it.
 */

/** Protocol version negotiated between client and server; a consumer
 *  refusing an unknown MAJOR version must fail closed, never guess. */
export const SYNC_PROTOCOL_VERSION = 1;

/** Version of the canonical-JSON form used for content hashing. */
export const CANONICALIZATION_VERSION = 1;

/** Algorithm behind every canonical_content_hash in this protocol. */
export const CONTENT_HASH_ALGORITHM = 'sha256';

/** Version of the local projection function P (scrub + neutralize +
 *  canonicalize). All entity-vs-local-row equality lives in P's output
 *  domain; canonical hashes compare only canonical-to-canonical. The
 *  implementation is core-internal; the VERSION is contract so replicas
 *  can detect projection-rule drift. */
export const PROJECTION_VERSION = 1;

/** Client commands a device may submit. */
export const SYNC_COMMANDS = ['upsert', 'tombstone', 'conflict-open', 'resolve'] as const;
export type SyncCommandType = (typeof SYNC_COMMANDS)[number];

/** Canonical server log events — the CLOSED replication vocabulary:
 *  what replicas pull and snapshots contain. Within composed
 *  applications (`alias`, `resolve-commit`) tombstones apply before
 *  upserts. */
export const SYNC_EVENTS = ['upsert', 'tombstone', 'alias', 'conflict-open', 'resolve-commit'] as const;
export type SyncEventType = (typeof SYNC_EVENTS)[number];

/** Reasons a client may open a conflict set. */
export const CONFLICT_REASONS = ['near-duplicate', 'divergence'] as const;
export type ConflictReason = (typeof CONFLICT_REASONS)[number];

/** Explicit per-row sharing states. The third state is the ABSENCE of a
 *  value (NULL): "no explicit user choice", policy-evaluated by the
 *  sync worker — never a stored default. `share_state` is local
 *  control: excluded from canonical bytes/hash, never replicated. */
export const SHARE_STATES = ['local', 'team'] as const;
export type ShareState = (typeof SHARE_STATES)[number];

/**
 * Stable error codes a sync client must handle. An OPEN set for
 * consumers: unknown codes are errors of unknown kind, not protocol
 * violations.
 *  - HASH_COLLISION: terminal — unequal canonical bytes behind one
 *    hash; remediation is editing the content, never a retry.
 *  - STALE_VERSION: deterministic rejection-with-current-state of an
 *    edit/tombstone whose base entity version is behind.
 *  - STALE_POLICY: the submitting worker's owner-policy mirror is
 *    behind the authoritative revision; refresh and reclassify —
 *    forbidden payloads are never retried.
 *  - OVER_CAPACITY: a seat claim beyond the billed capacity.
 *  - CURSOR_BELOW_FLOOR: the device lost incremental status; the
 *    guided snapshot-rebase flow is the remediation.
 *  - PROTOCOL_UNSUPPORTED: version negotiation failed; fail closed.
 */
export const SYNC_ERROR_CODES = [
  'HASH_COLLISION',
  'STALE_VERSION',
  'STALE_POLICY',
  'OVER_CAPACITY',
  'CURSOR_BELOW_FLOOR',
  'PROTOCOL_UNSUPPORTED',
] as const;
export type SyncErrorCode = (typeof SYNC_ERROR_CODES)[number];

/** Results of the read-only, payload-free op-status query (outcome
 *  resolution for in-flight/unknown work; never a mutation). */
export const OP_STATUS_RESULTS = ['committed', 'rejected', 'not-seen'] as const;
export type OpStatusResult = (typeof OP_STATUS_RESULTS)[number];

/**
 * The entity envelope carried by upsert events and snapshots. The
 * payload is the portable record as canonical JSON (round-trip.ts
 * vocabulary); provenance identities are OPAQUE server-account ids,
 * server-stamped — a client-asserted author is decorative. The `enc_*`
 * fields are RESERVED (D9): absent until an encryption tier ships;
 * when present the payload is an opaque ciphertext and the visible
 * metadata still orders, dedups-by-id, and enforces seats.
 */
export interface SyncEntityEnvelope {
  entity_id: string;
  entity_version: number;
  payload: string;
  canonical_content_hash: string;
  canonicalization_version: number;
  created_by: string;
  last_edited_by: string;
  origin_client: string;
  origin_device?: string;
  created_at: string;
  updated_at: string;
  tombstoned: boolean;
  enc_version?: number;
  enc_key_id?: string;
}

interface SyncCommandBase {
  type: SyncCommandType;
  /** Stable client-generated id; retries are idempotent — the same
   *  op_id always returns the originally committed result. */
  op_id: string;
  protocol_version: number;
}

export interface SyncUpsertCommand extends SyncCommandBase {
  type: 'upsert';
  entity_id: string;
  /** Absent = create. Restoration is an upsert carrying an explicit
   *  tombstone-version precondition. */
  base_version?: number;
  /** Precondition for restoration-after-tombstone. */
  tombstone_version?: number;
  payload: string;
  canonical_content_hash: string;
}

export interface SyncTombstoneCommand extends SyncCommandBase {
  type: 'tombstone';
  entity_id: string;
  base_version: number;
}

export interface SyncConflictOpenCommand extends SyncCommandBase {
  type: 'conflict-open';
  member_entity_ids: string[];
  reason: ConflictReason;
}

/** All-or-nothing CAS over one open conflict set; capped size; may
 *  tombstone only members of the named set. First valid concurrent
 *  resolution wins; a stale one is rejected with the committed set. */
export interface SyncResolveCommand extends SyncCommandBase {
  type: 'resolve';
  conflict_set_id: string;
  expected_versions: Record<string, number>;
  canonical_entity_id: string;
  canonical_payload: string;
  canonical_content_hash: string;
  tombstone_entity_ids: string[];
}

export type SyncCommand =
  | SyncUpsertCommand
  | SyncTombstoneCommand
  | SyncConflictOpenCommand
  | SyncResolveCommand;

interface SyncEventBase {
  type: SyncEventType;
  /** Server-assigned per-project monotonic sequence — the only clock. */
  seq: number;
}

export interface SyncUpsertEvent extends SyncEventBase {
  type: 'upsert';
  entity: SyncEntityEnvelope;
}

export interface SyncTombstoneEvent extends SyncEventBase {
  type: 'tombstone';
  entity_id: string;
  entity_version: number;
  deleted_by: string;
  deleted_at: string;
}

/** "Locally-submitted entity L is canonically E as of version v" —
 *  ordered like any event, applied identically by replica and
 *  snapshot; tombstones before upserts within its application. */
export interface SyncAliasEvent extends SyncEventBase {
  type: 'alias';
  from_entity_id: string;
  to_entity_id: string;
  as_of_version: number;
}

export interface SyncConflictOpenEvent extends SyncEventBase {
  type: 'conflict-open';
  conflict_set_id: string;
  member_entity_ids: string[];
  reason: ConflictReason;
  opened_by: string;
}

export interface SyncResolveCommitEvent extends SyncEventBase {
  type: 'resolve-commit';
  conflict_set_id: string;
  canonical: SyncEntityEnvelope;
  tombstoned_entity_ids: string[];
}

export type SyncEvent =
  | SyncUpsertEvent
  | SyncTombstoneEvent
  | SyncAliasEvent
  | SyncConflictOpenEvent
  | SyncResolveCommitEvent;

// --- Guards (open-set tolerant: use for dispatch, never to reject unknowns) ---

export function isSyncCommandType(v: string): v is SyncCommandType {
  return (SYNC_COMMANDS as readonly string[]).includes(v);
}

export function isSyncEventType(v: string): v is SyncEventType {
  return (SYNC_EVENTS as readonly string[]).includes(v);
}

export function isShareState(v: string): v is ShareState {
  return (SHARE_STATES as readonly string[]).includes(v);
}

export function isConflictReason(v: string): v is ConflictReason {
  return (CONFLICT_REASONS as readonly string[]).includes(v);
}

export function isSyncErrorCode(v: string): v is SyncErrorCode {
  return (SYNC_ERROR_CODES as readonly string[]).includes(v);
}

export function isOpStatusResult(v: string): v is OpStatusResult {
  return (OP_STATUS_RESULTS as readonly string[]).includes(v);
}
