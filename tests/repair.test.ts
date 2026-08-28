/**
 * Confidence repair — evidence gating, targets, and dry-run safety.
 * Repair lifts only outcome-evidenced memories (impact, human provenance, or
 * session success); recalled-but-never-impactful rows go to the review CSV.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type Database from 'better-sqlite3';
import { openDatabase } from '../src/db/connection.js';
import { analyzeRepair, executeRepair, toReviewCsv } from '../src/db/repair.js';
import { REPAIR } from '../src/constants/index.js';

interface SeedOptions {
  kind?: string;
  confidence?: number;
  source?: string;
  impactCount?: number;
  recallCount?: number;
  invalidated?: number;
  supersededBy?: string | null;
  content?: string;
}

function seed(db: Database.Database, id: string, opts: SeedOptions = {}): void {
  db.prepare(`
    INSERT INTO memories (id, content, kind, project, tags, confidence, source,
      created_at, recall_count, invalidated, impact_count, superseded_by)
    VALUES (?, ?, ?, 'proj', '[]', ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, opts.content ?? `content for ${id}`, opts.kind ?? 'fact',
    opts.confidence ?? 0.2, opts.source ?? 'learned',
    new Date().toISOString(), opts.recallCount ?? 0,
    opts.invalidated ?? 0, opts.impactCount ?? 0, opts.supersededBy ?? null,
  );
}

function conf(db: Database.Database, id: string): number {
  return (db.prepare('SELECT confidence FROM memories WHERE id = ?').get(id) as { confidence: number }).confidence;
}

let db: Database.Database;

beforeEach(() => {
  db = openDatabase({ dbPath: ':memory:' });
  seed(db, 'impacted', { kind: 'pitfall', confidence: 0.15, impactCount: 2 });
  seed(db, 'user-fact', { confidence: 0.2, source: 'user' });
  seed(db, 'session-win', { kind: 'decision', confidence: 0.3 });
  db.prepare(`
    INSERT INTO session_memories (session_id, memory_id, led_to_success)
    VALUES ('s1', 'session-win', 1)
  `).run();
  seed(db, 'recalled-only', { confidence: 0.3, recallCount: 3 });
  seed(db, 'healthy', { kind: 'pitfall', confidence: 0.8, impactCount: 5 });
  seed(db, 'invalid', { confidence: 0.1, impactCount: 3, invalidated: 1 });
  seed(db, 'never-touched', { confidence: 0.3 });
  seed(db, 'retired', { confidence: 0.1, impactCount: 3, supersededBy: 'healthy' });
});

afterEach(() => { db.close(); });

describe('analyzeRepair', () => {
  it('selects only evidence-backed memories below their kind target', () => {
    const { candidates } = analyzeRepair(db);
    const byId = new Map(candidates.map(c => [c.id, c]));

    assert.equal(byId.get('impacted')?.reason, 'impact');
    assert.equal(byId.get('impacted')?.target, REPAIR.TARGETS.pitfall);
    assert.equal(byId.get('user-fact')?.reason, 'provenance');
    assert.equal(byId.get('user-fact')?.target, REPAIR.TARGETS.fact);
    assert.equal(byId.get('session-win')?.reason, 'session-success');

    assert.ok(!byId.has('healthy'), 'above-target memories are not candidates');
    assert.ok(!byId.has('invalid'), 'invalidated memories are excluded');
    assert.ok(!byId.has('retired'), 'superseded memories are excluded');
    assert.ok(!byId.has('recalled-only'), 'recall exposure alone is not evidence');
    assert.ok(!byId.has('never-touched'), 'no evidence, no lift');
    assert.equal(candidates.length, 3);
  });

  it('routes recalled-but-never-impactful memories to review, not repair', () => {
    const { review } = analyzeRepair(db);
    assert.equal(review.length, 1);
    assert.equal(review[0].id, 'recalled-only');
  });

  it('mutates nothing', () => {
    analyzeRepair(db);
    assert.equal(conf(db, 'impacted'), 0.15);
    assert.equal(conf(db, 'user-fact'), 0.2);
  });
});

describe('executeRepair', () => {
  it('lifts candidates to their targets and resets the decay epoch', () => {
    const analysis = analyzeRepair(db);
    const { repaired } = executeRepair(db, analysis, Date.UTC(2026, 6, 20));

    assert.equal(repaired, 3);
    assert.equal(conf(db, 'impacted'), REPAIR.TARGETS.pitfall);
    assert.equal(conf(db, 'user-fact'), REPAIR.TARGETS.fact);
    assert.equal(conf(db, 'session-win'), REPAIR.TARGETS.decision);
    assert.equal(conf(db, 'recalled-only'), 0.3, 'review cohort untouched');
    assert.equal(conf(db, 'healthy'), 0.8, 'healthy memories untouched');

    const row = db.prepare("SELECT last_decayed_at FROM memories WHERE id = 'impacted'").get() as { last_decayed_at: string | null };
    assert.equal(row.last_decayed_at, new Date(Date.UTC(2026, 6, 20)).toISOString(),
      'repair must reset the decay epoch or the next run re-crushes the memory');
  });

  it('never lowers a memory concurrently boosted above its target (TOCTOU)', () => {
    const analysis = analyzeRepair(db);
    // Between analysis and execution, someone strengthens the memory past the target
    db.prepare("UPDATE memories SET confidence = 0.9 WHERE id = 'impacted'").run();

    const { repaired } = executeRepair(db, analysis);
    assert.equal(conf(db, 'impacted'), 0.9, 'stale analysis must not lower a boosted memory');
    assert.equal(repaired, 2, 'boosted memory no longer counts as repaired');
  });

  it('skips memories superseded between analysis and execution', () => {
    const analysis = analyzeRepair(db);
    db.prepare("UPDATE memories SET superseded_by = 'healthy' WHERE id = 'user-fact'").run();

    const { repaired } = executeRepair(db, analysis);
    assert.equal(conf(db, 'user-fact'), 0.2, 'superseded memory must not be lifted');
    assert.equal(repaired, 2);
  });
});

describe('toReviewCsv', () => {
  it('escapes quotes and commas in content', () => {
    const csv = toReviewCsv([{
      id: 'x', kind: 'fact', project: 'p', confidence: 0.3, recall_count: 2,
      content: 'says "hello", twice',
    }]);
    assert.ok(csv.startsWith('id,kind,project,confidence,recall_count,content\n'));
    assert.ok(csv.includes('"says ""hello"", twice"'));
  });
});
