/**
 * Codex parity Slice B — rollout tailer (zero-config capture fallback).
 * First sight of a file starts at EOF (no backfill); appended failed
 * CommandExecutions route through the demux; hook-path seen-markers make
 * the tailer quiescent; subagent threads are skipped.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHookDbClient, type HookDbClient } from '../src/hooks/shared/db-client.js';
import { startRolloutTailer } from '../src/daemon/rollout-tailer.js';

// Classifier dedup state persists across runs (by design) — every learnable
// error in these tests carries a per-run tag so keys never collide.
const RUN = Math.random().toString(36).slice(2, 8);

let root: string;
let dayDir: string;
let client: HookDbClient;

before(() => {
  root = mkdtempSync(join(tmpdir(), 'cairn-tailer-'));
  const d = new Date();
  dayDir = join(root,
    String(d.getFullYear()),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'));
  mkdirSync(dayDir, { recursive: true });
  process.env.CAIRN_CODEX_SESSIONS_DIR = root;
  client = createHookDbClient(':memory:');
});

after(() => {
  delete process.env.CAIRN_CODEX_SESSIONS_DIR;
  client.close();
  rmSync(root, { recursive: true, force: true });
});

function metaLine(sessionId: string, opts: { subagent?: boolean } = {}): string {
  return JSON.stringify({
    timestamp: new Date().toISOString(), type: 'session_meta',
    payload: {
      session_id: sessionId, id: sessionId, cwd: '/opt/cairn',
      originator: 'codex_exec', cli_version: '0.150.1',
      ...(opts.subagent ? { source: { subagent: { other: 'guardian' } } } : {}),
    },
  }) + '\n';
}

function failedCommandLine(id: string, errText: string): string {
  return JSON.stringify({
    timestamp: new Date().toISOString(), type: 'event_msg',
    payload: {
      type: 'item_completed',
      item: { item: {
        id, type: 'CommandExecution', status: 'failed', exit_code: 2,
        command: ['bash', '-c', 'tsc'], aggregated_output: errText, stdout: '', stderr: '',
      } },
    },
  }) + '\n';
}

describe('rollout tailer', () => {
  it('starts at EOF on first sight, then routes appended failures to a codex pitfall', async () => {
    const f = join(dayDir, 'rollout-2026-08-28T00-00-01-tailer-a.jsonl');
    writeFileSync(f, metaLine('tailer-sess-a') +
      failedCommandLine('exec-historic', `error TS2998: HIST-${RUN} historic — must NOT be captured`));

    // Negative slack forces the pre-existing classification: birthtimes
    // cannot be backdated, and this file was written milliseconds ago.
    const tailer = startRolloutTailer({ ...client, cache: undefined }, { birthtimeSlackMs: -3_600_000 });
    try {
      // Tick 1: registration only — the historic failure is behind EOF.
      assert.equal(await tailer.tick(), 0);

      appendFileSync(f, failedCommandLine('exec-live-1', `error TS2997: TAILER-A-${RUN} live type mismatch in tailer-check.ts`));
      const processed = await tailer.tick();
      assert.equal(processed, 1);

      const rows = client.db.prepare(
        "SELECT origin_client, content FROM memories WHERE kind='pitfall' AND content LIKE '%TAILER-A-' || ? || '%'",
      ).all(RUN) as Array<{ origin_client: string; content: string }>;
      assert.equal(rows.length, 1);
      assert.equal(rows[0].origin_client, 'codex');

      const historic = client.db.prepare(
        "SELECT COUNT(*) AS n FROM memories WHERE content LIKE '%HIST-' || ? || '%'",
      ).get(RUN) as { n: number };
      assert.equal(historic.n, 0);
    } finally {
      tailer.stop();
    }
  });

  it('skips ids the hook path already marked seen (quiesce)', async () => {
    const f = join(dayDir, 'rollout-2026-08-28T00-00-02-tailer-b.jsonl');
    writeFileSync(f, metaLine('tailer-sess-b'));
    const tailer = startRolloutTailer({ ...client, cache: undefined });
    try {
      await tailer.tick(); // register at EOF
      client.db.prepare('INSERT OR REPLACE INTO maintenance_meta (key, value) VALUES (?, ?)')
        .run('codex_seen:exec-hook-handled', new Date().toISOString());
      appendFileSync(f, failedCommandLine('exec-hook-handled', `error TS2996: TAILER-B-${RUN} already handled by hook`));
      assert.equal(await tailer.tick(), 0);
      const rows = client.db.prepare(
        "SELECT COUNT(*) AS n FROM memories WHERE content LIKE '%TAILER-B-' || ? || '%'",
      ).get(RUN) as { n: number };
      assert.equal(rows.n, 0);
    } finally {
      tailer.stop();
    }
  });

  it('skips subagent/guardian threads entirely', async () => {
    const f = join(dayDir, 'rollout-2026-08-28T00-00-03-tailer-c.jsonl');
    writeFileSync(f, metaLine('tailer-sess-c', { subagent: true }));
    const tailer = startRolloutTailer({ ...client, cache: undefined });
    try {
      await tailer.tick();
      appendFileSync(f, failedCommandLine('exec-subagent', `error TS2995: TAILER-C-${RUN} subagent failure`));
      assert.equal(await tailer.tick(), 0);
    } finally {
      tailer.stop();
    }
  });

  it('captures a failure whose line exceeds the lookup window (pre-resolved record path)', async () => {
    // Regression for review fix 3: the tailer passes the record it parsed
    // instead of re-looking it up in a tail window it may have outrun.
    const f = join(dayDir, 'rollout-2026-08-28T00-00-05-tailer-e.jsonl');
    writeFileSync(f, metaLine('tailer-sess-e'));
    const tailer = startRolloutTailer({ ...client, cache: undefined });
    try {
      await tailer.tick();
      // Lexically distant from the other tests' errors — similar wording
      // would dedup-merge into an earlier pitfall in this shared DB and the
      // row assertion below would see nothing.
      const bigOutput = `error TS2992: TAILER-E-${RUN} colossal aggregated payload exceeded scanning window budget in window-scan.ts\n` + 'y'.repeat(700 * 1024);
      appendFileSync(f, JSON.stringify({
        timestamp: new Date().toISOString(), type: 'event_msg',
        payload: { type: 'item_completed', item: { item: {
          id: 'exec-big-tail', type: 'CommandExecution', status: 'failed',
          exit_code: 2, command: ['tsc'], aggregated_output: bigOutput,
        } } },
      }) + '\n');
      assert.equal(await tailer.tick(), 1);
      const rows = client.db.prepare(
        "SELECT origin_client FROM memories WHERE kind='pitfall' AND content LIKE '%TAILER-E-' || ? || '%'",
      ).all(RUN) as Array<{ origin_client: string }>;
      assert.equal(rows.length, 1);
      assert.equal(rows[0].origin_client, 'codex');
    } finally {
      tailer.stop();
    }
  });

  it('recovers a file first seen EMPTY once its session_meta flushes', async () => {
    // Regression for review fix 4: an unreadable meta at first sight must
    // not skip the session permanently.
    const f = join(dayDir, 'rollout-2026-08-28T00-00-06-tailer-f.jsonl');
    writeFileSync(f, ''); // Codex created the file; nothing flushed yet
    const tailer = startRolloutTailer({ ...client, cache: undefined });
    try {
      assert.equal(await tailer.tick(), 0); // registers, meta unresolved
      appendFileSync(f, metaLine('tailer-sess-f') +
        failedCommandLine('exec-after-empty', `error TS2991: TAILER-F-${RUN} failure after empty first sight`));
      assert.equal(await tailer.tick(), 1);
      const rows = client.db.prepare(
        "SELECT COUNT(*) AS n FROM memories WHERE content LIKE '%TAILER-F-' || ? || '%'",
      ).get(RUN) as { n: number };
      assert.equal(rows.n, 1);
    } finally {
      tailer.stop();
    }
  });

  it('tails failed FileChange records as apply_patch events', async () => {
    const f = join(dayDir, 'rollout-2026-08-28T00-00-07-tailer-g.jsonl');
    writeFileSync(f, metaLine('tailer-sess-g'));
    const tailer = startRolloutTailer({ ...client, cache: undefined });
    try {
      await tailer.tick();
      appendFileSync(f, JSON.stringify({
        timestamp: new Date().toISOString(), type: 'event_msg',
        payload: { type: 'item_completed', item: { item: {
          id: 'exec-patch-fail', type: 'FileChange', status: 'failed',
          aggregated_output: `error TS2990: TAILER-G-${RUN} patch context mismatch in patched.ts`,
        } } },
      }) + '\n');
      assert.equal(await tailer.tick(), 1);
      const rows = client.db.prepare(
        "SELECT COUNT(*) AS n FROM memories WHERE content LIKE '%TAILER-G-' || ? || '%'",
      ).get(RUN) as { n: number };
      assert.equal(rows.n, 1);
    } finally {
      tailer.stop();
    }
  });

  it('captures from byte 0 in files BORN AFTER the tailer started (no early-command loss)', async () => {
    // No-backfill is for files that predate the tailer; a session that
    // starts after it has no history to skip, and its first commands must
    // not be lost to poll timing.
    const tailer = startRolloutTailer({ ...client, cache: undefined });
    try {
      const f = join(dayDir, 'rollout-2026-08-28T00-00-08-tailer-h.jsonl');
      writeFileSync(f, metaLine('tailer-sess-h') +
        failedCommandLine('exec-early', `error TS2989: TAILER-H-${RUN} instantaneous ignition fault in early-bird.ts`));
      assert.equal(await tailer.tick(), 1, 'captured on FIRST sight');
      const rows = client.db.prepare(
        "SELECT COUNT(*) AS n FROM memories WHERE content LIKE '%TAILER-H-' || ? || '%'",
      ).get(RUN) as { n: number };
      assert.equal(rows.n, 1);
    } finally {
      tailer.stop();
    }
  });

  it('an unknown cli_version is a log-only canary — capture continues', async () => {
    const tailer = startRolloutTailer({ ...client, cache: undefined });
    try {
      const f = join(dayDir, 'rollout-2026-08-28T00-00-09-tailer-i.jsonl');
      const meta = JSON.stringify({
        timestamp: new Date().toISOString(), type: 'session_meta',
        payload: { session_id: 'tailer-sess-i', id: 'tailer-sess-i', cwd: '/opt/cairn', originator: 'codex_exec', cli_version: '9.9.9' },
      }) + '\n';
      writeFileSync(f, meta +
        failedCommandLine('exec-futurever', `error TS2988: TAILER-I-${RUN} chronoflux divergence in future-version.ts`));
      assert.equal(await tailer.tick(), 1, 'future version still captures');
    } finally {
      tailer.stop();
    }
  });

  it('leaves a torn tail line for the next tick, then consumes it once complete', async () => {
    const f = join(dayDir, 'rollout-2026-08-28T00-00-04-tailer-d.jsonl');
    writeFileSync(f, metaLine('tailer-sess-d'));
    const tailer = startRolloutTailer({ ...client, cache: undefined });
    try {
      await tailer.tick();
      const full = failedCommandLine('exec-torn', `error TS2994: TAILER-D-${RUN} torn line`);
      appendFileSync(f, full.slice(0, 40)); // torn mid-write
      assert.equal(await tailer.tick(), 0);
      appendFileSync(f, full.slice(40)); // writer finishes the line
      assert.equal(await tailer.tick(), 1);
    } finally {
      tailer.stop();
    }
  });
});
