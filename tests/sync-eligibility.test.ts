import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { canonicalJson } from 'waykeep-contract';
import type { SyncEntityEnvelope, SyncEvent, PortableRecord } from 'waykeep-contract';

import { openDatabase } from '../src/db/connection.js';
import { MemoryRepository } from '../src/db/memory-repository.js';
import { syncEligibility, transmitEligibility, selectProjectRows, type EligibilityContext } from '../src/db/sync-eligibility.js';
import { cairnConfigHealth, cairnConfigSnapshot, resetConfigCacheForTests } from '../src/config/cairn-config.js';
import { SessionCache } from '../src/hooks/shared/session-cache.js';
import { applyEventBatch, hashCanonical } from '../src/db/sync-apply/index.js';

const PROJECT = 'elig-proj';

const snap = (opts?: { healthy?: boolean; privateProjects?: string[] }) => ({
  config: { scope: { privateProjects: new Set(opts?.privateProjects ?? []) }, report: { rollup: true } },
  health: {
    healthy: opts?.healthy ?? true,
    problem: (opts?.healthy ?? true) ? null : 'test-injected',
    badSections: [] as string[],
    path: '/test/config.json',
  },
});

const baseCtx = (over?: Partial<EligibilityContext>): EligibilityContext => ({
  project: PROJECT, enrolled: true, consentSealed: true,
  config: snap(), ...over,
});

const row = (over?: Partial<{ kind: string; project: string | null; share_state: string | null }>) =>
  ({ kind: 'fact', project: PROJECT, share_state: null, ...over });

describe('sync eligibility (D10 fail-closed predicate)', () => {
  it('a fully-satisfied context with a candidate row is eligible', () => {
    assert.deepEqual(syncEligibility(row(), baseCtx()), { eligible: true, reason: null });
    assert.equal(syncEligibility(row({ share_state: 'team' }), baseCtx()).eligible, true);
  });

  it('every checkpoint fails closed with its named reason', () => {
    assert.equal(syncEligibility(row(), baseCtx({ config: snap({ healthy: false }) })).reason, 'config-unhealthy');
    assert.equal(syncEligibility(row(), baseCtx({ config: snap({ privateProjects: [PROJECT] }) })).reason, 'project-private');
    assert.equal(syncEligibility(row(), baseCtx({ enrolled: false })).reason, 'not-enrolled');
    assert.equal(syncEligibility(row(), baseCtx({ consentSealed: false })).reason, 'consent-not-sealed');
    assert.equal(syncEligibility(row({ project: null }), baseCtx()).reason, 'project-mismatch');
    assert.equal(syncEligibility(row({ project: 'other' }), baseCtx()).reason, 'project-mismatch');
    assert.equal(syncEligibility(row({ kind: 'correction' }), baseCtx()).reason, 'kind-not-shareable');
    assert.equal(syncEligibility(row({ share_state: 'local' }), baseCtx()).reason, 'opted-out');
  });

  it('C3: an absolute-path or malformed anchor fails closed — machine-local paths never travel', () => {
    assert.equal(syncEligibility(row({ ...{}, }), baseCtx()).eligible, true);
    const abs = { ...row(), anchor: JSON.stringify({ files: ['/opt/cairn/src/x.ts'] }) };
    assert.equal(syncEligibility(abs, baseCtx()).reason, 'anchor-unresolvable');
    const win = { ...row(), anchor: JSON.stringify({ files: ['C:\\repo\\x.ts'] }) };
    assert.equal(syncEligibility(win, baseCtx()).reason, 'anchor-unresolvable');
    const rel = { ...row(), anchor: JSON.stringify({ files: ['src/x.ts'] }) };
    assert.equal(syncEligibility(rel, baseCtx()).eligible, true, 'relative anchors travel');
    const malformed = { ...row(), anchor: '{broken' };
    assert.equal(syncEligibility(malformed, baseCtx()).reason, 'anchor-unresolvable', 'unknown is not shareable');
  });

  it('H1: only the tri-state exists — any other share_state value is unknown and never uploads', () => {
    for (const bad of ['', 'bogus', 'LOCAL', 'Team ']) {
      assert.equal(syncEligibility(row({ share_state: bad }), baseCtx()).reason, 'share-state-invalid', `'${bad}' must fail closed`);
    }
    assert.equal(syncEligibility({ ...row(), share_state: 0 as unknown as string }, baseCtx()).reason, 'share-state-invalid');
    assert.equal(syncEligibility({ ...row(), share_state: false as unknown as string }, baseCtx()).reason, 'share-state-invalid');
  });

  it('H2: a malformed policy mirror is invalid — corrupt policy never permits what happens to parse', () => {
    const corrupt = baseCtx({ ownerAllowedKinds: ['fact', 7, 'fact'] as unknown as string[] });
    assert.equal(syncEligibility(row({ kind: 'fact' }), corrupt).reason, 'policy-invalid');
  });

  it('H2: transmitEligibility is the complete D10 predicate — unproven scrub or anchor assertions fail closed', () => {
    const ok = { scrubCompleted: true, anchorRelativized: true };
    assert.equal(transmitEligibility(row(), baseCtx(), ok).eligible, true);
    assert.equal(transmitEligibility(row(), baseCtx(), { ...ok, scrubCompleted: false }).reason, 'scrub-not-verified');
    assert.equal(transmitEligibility(row(), baseCtx(), { ...ok, anchorRelativized: false }).reason, 'anchor-not-relativized');
    // The enqueue-half's refusals pass through unchanged.
    assert.equal(transmitEligibility(row({ share_state: 'local' }), baseCtx(), ok).reason, 'opted-out');
    // Codex delta: only the literal true proves an assertion.
    assert.equal(transmitEligibility(row(), baseCtx(), { scrubCompleted: 'yes' as unknown as boolean, anchorRelativized: true }).reason, 'scrub-not-verified');
    assert.equal(transmitEligibility(row(), baseCtx(), { scrubCompleted: true, anchorRelativized: 1 as unknown as boolean }).reason, 'anchor-not-relativized');
  });

  it('N2: a non-array policy mirror is policy-invalid, never an uncaught throw', () => {
    for (const bad of ['fact', 42, { kinds: [] }, null]) {
      const ctx = baseCtx({ ownerAllowedKinds: bad as unknown as string[] });
      assert.equal(syncEligibility(row(), ctx).reason, 'policy-invalid', `${JSON.stringify(bad)} must fail closed, not crash`);
    }
  });

  it('N3: unknown anchor shapes and every machine-local path class fail closed', () => {
    const cases: Array<[string, string]> = [
      [JSON.stringify({ files: '/abs/x.ts' }), 'non-array files is unknown'],
      [JSON.stringify({ other: 1 }), 'missing files is unknown'],
      [JSON.stringify([1]), 'array document is unknown'],
      [JSON.stringify({ files: [42] }), 'non-string entry is unknown'],
      [JSON.stringify({ files: ['\\\\host\\share\\x.ts'] }), 'UNC is machine-local'],
      [JSON.stringify({ files: ['~/secret.ts'] }), 'home-relative is machine-local'],
      [JSON.stringify({ files: ['../../../etc/passwd'] }), 'parent-escape leaves the root'],
      [JSON.stringify({ files: ['src/../../x.ts'] }), 'embedded parent-escape too'],
    ];
    for (const [anchor, why] of cases) {
      assert.equal(syncEligibility({ ...row(), anchor }, baseCtx()).reason, 'anchor-unresolvable', why);
    }
    assert.equal(syncEligibility({ ...row(), anchor: JSON.stringify({ files: ['src/ok.ts', 'deep/dir/ok.ts'] }) }, baseCtx()).eligible, true);
  });

  it('owner policy narrows but can never widen the frozen allowlist', () => {
    const narrowed = baseCtx({ ownerAllowedKinds: ['pitfall'] });
    assert.equal(syncEligibility(row({ kind: 'pitfall' }), narrowed).eligible, true);
    assert.equal(syncEligibility(row({ kind: 'fact' }), narrowed).reason, 'kind-owner-excluded');
    // A policy asserting a non-shareable kind is ignored by intersection.
    const widened = baseCtx({ ownerAllowedKinds: ['correction', 'fact'] });
    assert.equal(syncEligibility(row({ kind: 'correction' }), widened).reason, 'kind-not-shareable');
    assert.equal(syncEligibility(row({ kind: 'fact' }), widened).eligible, true);
  });

  it('the exact-project selector never returns global or other-project rows', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    try {
      const repo = new MemoryRepository(db);
      const inProject = repo.create({ content: 'selector row in project', kind: 'fact', project: PROJECT, skipDedup: true, skipConflictDetection: true }).id;
      repo.create({ content: 'selector global row', kind: 'fact', project: null, skipDedup: true, skipConflictDetection: true });
      repo.create({ content: 'selector other-project row', kind: 'fact', project: 'other', skipDedup: true, skipConflictDetection: true });
      const invalidated = repo.create({ content: 'selector retired row', kind: 'fact', project: PROJECT, skipDedup: true, skipConflictDetection: true }).id;
      repo.invalidate(invalidated);

      const rows = selectProjectRows(db, PROJECT);
      assert.deepEqual(rows.map((r) => r.id), [inProject].sort());
    } finally {
      db.close();
    }
  });
});

describe('config health surface (D8 item 5)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'waykeep-cfg-')); resetConfigCacheForTests(); });
  afterEach(() => { delete process.env.CAIRN_CONFIG_PATH; resetConfigCacheForTests(); rmSync(dir, { recursive: true, force: true }); });

  it('absent config is healthy (defaults are a valid state); broken JSON and bad sections are unhealthy', () => {
    process.env.CAIRN_CONFIG_PATH = join(dir, 'absent.json');
    assert.equal(cairnConfigHealth().healthy, true);

    const p = join(dir, 'config.json');
    process.env.CAIRN_CONFIG_PATH = p;
    writeFileSync(p, '{not json');
    const broken = cairnConfigHealth();
    assert.equal(broken.healthy, false);
    assert.match(String(broken.problem), /invalid JSON/);

    writeFileSync(p, JSON.stringify({ scope: { privateProjects: 'oops' } }));
    const badSection = cairnConfigHealth();
    assert.equal(badSection.healthy, false);
    assert.match(String(badSection.problem), /scope/);

    writeFileSync(p, JSON.stringify({ scope: { privateProjects: ['secret-proj'] } }));
    assert.equal(cairnConfigHealth().healthy, true);
  });

  it('H5: the snapshot pairs health and policy from ONE read — healthy can never accompany another version\'s policy', () => {
    const p = join(dir, 'snap.json');
    process.env.CAIRN_CONFIG_PATH = p;
    writeFileSync(p, JSON.stringify({ scope: { privateProjects: ['secret-proj'] } }));
    const good = cairnConfigSnapshot();
    assert.equal(good.health.healthy, true);
    assert.ok(good.config.scope.privateProjects.has('secret-proj'), 'the SAME bytes produced both fields');
    assert.ok(good.identity, 'file identity recorded');

    writeFileSync(p, '{broken');
    const bad = cairnConfigSnapshot();
    assert.equal(bad.health.healthy, false);
    assert.equal(bad.config.scope.privateProjects.size, 0, 'unhealthy pairs with the EMPTY config, atomically');
    assert.deepEqual(bad.health.badSections, ['(document)']);
  });

  it('H6: health names bad sections so doctor can render section-accurate impact', () => {
    const p = join(dir, 'sections.json');
    process.env.CAIRN_CONFIG_PATH = p;
    writeFileSync(p, JSON.stringify({ scope: { privateProjects: ['x'] }, report: { rollups: true } }));
    const h = cairnConfigHealth();
    assert.equal(h.healthy, false, 'sync is disabled for ANY unhealthy config');
    assert.deepEqual(h.badSections, ['report'], 'only the report section is named — scope stays active locally');
  });
});

describe('durable-generation cache invalidation (D8 item 7)', () => {
  function record(overrides: Partial<PortableRecord> & { id: string }): PortableRecord {
    return {
      kind: 'fact', content: 'generation probe lesson', confidence: 0.6,
      source: 'learned', tags: [], context: null, fingerprint: null,
      project: PROJECT, expires_at: null, anchor: null,
      created_at: '2026-08-29T10:00:00.000Z', ...overrides,
    };
  }
  function envelope(rec: PortableRecord, entityId: string, version: number): SyncEntityEnvelope {
    const payload = JSON.stringify(rec);
    return {
      entity_id: entityId, entity_version: version, payload,
      canonical_content_hash: hashCanonical(canonicalJson(JSON.parse(payload))),
      canonicalization_version: 1, hash_version: 1,
      author: 'acct-a', contributors: ['acct-a'], origin_client: 'claude',
      created_at: rec.created_at, updated_at: rec.created_at, tombstoned: false,
    };
  }
  const upsert = (seq: number, env: SyncEntityEnvelope): SyncEvent => ({ type: 'upsert', seq, entity: env });

  it('a remote CREATE, EDIT, and TOMBSTONE each invalidate the skip gate AND the FTS candidate cache', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    try {
      const cache = new SessionCache();
      const id = randomUUID();

      // Baseline: seed both caches and observe the generation once.
      cache.checkDurableGeneration(db);
      cache.setSkipGate('sk-1', 'cached-output');
      cache.setFTSCandidates('fts-1', ['m-1']);
      cache.checkDurableGeneration(db);
      assert.ok(cache.getSkipGate('sk-1'), 'no spurious invalidation without a generation change');
      assert.ok(cache.getFTSCandidates('fts-1'));

      // Remote CREATE.
      applyEventBatch(db, PROJECT, [upsert(1, envelope(record({ id }), 'E1', 1))]);
      cache.checkDurableGeneration(db);
      assert.equal(cache.getSkipGate('sk-1'), null, 'skip gate invalidated on remote create');
      assert.equal(cache.getFTSCandidates('fts-1'), null, 'FTS candidates invalidated on remote create');

      // Remote EDIT.
      cache.setSkipGate('sk-2', 'cached-output');
      cache.setFTSCandidates('fts-2', ['m-2']);
      applyEventBatch(db, PROJECT, [upsert(2, envelope(record({ id, content: 'edited generation probe' }), 'E1', 2))]);
      cache.checkDurableGeneration(db);
      assert.equal(cache.getSkipGate('sk-2'), null, 'skip gate invalidated on remote edit');
      assert.equal(cache.getFTSCandidates('fts-2'), null);

      // Remote TOMBSTONE.
      cache.setSkipGate('sk-3', 'cached-output');
      cache.setFTSCandidates('fts-3', ['m-3']);
      applyEventBatch(db, PROJECT, [{ type: 'tombstone', seq: 3, entity_id: 'E1', entity_version: 3, deleted_by: 'acct-b', deleted_at: '2026-08-29T11:00:00.000Z' }]);
      cache.checkDurableGeneration(db);
      assert.equal(cache.getSkipGate('sk-3'), null, 'skip gate invalidated on remote tombstone');
      assert.equal(cache.getFTSCandidates('fts-3'), null);

      // A no-op check never flushes.
      cache.setSkipGate('sk-4', 'cached-output');
      cache.checkDurableGeneration(db);
      assert.ok(cache.getSkipGate('sk-4'), 'stable generation leaves caches intact');
    } finally {
      db.close();
    }
  });

  it('C1: a NON-missing-table read failure fails CLOSED — both caches flush rather than trust', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    try {
      const cache = new SessionCache();
      cache.checkDurableGeneration(db);
      cache.setSkipGate('sk-x', 'cached');
      cache.setFTSCandidates('fts-x', ['m']);
      db.exec('ALTER TABLE sync_state RENAME COLUMN v TO vv');
      cache.checkDurableGeneration(db);
      assert.equal(cache.getSkipGate('sk-x'), null, 'unknown read state flushes the skip gate');
      assert.equal(cache.getFTSCandidates('fts-x'), null, 'and the FTS cache');
    } finally {
      db.close();
    }
  });

  // (H4/C2 fingerprint-score flush tests removed at step 6: the per-id
  // score cache no longer exists — hits recompute multiSignalScore live,
  // so there is no memory-derived score state left to flush.)

  it('a PROVEN pre-v32 database no-ops; a v32 database missing sync_state is drift and flushes', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    try {
      const cache = new SessionCache();
      cache.setSkipGate('sk-old', 'cached');
      // v32 schema with the table dropped = drift, not history.
      db.exec('DROP TABLE sync_state');
      cache.checkDurableGeneration(db);
      assert.equal(cache.getSkipGate('sk-old'), null, 'a v32 database that LOST sync_state fails closed');

      // Proven pre-v32: schema_version below 32 → legitimate no-op.
      db.prepare('UPDATE schema_version SET version = 31').run();
      cache.setSkipGate('sk-pre', 'cached');
      cache.checkDurableGeneration(db);
      assert.ok(cache.getSkipGate('sk-pre'), 'nothing replicates on a proven pre-v32 schema');
    } finally {
      db.close();
    }
  });
});
