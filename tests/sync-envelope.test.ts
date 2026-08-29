import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  SYNC_PROTOCOL_VERSION,
  CANONICALIZATION_VERSION,
  CONTENT_HASH_ALGORITHM,
  PROJECTION_VERSION,
  SYNC_COMMANDS,
  SYNC_EVENTS,
  CONFLICT_REASONS,
  SHARE_STATES,
  SYNC_ERROR_CODES,
  OP_STATUS_RESULTS,
  isSyncCommandType,
  isSyncEventType,
  isShareState,
  isConflictReason,
  isSyncErrorCode,
  isOpStatusResult,
  type SyncCommand,
  type SyncEvent,
  type SyncEntityEnvelope,
} from 'waykeep-contract';

describe('sync envelope contract', () => {
  it('pins the closed command and event vocabularies from the Phase 2 brief', () => {
    assert.deepEqual([...SYNC_COMMANDS], ['upsert', 'tombstone', 'conflict-open', 'resolve']);
    assert.deepEqual([...SYNC_EVENTS], ['upsert', 'tombstone', 'alias', 'conflict-open', 'resolve-commit']);
  });

  it('pins the protocol, canonicalization, hash, and projection versions', () => {
    assert.equal(SYNC_PROTOCOL_VERSION, 1);
    assert.equal(CANONICALIZATION_VERSION, 1);
    assert.equal(CONTENT_HASH_ALGORITHM, 'sha256');
    assert.equal(PROJECTION_VERSION, 1);
  });

  it('carries the stable error codes clients must handle', () => {
    for (const code of ['HASH_COLLISION', 'STALE_VERSION', 'STALE_POLICY', 'OVER_CAPACITY', 'CURSOR_BELOW_FLOOR', 'PROTOCOL_UNSUPPORTED']) {
      assert.ok(isSyncErrorCode(code), `${code} is a stable error code`);
    }
    assert.equal(SYNC_ERROR_CODES.length, 6);
  });

  it('share states are the two explicit values — the tri-state third is absence', () => {
    assert.deepEqual([...SHARE_STATES], ['local', 'team']);
    assert.ok(isShareState('local') && isShareState('team'));
    assert.ok(!isShareState('') && !isShareState('null') && !isShareState('shared'));
  });

  it('guards dispatch known values and reject non-members without throwing', () => {
    assert.ok(isSyncCommandType('resolve') && !isSyncCommandType('alias'));
    assert.ok(isSyncEventType('alias') && !isSyncEventType('op-status'));
    assert.ok(isConflictReason('near-duplicate') && !isConflictReason('duplicate'));
    assert.ok(isOpStatusResult('not-seen') && !isOpStatusResult('unknown'));
    assert.deepEqual([...OP_STATUS_RESULTS], ['committed', 'rejected', 'not-seen']);
    assert.deepEqual([...CONFLICT_REASONS], ['near-duplicate', 'divergence']);
  });

  it('discriminated unions narrow by type at compile time and shape-check at runtime', () => {
    const envelope: SyncEntityEnvelope = {
      entity_id: 'e1', entity_version: 1,
      payload: '{"content":"x"}', canonical_content_hash: 'h', canonicalization_version: 1,
      created_by: 'acct_1', last_edited_by: 'acct_1', origin_client: 'claude',
      created_at: '2026-08-29T00:00:00Z', updated_at: '2026-08-29T00:00:00Z',
      tombstoned: false,
    };
    const events: SyncEvent[] = [
      { type: 'upsert', seq: 1, entity: envelope },
      { type: 'tombstone', seq: 2, entity_id: 'e1', entity_version: 2, deleted_by: 'acct_1', deleted_at: '2026-08-29T00:00:01Z' },
      { type: 'alias', seq: 3, from_entity_id: 'l1', to_entity_id: 'e1', as_of_version: 2 },
      { type: 'conflict-open', seq: 4, conflict_set_id: 'c1', member_entity_ids: ['e1', 'e2'], reason: 'near-duplicate', opened_by: 'acct_2' },
      { type: 'resolve-commit', seq: 5, conflict_set_id: 'c1', canonical: envelope, tombstoned_entity_ids: ['e2'] },
    ];
    assert.equal(events.length, 5);
    // Sequence is the only clock: strictly increasing in a valid stream.
    for (let i = 1; i < events.length; i++) assert.ok(events[i].seq > events[i - 1].seq);

    const cmd: SyncCommand = {
      type: 'resolve', op_id: 'op1', protocol_version: SYNC_PROTOCOL_VERSION,
      conflict_set_id: 'c1', expected_versions: { e1: 2, e2: 1 },
      canonical_entity_id: 'e1', canonical_payload: '{"content":"x"}',
      canonical_content_hash: 'h', tombstone_entity_ids: ['e2'],
    };
    if (cmd.type === 'resolve') {
      assert.ok(cmd.tombstone_entity_ids.every((id) => id in cmd.expected_versions || id === 'e2'));
    }
  });

  it('reserved encryption fields are optional and absent by default', () => {
    const e: SyncEntityEnvelope = {
      entity_id: 'e1', entity_version: 1, payload: 'p', canonical_content_hash: 'h',
      canonicalization_version: 1, created_by: 'a', last_edited_by: 'a', origin_client: 'codex',
      created_at: 't', updated_at: 't', tombstoned: false,
    };
    assert.equal(e.enc_version, undefined);
    assert.equal(e.enc_key_id, undefined);
  });
});
