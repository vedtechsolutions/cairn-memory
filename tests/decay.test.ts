/**
 * Incremental Ebbinghaus decay — property tests.
 *
 * The core invariant under test: decay depends on wall-clock time only, never
 * on invocation count. The pre-v25 bug charged total-age retention on every
 * fresh session start, compounding per session until the store collapsed onto
 * the confidence floors.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { openDatabase } from '../src/db/connection.js';
import { stripV27Surface } from './helpers/schema-rewind.js';
import { applyConfidenceDecay, effectiveAgeDays } from '../src/db/decay.js';
import { runMaintenance } from '../src/db/maintenance.js';
import { MemoryRepository } from '../src/db/memory-repository.js';
import { CONFIDENCE, DECAY, LIMITS, STABILITY_BY_KIND } from '../src/constants/index.js';

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 1); // fixed synthetic timeline — no real clock

interface SeedOptions {
  kind?: string;
  confidence?: number;
  source?: string;
  createdAtMs?: number;
  lastRecalledMs?: number | null;
  lastDecayedMs?: number | null;
  recallCount?: number;
}

function seed(db: Database.Database, id: string, opts: SeedOptions = {}): void {
  db.prepare(`
    INSERT INTO memories (id, content, kind, project, tags, confidence, source,
      created_at, last_recalled, last_decayed_at, recall_count, invalidated)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
  `).run(
    id, `content for ${id}`, opts.kind ?? 'pitfall', 'proj', '[]',
    opts.confidence ?? 0.6, opts.source ?? 'learned',
    new Date(opts.createdAtMs ?? T0).toISOString(),
    opts.lastRecalledMs != null ? new Date(opts.lastRecalledMs).toISOString() : null,
    opts.lastDecayedMs != null ? new Date(opts.lastDecayedMs).toISOString() : null,
    opts.recallCount ?? 0,
  );
}

function conf(db: Database.Database, id: string): number {
  const row = db.prepare('SELECT confidence FROM memories WHERE id = ?').get(id) as { confidence: number } | undefined;
  assert.ok(row, `memory ${id} should exist`);
  return row.confidence;
}

let db: Database.Database;

beforeEach(() => { db = openDatabase({ dbPath: ':memory:' }); });
afterEach(() => { db.close(); });

describe('effectiveAgeDays', () => {
  it('subtracts the grace period instead of using it as a skip-cliff', () => {
    assert.equal(effectiveAgeDays(T0 + 8 * DAY, T0), 1);
    assert.equal(effectiveAgeDays(T0 + 6 * DAY, T0), 0);
    assert.equal(effectiveAgeDays(T0, T0), 0);
    assert.equal(effectiveAgeDays(T0 - DAY, T0), 0, 'never negative');
  });
});

describe('Incremental decay — frequency independence (the pre-v25 bug)', () => {
  it('30 daily runs produce the same confidence as one run over the same interval', () => {
    const single = openDatabase({ dbPath: ':memory:' });
    seed(single, 'm');
    applyConfidenceDecay(single, T0 + 30 * DAY);
    const singleConf = conf(single, 'm');
    single.close();

    seed(db, 'm');
    for (let day = 1; day <= 30; day++) {
      applyConfidenceDecay(db, T0 + day * DAY);
    }
    const dailyConf = conf(db, 'm');

    assert.ok(Math.abs(dailyConf - singleConf) < 1e-9,
      `daily ${dailyConf} must equal single ${singleConf}`);

    // Both must match the closed form: charge = effAge(30d) = 23d, S = 60
    const expected = 0.6 * Math.exp(-23 / STABILITY_BY_KIND.pitfall);
    assert.ok(Math.abs(singleConf - expected) < 1e-9,
      `single ${singleConf} must equal closed form ${expected}`);
  });

  it('re-running at the same instant changes nothing (invocation idempotence)', () => {
    seed(db, 'm');
    applyConfidenceDecay(db, T0 + 30 * DAY);
    const first = conf(db, 'm');
    const { decayed } = applyConfidenceDecay(db, T0 + 30 * DAY);
    assert.equal(decayed, 0, 'second run at same instant must decay nothing');
    assert.equal(conf(db, 'm'), first);
  });

  it('charges exactly (age − grace): 8-day-old memory is charged 1 day', () => {
    seed(db, 'm');
    applyConfidenceDecay(db, T0 + 8 * DAY);
    const expected = 0.6 * Math.exp(-1 / STABILITY_BY_KIND.pitfall);
    assert.ok(Math.abs(conf(db, 'm') - expected) < 1e-12);
  });

  it('does not decay within the grace period', () => {
    seed(db, 'm');
    const { decayed } = applyConfidenceDecay(db, T0 + 6 * DAY);
    assert.equal(decayed, 0);
    assert.equal(conf(db, 'm'), 0.6);
  });

  it('a recall resets the epoch: only post-recall age is charged', () => {
    // decayed through T0+80d, recalled at T0+90d, evaluated at T0+100d
    seed(db, 'm', { lastRecalledMs: T0 + 90 * DAY, lastDecayedMs: T0 + 80 * DAY });
    applyConfidenceDecay(db, T0 + 100 * DAY);
    // ref = recall time; charge = effAge(10d) − effAge(negative → 0) = 3d
    const expected = 0.6 * Math.exp(-3 / STABILITY_BY_KIND.pitfall);
    assert.ok(Math.abs(conf(db, 'm') - expected) < 1e-12,
      `expected ${expected}, got ${conf(db, 'm')}`);
  });

  it('trusted sources decay slower via stability but never freeze', () => {
    seed(db, 'corrected', { source: 'corrected', confidence: 0.7 });
    seed(db, 'learned', { source: 'learned', confidence: 0.7 });

    // Ten daily 1-day increments past the grace period — under the old
    // min(1, sourceMult × e^(−t/S)) form, corrected (×1.5) froze entirely
    // on small increments. Under stability-folding it must still decay.
    let prev = 0.7;
    for (let day = 8; day <= 17; day++) {
      applyConfidenceDecay(db, T0 + day * DAY);
      const c = conf(db, 'corrected');
      assert.ok(c < prev, `corrected must strictly decrease each run (day ${day}: ${c} vs ${prev})`);
      prev = c;
    }

    // S_corrected = 60 × 1.5 = 90; total charge 10d
    const expectedCorrected = 0.7 * Math.exp(-10 / (STABILITY_BY_KIND.pitfall * 1.5));
    assert.ok(Math.abs(conf(db, 'corrected') - expectedCorrected) < 1e-9);
    assert.ok(conf(db, 'corrected') > conf(db, 'learned'),
      'corrected must retain more than learned at equal age');
  });

  it('floors a recalled memory at DELETE_THRESHOLD and keeps it', () => {
    // A memory that has EVER been recalled is exempt from the dead-tail prune,
    // so it floors at the threshold and survives.
    seed(db, 'm', { confidence: 0.12, recallCount: 3 });
    applyConfidenceDecay(db, T0 + 365 * DAY);
    assert.equal(conf(db, 'm'), CONFIDENCE.DELETE_THRESHOLD);
  });

  it('prunes a floored, never-recalled, old memory as clearly dead', () => {
    seed(db, 'dead', { kind: 'fact', confidence: 0.12 }); // recallCount 0, created at T0
    applyConfidenceDecay(db, T0 + (DECAY.PRUNE_DEAD_AGE_DAYS + 5) * DAY);
    const count = (db.prepare('SELECT COUNT(*) AS n FROM memories WHERE id = ?').get('dead') as { n: number }).n;
    assert.equal(count, 0, 'floored + never-recalled + old is pruned');
  });

  it('keeps a floored, never-recalled memory younger than the prune age', () => {
    seed(db, 'young', { kind: 'fact', confidence: 0.12 });
    applyConfidenceDecay(db, T0 + (DECAY.PRUNE_DEAD_AGE_DAYS - 5) * DAY);
    assert.equal(conf(db, 'young'), CONFIDENCE.DELETE_THRESHOLD, 'too young to prune — kept at the floor');
  });

  it('never prunes protected kinds (decision/user_profile) even when old and never recalled', () => {
    seed(db, 'dec', { kind: 'decision', confidence: 0.12 });
    seed(db, 'prof', { kind: 'user_profile', confidence: 0.12 });
    applyConfidenceDecay(db, T0 + (DECAY.PRUNE_DEAD_AGE_DAYS + 100) * DAY);
    const count = (id: string): number => (db.prepare('SELECT COUNT(*) AS n FROM memories WHERE id = ?').get(id) as { n: number }).n;
    assert.equal(count('dec'), 1, 'decisions are exempt from the dead-tail prune');
    assert.equal(count('prof'), 1, 'user_profile is exempt from the dead-tail prune');
  });

  it('caps a single prune run at CLEANUP_MAX_DELETE and drains the tail across runs', () => {
    // A large accumulated dead tail must not vanish in one uncapped shot: the
    // prune mirrors cairn_cleanup's cap, bounding blast radius and spreading the
    // purge across maintenance cycles so borderline rows get more chances to be
    // recalled (which exempts them) before removal.
    const total = LIMITS.CLEANUP_MAX_DELETE + 20;
    for (let i = 0; i < total; i++) seed(db, `dead-${i}`, { kind: 'fact', confidence: 0.12 });
    const remaining = (): number =>
      (db.prepare("SELECT COUNT(*) AS n FROM memories WHERE id LIKE 'dead-%'").get() as { n: number }).n;

    applyConfidenceDecay(db, T0 + (DECAY.PRUNE_DEAD_AGE_DAYS + 5) * DAY);
    assert.equal(remaining(), total - LIMITS.CLEANUP_MAX_DELETE, 'first run prunes at most the cap');

    applyConfidenceDecay(db, T0 + (DECAY.PRUNE_DEAD_AGE_DAYS + 6) * DAY);
    assert.equal(remaining(), 0, 'a second run drains the rest of the dead tail');
  });

  it('skips malformed timestamps without writing NaN', () => {
    db.prepare(`
      INSERT INTO memories (id, content, kind, project, tags, confidence, source, created_at, recall_count, invalidated)
      VALUES ('bad', 'bad timestamp', 'pitfall', 'proj', '[]', 0.6, 'learned', 'not-a-date', 0, 0)
    `).run();
    applyConfidenceDecay(db, T0 + 30 * DAY);
    assert.equal(conf(db, 'bad'), 0.6);
  });

  it('deletes below-threshold memories but exempts corrections', () => {
    seed(db, 'doomed', { kind: 'fact', confidence: 0.05 });
    seed(db, 'kept-correction', { kind: 'correction', confidence: 0.05 });
    applyConfidenceDecay(db, T0);
    const count = (id: string): number =>
      (db.prepare('SELECT COUNT(*) AS n FROM memories WHERE id = ?').get(id) as { n: number }).n;
    assert.equal(count('doomed'), 0);
    assert.equal(count('kept-correction'), 1);
  });
});

describe('runMaintenance rate gate', () => {
  it('skips within the interval, runs after it, and force overrides', () => {
    const first = runMaintenance(db, 's', { nowMs: T0 });
    assert.ok(!first.skipped, 'first run must execute');

    const tooSoon = runMaintenance(db, 's', { nowMs: T0 + 3_600_000 });
    assert.equal(tooSoon.skipped, true, 'run within the interval must be skipped');

    const forced = runMaintenance(db, 's', { nowMs: T0 + 2 * 3_600_000, force: true });
    assert.ok(!forced.skipped, 'force must bypass the gate');

    const later = runMaintenance(db, 's', {
      nowMs: T0 + (DECAY.MAINTENANCE_MIN_INTERVAL_HOURS + 11) * 3_600_000,
    });
    assert.ok(!later.skipped, 'run after the interval must execute');
  });

  it('expires TTL memories even on gated runs — they must not surface via tag or briefing recall', () => {
    // Prime the gate so the next run is skipped
    runMaintenance(db, 's', { nowMs: T0 });

    db.prepare(`
      INSERT INTO memories (id, content, kind, project, tags, confidence, source, created_at, recall_count, invalidated, expires_at)
      VALUES ('ttl-mem', 'expiring pitfall about ttltag', 'pitfall', 'proj', '["ttltag"]', 0.9, 'learned', ?, 0, 0, ?)
    `).run(new Date(T0).toISOString(), new Date(T0 + 3_600_000).toISOString());

    const repo = new MemoryRepository(db);
    assert.equal(repo.recallByTags(['ttltag'], { project: 'proj' }).length, 1,
      'control: unexpired memory is tag-recallable');

    // Gated run 2h later — past the memory's expiry, inside the gate interval
    const gated = runMaintenance(db, 's', { nowMs: T0 + 2 * 3_600_000 });
    assert.equal(gated.skipped, true, 'run must be gated');
    assert.equal(gated.expired, 1, 'TTL expiration must run before the gate');

    assert.equal(repo.findById('ttl-mem'), null, 'expired memory must be deleted');
    assert.equal(repo.recallByTags(['ttltag'], { project: 'proj' }).length, 0,
      'expired memory must not surface via tag recall');
    assert.equal(repo.topPitfalls('proj', 5).length, 0,
      'expired memory must not surface via briefing pitfalls');
  });
});

describe('v25 migration', () => {
  it('backfills last_decayed_at to now so the first post-migration run charges nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cairn-mig-'));
    const dbPath = join(dir, 'test.db');
    try {
      // Build a v24-shaped store: create fresh, then strip the v25, v26,
      // AND v27 surfaces (the rewind must remove every post-v24 object or
      // the re-migration hits duplicate errors).
      let fileDb = openDatabase({ dbPath });
      stripV27Surface(fileDb);
      fileDb.exec('ALTER TABLE memories DROP COLUMN last_decayed_at');
      fileDb.exec('ALTER TABLE memories DROP COLUMN embedding_model');
      fileDb.exec('ALTER TABLE context_vectors DROP COLUMN embedding_model');
      fileDb.exec('DROP TABLE maintenance_meta');
      fileDb.prepare('UPDATE schema_version SET version = 24').run();
      fileDb.prepare(`
        INSERT INTO memories (id, content, kind, project, tags, confidence, source, created_at, recall_count, invalidated)
        VALUES ('old', 'sixty days old', 'pitfall', 'proj', '[]', 0.5, 'learned', ?, 0, 0)
      `).run(new Date(Date.now() - 60 * DAY).toISOString());
      fileDb.close();

      // Reopen — migrates 24 → 25
      fileDb = openDatabase({ dbPath });
      const version = (fileDb.prepare('SELECT version FROM schema_version').get() as { version: number }).version;
      assert.ok(version >= 25, `migration must reach at least v25 (got ${version})`);

      const row = fileDb.prepare("SELECT last_decayed_at FROM memories WHERE id = 'old'").get() as { last_decayed_at: string | null };
      assert.ok(row.last_decayed_at, 'migration must backfill last_decayed_at');

      // The old model would charge 60 days here and crush the memory again.
      const { decayed } = applyConfidenceDecay(fileDb);
      assert.equal(decayed, 0, 'first post-migration run must charge nothing');
      const c = (fileDb.prepare("SELECT confidence FROM memories WHERE id = 'old'").get() as { confidence: number }).confidence;
      assert.equal(c, 0.5);
      fileDb.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
