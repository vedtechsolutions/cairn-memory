import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/db/connection.js';
import {
  evaluateShadowStopFailOpen, type ShadowStopWireInput,
} from '../src/governance/shadow-stop.js';
import { projectId } from '../src/utils/project-id.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.length = 0;
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'cairn-shadow-stop-'));
  roots.push(root);
  return root;
}

describe('shadow Stop fail-open wrapper', () => {
  it('upserts Stop observation while preserving previously known capabilities', async () => {
    const db = openDatabase({ dbPath: ':memory:' });
    try {
      const root = tempRoot();
      const project = projectId(root);
      db.prepare(`
        INSERT INTO governance_client_state (
          project, client_installation_id, client_name, client_version,
          supports_post_tool_use, supports_post_tool_failure, supports_file_changed,
          supports_structured_output, supports_stop, supports_blocking, adapter_version,
          settings_source, last_session_id, last_heartbeat_at, last_probe_result
        ) VALUES (?, 'install-a', 'claude-code', 'prior', 1, 0, 1, 0, NULL, 0, 1,
          'managed-settings', 'prior-session', '2026-08-26T10:00:00.000Z', 'probe-ok')
      `).run(project);
      await evaluateShadowStopFailOpen(db, {
        session_id: 'current-session', cwd: root, stop_hook_active: true,
        client_name: 'claude-code', client_installation_id: 'install-a',
      }, {
        nowMs: () => Date.parse('2026-08-26T12:00:00.000Z'),
        evaluate: async () => ({
          status: 'skipped', verdict: null, persistence: null, elapsedMs: 1, retryCount: 0,
        }),
      });
      const row = db.prepare(`
        SELECT * FROM governance_client_state
        WHERE project = ? AND client_installation_id = 'install-a'
      `).get(project) as Record<string, unknown>;
      assert.equal(row.supports_stop, 1);
      assert.equal(row.last_session_id, 'current-session');
      assert.equal(row.last_heartbeat_at, '2026-08-26T12:00:00.000Z');
      assert.equal(row.client_version, 'prior', 'null observation must preserve known version');
      assert.equal(row.supports_post_tool_use, 1);
      assert.equal(row.supports_post_tool_failure, 0);
      assert.equal(row.supports_file_changed, 1);
      assert.equal(row.supports_structured_output, 0);
      assert.equal(row.supports_blocking, 0);
      assert.equal(row.settings_source, 'managed-settings');
    } finally {
      db.close();
    }
  });

  it('strips assistant text and passes stop_hook_active only to the internal evaluator', async () => {
    const db = openDatabase({ dbPath: ':memory:' });
    try {
      const wire = {
        session_id: 'session-a', cwd: tempRoot(), stop_hook_active: true,
        last_assistant_message: 'needle-shadow-wire-secret',
      } as ShadowStopWireInput & { last_assistant_message: string };
      let received = '';
      await evaluateShadowStopFailOpen(db, wire, {
        evaluate: async (_database, evaluatorInput) => {
          received = JSON.stringify(evaluatorInput);
          return {
            status: 'skipped', verdict: null, persistence: null, elapsedMs: 0, retryCount: 0,
          };
        },
      });
      assert.doesNotMatch(received, /needle-shadow-wire-secret/u);
      assert.match(received, /"stopHookActive":true/u);
    } finally {
      db.close();
    }
  });

  it('downgrades stale synchronous capability after relay removal', async () => {
    const db = openDatabase({ dbPath: ':memory:' });
    try {
      const root = tempRoot();
      const project = projectId(root);
      db.prepare(`INSERT INTO governance_client_state (
        project, client_installation_id, client_name, supports_structured_output,
        supports_stop, supports_blocking, adapter_version, settings_source,
        last_session_id, last_heartbeat_at, last_probe_result
      ) VALUES (?, 'install-a', 'claude-code', 1, 1, 1, 1,
        'claude-settings:governance-gate', 'old-session',
        '2026-08-26T10:00:00.000Z', 'hook-observation')`).run(project);
      await evaluateShadowStopFailOpen(db, {
        session_id: 'current-session', cwd: root, stop_hook_active: false,
        client_installation_id: 'install-a',
      }, {
        nowMs: () => Date.parse('2026-08-26T12:00:00.000Z'),
        evaluate: async () => ({
          status: 'skipped', verdict: null, persistence: null, elapsedMs: 0, retryCount: 0,
        }),
      });
      const row = db.prepare(`SELECT supports_structured_output, supports_blocking,
        settings_source FROM governance_client_state WHERE project = ?`).get(project) as Record<string, unknown>;
      assert.deepEqual(row, { supports_structured_output: 0, supports_blocking: 0, settings_source: null });
    } finally {
      db.close();
    }
  });

  it('returns null instead of throwing when the evaluator crashes', async () => {
    const db = openDatabase({ dbPath: ':memory:' });
    try {
      const result = await evaluateShadowStopFailOpen(db, {
        session_id: 'session-a', cwd: tempRoot(), stop_hook_active: false,
      }, { evaluate: async () => { throw new Error('injected evaluator crash'); } });
      assert.equal(result, null);
    } finally {
      db.close();
    }
  });
});
