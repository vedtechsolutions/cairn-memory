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
      failedCommandLine('exec-historic', 'error TS2998: historic — must NOT be captured'));

    const tailer = startRolloutTailer({ ...client, cache: undefined });
    try {
      // Tick 1: registration only — the historic failure is behind EOF.
      assert.equal(await tailer.tick(), 0);

      appendFileSync(f, failedCommandLine('exec-live-1', 'error TS2997: TAILER-A live type mismatch in tailer-check.ts'));
      const processed = await tailer.tick();
      assert.equal(processed, 1);

      const rows = client.db.prepare(
        "SELECT origin_client, content FROM memories WHERE kind='pitfall' AND content LIKE '%TS2997%'",
      ).all() as Array<{ origin_client: string; content: string }>;
      assert.equal(rows.length, 1);
      assert.equal(rows[0].origin_client, 'codex');

      const historic = client.db.prepare(
        "SELECT COUNT(*) AS n FROM memories WHERE content LIKE '%TS2998%'",
      ).get() as { n: number };
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
      appendFileSync(f, failedCommandLine('exec-hook-handled', 'error TS2996: TAILER-B already handled by hook'));
      assert.equal(await tailer.tick(), 0);
      const rows = client.db.prepare(
        "SELECT COUNT(*) AS n FROM memories WHERE content LIKE '%TS2996%'",
      ).get() as { n: number };
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
      appendFileSync(f, failedCommandLine('exec-subagent', 'error TS2995: TAILER-C subagent failure'));
      assert.equal(await tailer.tick(), 0);
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
      const full = failedCommandLine('exec-torn', 'error TS2994: TAILER-D torn line');
      appendFileSync(f, full.slice(0, 40)); // torn mid-write
      assert.equal(await tailer.tick(), 0);
      appendFileSync(f, full.slice(40)); // writer finishes the line
      assert.equal(await tailer.tick(), 1);
    } finally {
      tailer.stop();
    }
  });
});
