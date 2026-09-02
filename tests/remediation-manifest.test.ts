/**
 * Step-4 remediation instrument tests (remediation plan, mechanism M4).
 *
 * The script is the instrument that will write to the live store ONCE —
 * these gates prove, on a fixture, that it classifies by the current
 * capture shapes, refuses unresolved manifests, skips drifted rows, leaves
 * the complete look-alike untouched, and gives replacements zero inherited
 * telemetry at the ancestor's live confidence.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/db/connection.js';
import { MemoryRepository } from '../src/db/memory-repository.js';

const SCRIPT = join(process.cwd(), 'scripts', 'remediate-truncated.mjs');
const pad200 = (stem: string): string => {
  const body = stem.padEnd(197, ' x').slice(0, 197);
  return `${body}...`;
};

let dir: string;
let dbPath: string;

const run = (args: string[]) => execFileSync('node', [SCRIPT, ...args], { encoding: 'utf8' });
/** Like run(), but tolerates the script's deliberate non-zero drift exit and
 *  returns stdout either way. */
const runTolerant = (args: string[]): string => {
  try { return run(args); } catch (e) {
    const err = e as { stdout?: string; status?: number };
    if (err.status === 1 && err.stdout) return err.stdout; // drift exit — by design
    throw e;
  }
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'remediation-test-'));
  dbPath = join(dir, 'fixture.db');
  const db = openDatabase({ dbPath });
  const repo = new MemoryRepository(db);
  // 1: trigger-absent decision (no capture pattern in the prefix)
  db.prepare(`INSERT INTO memories (id, content, kind, project, tags, confidence, source, created_at, updated_at, recall_count, invalidated)
    VALUES ('row-absent', ?, 'decision', 'proj-f', '[]', 0.65, 'learned', '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z', 36, 0)`)
    .run(pad200('so i am back now as we lost connection but before we resume i want us to organise the project'));
  // 2: correction row (raw prompt)
  db.prepare(`INSERT INTO memories (id, content, kind, project, tags, confidence, source, created_at, updated_at, recall_count, invalidated)
    VALUES ('row-corr', ?, 'correction', NULL, '[]', 0.9, 'user', '2026-08-02T00:00:00Z', '2026-08-02T00:00:00Z', 12, 0)`)
    .run(pad200('check if the daemon hung again and restart it if needed then continue where you left off'));
  // 3: trigger-present decision (a real chose-because, truncated) at decayed confidence
  db.prepare(`INSERT INTO memories (id, content, kind, project, tags, confidence, source, created_at, updated_at, recall_count, invalidated)
    VALUES ('row-present', ?, 'decision', 'proj-f', '[]', 0.31, 'learned', '2026-08-03T00:00:00Z', '2026-08-03T00:00:00Z', 4, 0)`)
    .run(pad200('chose fixture replacements over resurrection because decayed standing must carry forward into the fresh row'));
  // 4: complete look-alike — exactly 200 chars but NOT ending '...'
  db.prepare(`INSERT INTO memories (id, content, kind, project, tags, confidence, source, created_at, updated_at, recall_count, invalidated)
    VALUES ('row-complete', ?, 'decision', 'proj-f', '[]', 0.8, 'user', '2026-08-04T00:00:00Z', '2026-08-04T00:00:00Z', 100, 0)`)
    .run('chose a complete two-hundred character decision row over a truncated one because the signature requires the ellipsis tail and this row ends with a full clause of exactly the right length for it!');
  // 5: ordinary short row
  repo.create({ content: 'ordinary short row far from the signature', kind: 'fact', project: 'proj-f' });
  db.close();
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('step-4 remediation instrument', () => {
  it('classifies by the current capture shapes and excludes complete look-alikes', () => {
    const mPath = join(dir, 'manifest.json');
    run(['--manifest', mPath, '--db', dbPath]);
    const m = JSON.parse(readFileSync(mPath, 'utf8'));
    assert.equal(m.rows.length, 3, 'exactly the signature rows — the complete 200-char row is NOT one');
    const byId = Object.fromEntries(m.rows.map((r: { id: string }) => [r.id, r]));
    assert.equal(byId['row-absent'].action, 'invalidate');
    assert.equal(byId['row-absent'].bucket, 'trigger_absent');
    assert.equal(byId['row-corr'].action, 'invalidate');
    assert.equal(byId['row-corr'].bucket, 'correction');
    assert.equal(byId['row-present'].action, 'hand_review');
    assert.equal(byId['row-present'].bucket, 'trigger_present');
    assert.ok(!('row-complete' in byId));
  });

  it('REFUSES to apply while any row is still hand_review', () => {
    const mPath = join(dir, 'manifest.json');
    run(['--manifest', mPath, '--db', dbPath]);
    assert.throws(() => run(['--apply', mPath, '--live', '--target', dbPath]),
      /REFUSED.*hand_review/s);
  });

  it('a replacement NEVER writes outside the manifest — no dedup merge, no conflict edges (codex fold)', () => {
    const mPath = join(dir, 'manifest.json');
    run(['--manifest', mPath, '--db', dbPath]);
    const m = JSON.parse(readFileSync(mPath, 'utf8'));
    for (const r of m.rows) {
      if (r.action === 'hand_review') {
        r.action = 'invalidate';
        r.replacement = { content: 'chose fixture replacements over resurrection because decayed standing must carry forward' };
      }
    }
    writeFileSync(mPath, JSON.stringify(m));
    // An ACTIVE near-duplicate that a plain storeDecision would dedup-merge
    // into (boosting its confidence — a write outside the manifest).
    const db0 = openDatabase({ dbPath });
    const bait = new MemoryRepository(db0).create({
      content: 'chose fixture replacements over resurrection because decayed standing must carry onward',
      kind: 'decision', project: 'proj-f', confidence: 0.5, skipDedup: true,
    });
    db0.close();

    runTolerant(['--apply', mPath, '--live', '--target', dbPath]);

    const db = openDatabase({ dbPath });
    const baitRow = db.prepare('SELECT confidence, content FROM memories WHERE id = ?').get(bait.id) as { confidence: number; content: string };
    assert.ok(Math.abs(baitRow.confidence - 0.5) < 1e-9, 'the bait row must be UNTOUCHED — no dedup merge');
    const repls = db.prepare("SELECT id FROM memories WHERE content = 'chose fixture replacements over resurrection because decayed standing must carry forward' AND invalidated = 0").all();
    assert.equal(repls.length, 1, 'the replacement is its own fresh row');
    const edges = db.prepare('SELECT COUNT(*) AS n FROM memory_edges WHERE source_id = ? OR target_id = ?').get((repls[0] as { id: string }).id, (repls[0] as { id: string }).id) as { n: number };
    assert.equal(edges.n, 0, 'no conflict/contradiction edges minted by the apply');
    db.close();
  });

  it('REFUSES when the live store has signature rows the manifest never saw (codex fold)', () => {
    const mPath = join(dir, 'manifest.json');
    run(['--manifest', mPath, '--db', dbPath]);
    const m = JSON.parse(readFileSync(mPath, 'utf8'));
    for (const r of m.rows) if (r.action === 'hand_review') r.action = 'invalidate';
    writeFileSync(mPath, JSON.stringify(m));
    // A NEW signature row appears after the manifest was built.
    const db0 = openDatabase({ dbPath });
    db0.prepare(`INSERT INTO memories (id, content, kind, project, tags, confidence, source, created_at, updated_at, recall_count, invalidated)
      VALUES ('row-new-sig', ?, 'decision', 'proj-f', '[]', 0.65, 'learned', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z', 0, 0)`)
      .run(pad200('a brand new truncation-signature row that appeared after the manifest was built and must block'));
    db0.close();
    assert.throws(() => run(['--apply', mPath, '--live', '--target', dbPath]),
      /UNKNOWN signature row|REFUSED/s);
    // Nothing was applied.
    const db = openDatabase({ dbPath });
    const inv = (db.prepare('SELECT COUNT(*) AS n FROM memories WHERE invalidated = 1').get() as { n: number }).n;
    assert.equal(inv, 0, 'preflight refusal must leave the store untouched');
    db.close();
  });

  it('--verify exits nonzero on signature residue and validates replacements via the receipt (codex fold)', () => {
    const mPath = join(dir, 'manifest.json');
    run(['--manifest', mPath, '--db', dbPath]);
    const m = JSON.parse(readFileSync(mPath, 'utf8'));
    for (const r of m.rows) {
      if (r.action === 'hand_review') {
        r.action = 'invalidate';
        r.replacement = { content: 'chose fixture replacements over resurrection because decayed standing must carry forward' };
      }
    }
    writeFileSync(mPath, JSON.stringify(m));
    const receiptPath = join(dir, 'receipt.json');
    runTolerant(['--apply', mPath, '--live', '--target', dbPath, '--receipt', receiptPath]);

    // Clean state verifies green, including receipt checks.
    const outOk = run(['--verify', mPath, '--target', dbPath, '--receipt', receiptPath]);
    assert.match(outOk, /0 mismatch; signature rows still active: 0/);

    // Plant residue: a fresh signature row → verify must exit 1.
    const db0 = openDatabase({ dbPath });
    db0.prepare(`INSERT INTO memories (id, content, kind, project, tags, confidence, source, created_at, updated_at, recall_count, invalidated)
      VALUES ('row-residue', ?, 'decision', 'proj-f', '[]', 0.65, 'learned', '2026-09-02T00:00:00Z', '2026-09-02T00:00:00Z', 0, 0)`)
      .run(pad200('planted residue row proving verify fails closed on any new signature row in the store'));
    db0.close();
    assert.throws(() => run(['--verify', mPath, '--target', dbPath, '--receipt', receiptPath]), /RESIDUE|Command failed/s);
  });

  it('applies invalidations + replacement with zero telemetry at the live confidence; skips drifted rows', () => {
    const mPath = join(dir, 'manifest.json');
    run(['--manifest', mPath, '--db', dbPath]);
    const m = JSON.parse(readFileSync(mPath, 'utf8'));
    for (const r of m.rows) {
      if (r.action === 'hand_review') {
        r.action = 'invalidate';
        r.replacement = { content: 'chose fixture replacements over resurrection because decayed standing must carry forward' };
      }
    }
    writeFileSync(mPath, JSON.stringify(m));

    // Drift one row AFTER the manifest: it must be skipped, not clobbered.
    {
      const db = openDatabase({ dbPath });
      db.prepare("UPDATE memories SET content = 'edited after manifest — no longer the manifested bytes' WHERE id = 'row-corr'").run();
      db.close();
    }

    const out = runTolerant(['--apply', mPath, '--live', '--target', dbPath]);
    assert.match(out, /DRIFTED\s+row-corr/);

    const db = openDatabase({ dbPath });
    const inv = (id: string) => (db.prepare('SELECT invalidated FROM memories WHERE id = ?').get(id) as { invalidated: number }).invalidated;
    assert.equal(inv('row-absent'), 1, 'trigger-absent invalidated');
    assert.equal(inv('row-present'), 1, 'resolved hand-review invalidated');
    assert.equal(inv('row-corr'), 0, 'drifted row untouched');
    assert.equal(inv('row-complete'), 0, 'complete look-alike untouched');
    const repl = db.prepare("SELECT confidence, recall_count, invalidated FROM memories WHERE content LIKE 'chose fixture replacements%' AND invalidated = 0 AND length(content) < 200").get() as { confidence: number; recall_count: number; invalidated: number };
    assert.ok(repl, 'replacement row stored');
    assert.equal(repl.recall_count, 0, 'zero inherited telemetry');
    assert.ok(Math.abs(repl.confidence - 0.31) < 1e-9, "replacement carries the ancestor's live confidence — no resurrection");
    db.close();
  });
});
