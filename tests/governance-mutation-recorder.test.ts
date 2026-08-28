import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { openDatabase } from '../src/db/connection.js';
import { recordGovernanceEvent } from '../src/governance/recorder.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

function project(): { root: string; dbPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'cairn-recorder-concurrency-'));
  tempDirs.push(root);
  mkdirSync(join(root, '.cairn'));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'a.ts'), 'initial\n');
  writeFileSync(join(root, '.cairn', 'gates.json'), JSON.stringify({
    version: 1,
    gates: {
      test: {
        argv: ['npm', 'test'], cwd: '.', parser: 'node-test', timeoutMs: 60_000,
        skips: { max: 0, requireReasons: false },
      },
    },
    pathRules: [{ paths: ['**'], require: ['test'] }],
  }));
  const dbDir = mkdtempSync(join(tmpdir(), 'cairn-recorder-db-'));
  tempDirs.push(dbDir);
  const dbPath = join(dbDir, 'events.db');
  const db = openDatabase({ dbPath });
  db.close();
  return { root, dbPath };
}

const nodeOutput = 'TAP version 13\nok 1 - works\n1..1\n# tests 1\n# pass 1\n# fail 0\n# skipped 0\n';

function common(root: string, toolUseId: string): Record<string, unknown> {
  return {
    session_id: 'barrier-session', transcript_path: join(root, 'transcript.jsonl'), cwd: root,
    client_name: 'claude-code', client_version: '1.2.3', client_installation_id: 'install-a',
    tool_use_id: toolUseId,
  };
}

function success(root: string, id: string): unknown {
  return {
    ...common(root, id), hook_event_name: 'PostToolUse', tool_name: 'Bash',
    tool_input: { command: 'npm test' },
    tool_response: { stdout: nodeOutput, stderr: '', interrupted: false },
  };
}

function failure(root: string, id: string): unknown {
  return {
    ...common(root, id), hook_event_name: 'PostToolUseFailure', tool_name: 'Bash',
    tool_input: { command: 'npm test' }, error: 'failed safely', exit_code: 1,
    is_interrupt: false, timed_out: false,
  };
}

function edit(root: string, id: string, path: string): unknown {
  return {
    ...common(root, id), hook_event_name: 'PostToolUse', tool_name: 'Edit',
    tool_input: { file_path: join(root, path), old_string: 'x', new_string: 'y' },
    tool_response: { success: true, filePath: join(root, path) },
  };
}

function changed(root: string, id: string, path: string): unknown {
  return {
    ...common(root, id), hook_event_name: 'FileChanged', file_path: path,
    delivery_fingerprint: `delivery-${id}`,
  };
}

function runBarrierWorkers(dbPath: string, inputs: unknown[]): Promise<unknown[]> {
  const barrierBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
  const barrier = new Int32Array(barrierBuffer);
  const workers = inputs.map(input => new Worker(
    new URL('./helpers/governance-recorder-worker.js', import.meta.url),
    { workerData: { dbPath, barrier: barrierBuffer, input } },
  ));
  return new Promise((resolve, reject) => {
    const results: unknown[] = [];
    let ready = 0;
    let finished = 0;
    const release = (): void => {
      if (ready !== workers.length) return;
      Atomics.store(barrier, 1, 1);
      Atomics.notify(barrier, 1, workers.length);
    };
    workers.forEach(worker => {
      worker.on('message', (message: { ready?: boolean; result?: unknown; error?: string }) => {
        if (message.ready) {
          ready += 1;
          release();
          return;
        }
        if (message.error) reject(new Error(message.error));
        else results.push(message.result);
        finished += 1;
        if (finished === workers.length) resolve(results);
      });
      worker.on('error', reject);
    });
  });
}

describe('governance mutation recorder (A6)', () => {
  it('serializes barrier-started successes, failures, edits, and FileChanged deliveries losslessly', async () => {
    const { root, dbPath } = project();
    const inputs = [
      success(root, 'success-1'), success(root, 'success-2'),
      failure(root, 'failure-1'), failure(root, 'failure-2'),
      edit(root, 'edit-1', 'src/a.ts'), changed(root, 'edit-1', 'src/a.ts'),
      edit(root, 'edit-2', 'src/b.ts'), changed(root, 'edit-2', 'src/b.ts'),
    ];
    const results = await runBarrierWorkers(dbPath, inputs) as Array<{
      status: string; eventSeq: number; mutationSeq: number;
    }>;
    assert.equal(results.length, inputs.length);
    assert.ok(results.every(result => result.status === 'recorded'));

    const db = openDatabase({ dbPath });
    try {
      const events = db.prepare(`
        SELECT event_seq, hook_event, tool_name, tool_use_id, mutation_class, mutation_seq
        FROM governance_tool_events ORDER BY event_seq
      `).all() as Array<{
        event_seq: number; hook_event: string; tool_name: string | null;
        tool_use_id: string; mutation_class: string; mutation_seq: number;
      }>;
      assert.equal(events.length, 8);
      assert.deepEqual(events.map(event => event.event_seq),
        [...events.map(event => event.event_seq)].sort((a, b) => a - b));
      assert.equal(new Set(events.map(event => event.event_seq)).size, 8);
      assert.equal(events.at(-1)?.mutation_seq, 6,
        'four Bash calls plus two edit/FileChanged pairs increment atomically');
      for (const id of ['edit-1', 'edit-2']) {
        const pair = events.filter(event => event.tool_use_id === id);
        assert.equal(pair.length, 2);
        assert.ok(pair.every(event => event.mutation_class === 'scoped'));
      }
      assert.equal((db.prepare('SELECT COUNT(*) AS n FROM governance_gate_runs').get() as { n: number }).n, 4);
      assert.equal((db.prepare(`
        SELECT COUNT(*) AS n FROM governance_gate_runs WHERE digest_version = 2
      `).get() as { n: number }).n, 4, 'the recorder emits only digest-v2 baselines');
      assert.equal((db.prepare(`
        SELECT COUNT(*) AS n FROM governance_gate_runs r
        LEFT JOIN governance_tool_events e ON e.event_seq = r.event_seq
        WHERE e.event_seq IS NULL
      `).get() as { n: number }).n, 0);
      const state = db.prepare(`
        SELECT supports_post_tool_use, supports_post_tool_failure,
               supports_file_changed, supports_structured_output
        FROM governance_client_state
        WHERE client_installation_id = 'install-a'
      `).get() as Record<string, number>;
      assert.deepEqual(state, {
        supports_post_tool_use: 1, supports_post_tool_failure: 1,
        supports_file_changed: 1, supports_structured_output: 1,
      });
    } finally {
      db.close();
    }
  });

  it('deduplicates retries and rolls back every row after an induced mid-transaction failure', async () => {
    const { root, dbPath } = project();
    const db = openDatabase({ dbPath });
    try {
      const first = await recordGovernanceEvent(db, success(root, 'retry-1'));
      const retry = await recordGovernanceEvent(db, success(root, 'retry-1'));
      assert.equal(first.status, 'recorded');
      assert.equal(retry.status, 'deduplicated');
      assert.equal(retry.eventSeq, first.eventSeq);
      assert.equal((db.prepare('SELECT COUNT(*) AS n FROM governance_tool_events').get() as { n: number }).n, 1);
      assert.equal((db.prepare('SELECT COUNT(*) AS n FROM governance_gate_runs').get() as { n: number }).n, 1);

      const beforeCounts = ['governance_tool_events', 'governance_gate_runs',
        'governance_audit', 'governance_client_state'].map(table =>
        (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);

      await assert.rejects(() => recordGovernanceEvent(db, success(root, 'rollback-1'), {
        failAfterEventInsert: true,
      }), /induced recorder failure/u);
      assert.equal((db.prepare(`
        SELECT COUNT(*) AS n FROM governance_tool_events WHERE tool_use_id = 'rollback-1'
      `).get() as { n: number }).n, 0);
      const afterCounts = ['governance_tool_events', 'governance_gate_runs',
        'governance_audit', 'governance_client_state'].map(table =>
        (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
      assert.deepEqual(afterCounts, beforeCounts, 'no table retains a partial transaction write');
      assert.equal((db.prepare('PRAGMA foreign_key_check').all() as unknown[]).length, 0);
    } finally {
      db.close();
    }
  });
});
