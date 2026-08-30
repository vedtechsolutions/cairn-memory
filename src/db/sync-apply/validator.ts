import {
  CANONICALIZATION_VERSION, CONTENT_HASH_VERSION,
  canonicalJson, validateRecordPayload, SHAREABLE_KINDS, isSyncEventType,
  isConflictReason,
  type SyncEvent, type SyncEntityEnvelope, type PortableRecord,
} from 'waykeep-contract';

import { SYNC_APPLY, LIMITS } from '../../constants/index.js';
import { hashCanonical } from './projection.js';
import { ApplyValidationError } from './errors.js';

/**
 * Fail-closed runtime validation for one inbound event batch (slice-4
 * Codex gate #1). The stream is UNTRUSTED regardless of its source: a
 * compromised server, a hostile teammate, or a bug upstream must never
 * advance the cursor, touch another project's rows, or land unbounded
 * bytes. Every failure refuses the WHOLE batch — the caller's
 * transaction rolls back with no cursor or generation movement.
 */

const isSafePositiveInt = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v > 0;

function assertBoundedId(v: unknown, label: string): asserts v is string {
  if (typeof v !== 'string' || v.length === 0 || v.length > SYNC_APPLY.MAX_ID_LENGTH) {
    throw new ApplyValidationError(`${label} must be a non-empty string of at most ${SYNC_APPLY.MAX_ID_LENGTH} chars`);
  }
}

function validateEnvelopeShape(env: unknown, seq: number): SyncEntityEnvelope {
  if (env === null || typeof env !== 'object') throw new ApplyValidationError(`seq ${seq}: entity envelope is not an object`);
  const e = env as Record<string, unknown>;
  assertBoundedId(e.entity_id, `seq ${seq}: entity_id`);
  if (!isSafePositiveInt(e.entity_version)) throw new ApplyValidationError(`seq ${seq}: entity_version must be a positive safe integer`);
  if (typeof e.payload !== 'string' || Buffer.byteLength(e.payload, 'utf8') > SYNC_APPLY.MAX_PAYLOAD_BYTES) {
    throw new ApplyValidationError(`seq ${seq}: payload missing or exceeds ${SYNC_APPLY.MAX_PAYLOAD_BYTES} bytes`);
  }
  assertBoundedId(e.canonical_content_hash, `seq ${seq}: canonical_content_hash`);
  if (e.canonicalization_version !== CANONICALIZATION_VERSION || e.hash_version !== CONTENT_HASH_VERSION) {
    throw new ApplyValidationError(`seq ${seq}: unsupported canonicalization/hash version`);
  }
  assertBoundedId(e.author, `seq ${seq}: author`);
  if (!Array.isArray(e.contributors) || e.contributors.length > SYNC_APPLY.MAX_CONTRIBUTORS
    || !e.contributors.every((c) => typeof c === 'string' && c.length > 0 && c.length <= SYNC_APPLY.MAX_ID_LENGTH)) {
    throw new ApplyValidationError(`seq ${seq}: contributors must be a bounded array of account ids`);
  }
  assertBoundedId(e.origin_client, `seq ${seq}: origin_client`);
  if (typeof e.created_at !== 'string' || typeof e.updated_at !== 'string') {
    throw new ApplyValidationError(`seq ${seq}: created_at/updated_at must be strings`);
  }
  return env as SyncEntityEnvelope;
}

/** Full payload validation for an upsert-carrying envelope: shape,
 *  D7's frozen shareable allowlist (a replicated `correction` — the
 *  highest-injection-authority kind — is refused no matter who sent
 *  it), size bounds, the caller's project boundary, and canonical-hash
 *  INTEGRITY — the hash must actually be the hash of the canonical
 *  payload bytes, so a forged-equal hash cannot steer identity
 *  classification (defense in depth ahead of T8a). */
export function validatePayload(env: SyncEntityEnvelope, targetProject: string): PortableRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(env.payload);
  } catch {
    throw new ApplyValidationError(`entity ${env.entity_id}: payload is not valid JSON`);
  }
  if (hashCanonical(canonicalJson(parsed)) !== env.canonical_content_hash) {
    throw new ApplyValidationError(`entity ${env.entity_id}: canonical_content_hash does not match the payload bytes`);
  }
  const record = validateRecordPayload(parsed);
  if (!record.id) throw new ApplyValidationError(`entity ${env.entity_id}: payload record carries no id`);
  if (!(SHAREABLE_KINDS as readonly string[]).includes(record.kind)) {
    throw new ApplyValidationError(`entity ${env.entity_id}: kind '${record.kind}' is not team-shareable`);
  }
  if (record.content.length > LIMITS.MAX_CONTENT_CHARS) {
    throw new ApplyValidationError(`entity ${env.entity_id}: content exceeds ${LIMITS.MAX_CONTENT_CHARS} chars`);
  }
  if (record.tags.length > LIMITS.MAX_TAGS || record.tags.some((t) => t.length > SYNC_APPLY.MAX_ID_LENGTH)) {
    throw new ApplyValidationError(`entity ${env.entity_id}: tags exceed count/length bounds`);
  }
  if (record.anchor !== null && record.anchor.length > SYNC_APPLY.MAX_ANCHOR_CHARS) {
    throw new ApplyValidationError(`entity ${env.entity_id}: anchor exceeds ${SYNC_APPLY.MAX_ANCHOR_CHARS} chars`);
  }
  if (record.project !== targetProject) {
    throw new ApplyValidationError(`entity ${env.entity_id}: record project does not match the caller's target binding`);
  }
  return record;
}

/** Per-event runtime shape validation — every event type, not only
 *  upserts (a `{type, seq}`-only tombstone previously reached its
 *  handler and consumed the cursor). */
function validateEventShape(ev: SyncEvent): void {
  const raw = ev as unknown as Record<string, unknown>;
  if (!isSafePositiveInt(raw.seq)) throw new ApplyValidationError('event seq must be a positive safe integer');
  const seq = raw.seq;
  switch (ev.type) {
    case 'upsert':
      validateEnvelopeShape(raw.entity, seq);
      break;
    case 'tombstone':
      assertBoundedId(raw.entity_id, `seq ${seq}: tombstone entity_id`);
      if (!isSafePositiveInt(raw.entity_version)) throw new ApplyValidationError(`seq ${seq}: tombstone entity_version must be a positive safe integer`);
      assertBoundedId(raw.deleted_by, `seq ${seq}: tombstone deleted_by`);
      if (typeof raw.deleted_at !== 'string' || raw.deleted_at.length === 0 || raw.deleted_at.length > SYNC_APPLY.MAX_ID_LENGTH) {
        throw new ApplyValidationError(`seq ${seq}: tombstone deleted_at must be a bounded string`);
      }
      break;
    case 'alias':
      assertBoundedId(raw.from_entity_id, `seq ${seq}: alias from_entity_id`);
      assertBoundedId(raw.to_entity_id, `seq ${seq}: alias to_entity_id`);
      if (raw.from_entity_id === raw.to_entity_id) throw new ApplyValidationError(`seq ${seq}: alias cannot target itself`);
      if (!isSafePositiveInt(raw.as_of_version)) throw new ApplyValidationError(`seq ${seq}: alias as_of_version must be a positive safe integer`);
      break;
    case 'conflict-open':
      assertBoundedId(raw.conflict_set_id, `seq ${seq}: conflict_set_id`);
      if (!Array.isArray(raw.member_entity_ids) || raw.member_entity_ids.length < 2
        || raw.member_entity_ids.length > SYNC_APPLY.MAX_MEMBER_IDS
        || !raw.member_entity_ids.every((m) => typeof m === 'string' && m.length > 0 && m.length <= SYNC_APPLY.MAX_ID_LENGTH)) {
        throw new ApplyValidationError(`seq ${seq}: member_entity_ids must be 2..${SYNC_APPLY.MAX_MEMBER_IDS} bounded ids`);
      }
      if (typeof raw.reason !== 'string' || !isConflictReason(raw.reason)) throw new ApplyValidationError(`seq ${seq}: unknown conflict reason`);
      assertBoundedId(raw.opened_by, `seq ${seq}: opened_by`);
      break;
    case 'resolve-commit':
      assertBoundedId(raw.conflict_set_id, `seq ${seq}: conflict_set_id`);
      validateEnvelopeShape(raw.canonical, seq);
      if (!Array.isArray(raw.tombstoned_entity_ids) || raw.tombstoned_entity_ids.length > SYNC_APPLY.MAX_MEMBER_IDS
        || !raw.tombstoned_entity_ids.every((m) => typeof m === 'string' && m.length > 0 && m.length <= SYNC_APPLY.MAX_ID_LENGTH)) {
        throw new ApplyValidationError(`seq ${seq}: tombstoned_entity_ids must be a bounded id array`);
      }
      if (!Array.isArray(raw.contributors) || raw.contributors.length > SYNC_APPLY.MAX_CONTRIBUTORS
        || !raw.contributors.every((c) => typeof c === 'string' && c.length > 0 && c.length <= SYNC_APPLY.MAX_ID_LENGTH)) {
        throw new ApplyValidationError(`seq ${seq}: resolve contributors must be a bounded array of account ids`);
      }
      break;
  }
}

/** Whole-batch validation: closed vocabulary, per-event shape, bounded
 *  batch size, and unique sequences (two events sharing a seq previously
 *  BOTH committed). Gaps are legal — server compaction removes events
 *  (D1-R) — but duplicates never are. */
export function validateBatch(events: readonly SyncEvent[]): void {
  if (events.length > SYNC_APPLY.MAX_EVENTS_PER_BATCH) {
    throw new ApplyValidationError(`batch exceeds ${SYNC_APPLY.MAX_EVENTS_PER_BATCH} events`);
  }
  const seqs = new Set<number>();
  for (const ev of events) {
    if (ev === null || typeof ev !== 'object' || Array.isArray(ev)) {
      throw new ApplyValidationError('event must be an object');
    }
    if (!isSyncEventType((ev as { type: string }).type)) {
      throw new ApplyValidationError(`unknown event type '${(ev as { type: string }).type}' in the closed vocabulary`);
    }
    validateEventShape(ev);
    if (seqs.has(ev.seq)) throw new ApplyValidationError(`duplicate seq ${ev.seq} in batch`);
    seqs.add(ev.seq);
  }
}
