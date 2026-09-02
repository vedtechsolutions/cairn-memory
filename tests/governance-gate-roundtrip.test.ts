import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request, createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHookDbClient, type HookDbClient } from '../src/hooks/shared/db-client.js';
import { SessionCache } from '../src/hooks/shared/session-cache.js';
import { GovernanceRuleRepository } from '../src/governance/rule-repository.js';
import { projectId } from '../src/utils/project-id.js';
import { prepareRelayDir, runRelay, TEST_GENEROUS_TIMEOUT_MS } from './relay-harness.js';
import { ENV } from '../src/constants/env.js';
import { DATA_DIR_NAME } from 'waykeep-contract';

/** Generous watchdog so the round trip isn't cut off by the 400 ms production
 *  deadline under full-suite load — the assertions test emit/suppress logic,
 *  not the SLA (which its own benchmark covers). */
const GENEROUS_GATE_ENV = { [ENV.GOVERNANCE_TIMEOUT_MS]: TEST_GENEROUS_TIMEOUT_MS };

/** Daemon-side governance evaluation budget. The schema caps this at 1000 ms;
 *  use the max (4x the 250 ms default) so the worktree-digest + DB evaluation
 *  completes under full-suite CPU load instead of timing out to empty. */
const EVAL_TIMEOUT_MS = 1000;

const stateRoot = mkdtempSync(join(tmpdir(), 'cairn-gate-roundtrip-'));
const waykeepDir = join(stateRoot, DATA_DIR_NAME);
const socketPath = join(waykeepDir, 'hook-daemon.sock');
process.env[ENV.DIR] = waykeepDir;

function config(root: string, level: 'advise' | 'warn'): void {
  mkdirSync(join(root, '.cairn'), { recursive: true });
  writeFileSync(join(root, '.cairn', 'gates.json'), JSON.stringify({
    version: 1,
    defaults: { level, evaluationTimeoutMs: EVAL_TIMEOUT_MS, retention: { evidenceDays: 30 } },
    gates: { 'test-core': { argv: ['npm', 'test'], parser: 'node-test', timeoutMs: 30_000 } },
    pathRules: [{ paths: ['**'], require: ['test-core'] }],
  }));
}

function stopInput(root: string, session = 'session-roundtrip') {
  return {
    session_id: session, cwd: root, stop_hook_active: false,
    client_name: 'claude-code', client_installation_id: 'install-roundtrip',
    last_assistant_message: 'ROUNDTRIP_ASSISTANT_NEEDLE',
  };
}

function post(path: string, body: Record<string, unknown>): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path, method: 'POST', headers: { 'Content-Type': 'application/json' } }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

describe('governance-gate subprocess to warm-daemon round trip', () => {
  let skipReason: string | null = null;
  let client: HookDbClient;
  let cache: SessionCache;
  let server: Server;
  let relayDirectory: string;
  let governedRoot: string;

  before(async () => {
    mkdirSync(waykeepDir, { recursive: true });
    const probePath = join(waykeepDir, 'probe.sock');
    try {
      const probe = createServer(() => {});
      await new Promise<void>((resolve, reject) => {
        probe.once('error', reject);
        probe.listen(probePath, () => probe.close(() => resolve()));
      });
      rmSync(probePath, { force: true });
    } catch (error) {
      skipReason = `unix sockets unavailable: ${String(error)}`;
      return;
    }
    governedRoot = mkdtempSync(join(stateRoot, 'governed-'));
    config(governedRoot, 'warn');
    client = createHookDbClient(':memory:');
    cache = new SessionCache();
    const project = projectId(governedRoot);
    new GovernanceRuleRepository(client.db).create({
      ruleId: 'verify-core', content: 'Verify core at exit', project,
      phases: ['pre_exit'], level: 'warn', gateIds: ['test-core'], paths: [],
      confirmation: { userConfirmed: true },
    });
    client.db.prepare(`
      INSERT INTO governance_client_state (
        project, client_installation_id, client_name,
        supports_post_tool_use, supports_post_tool_failure, supports_file_changed,
        adapter_version
      ) VALUES (?, 'install-roundtrip', 'claude-code', 1, 1, 1, 1)
    `).run(project);
    const { startHookSocket } = await import('../src/mcp/hook-socket.js');
    const claimed = await startHookSocket(client, cache);
    assert.ok(claimed, 'sandboxed CAIRN_DIR must have no live socket owner');
    server = claimed;
    // startHookSocket awaits listen + fail-closed verify before returning, so
    // the server is already listening; guard so 'listening' isn't awaited after
    // it has fired (which would hang this before-hook).
    if (!server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.once('listening', resolve);
        server.once('error', reject);
      });
    }
    relayDirectory = prepareRelayDir('cairn-gate-roundtrip');
  });

  after(async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
    cache?.destroy();
    client?.close();
    rmSync(stateRoot, { recursive: true, force: true });
    if (relayDirectory) rmSync(relayDirectory, { recursive: true, force: true });
  });

  it('emits once, suppresses the duplicate, and leaves shadow persistence to async Stop', async (t) => {
    if (skipReason) return t.skip(skipReason);
    const binary = join(relayDirectory, 'hook-relay');
    const first = await runRelay(binary, 'governance-gate', JSON.stringify(stopInput(governedRoot)), stateRoot, GENEROUS_GATE_ENV);
    assert.equal(first.status, 0);
    const parsed = JSON.parse(first.stdout) as Record<string, unknown>;
    assert.deepEqual(Object.keys(parsed), ['systemMessage']);
    assert.doesNotMatch(first.stdout, /"decision"|ROUNDTRIP_ASSISTANT_NEEDLE/u);
    const second = await runRelay(binary, 'governance-gate', JSON.stringify(stopInput(governedRoot)), stateRoot, GENEROUS_GATE_ENV);
    assert.equal(second.stdout, '');
    assert.equal((client.db.prepare(`SELECT count(*) n FROM governance_audit
      WHERE event_type = 'shadow_stop_verdict'`).get() as { n: number }).n, 0);
    assert.equal(await post('/stop', stopInput(governedRoot)), '');
    assert.equal((client.db.prepare(`SELECT count(*) n FROM governance_audit
      WHERE event_type = 'shadow_stop_verdict'`).get() as { n: number }).n, 1);
  });

  it('returns empty output for non-governed and advisory projects', async (t) => {
    if (skipReason) return t.skip(skipReason);
    const binary = join(relayDirectory, 'hook-relay');
    const plainRoot = mkdtempSync(join(stateRoot, 'plain-'));
    const plain = await runRelay(binary, 'governance-gate', JSON.stringify(stopInput(plainRoot, 'plain')), stateRoot);
    assert.equal(plain.stdout, '');
    const advisoryRoot = mkdtempSync(join(stateRoot, 'advisory-'));
    config(advisoryRoot, 'advise');
    new GovernanceRuleRepository(client.db).create({
      ruleId: 'advise-core', content: 'Advise core at exit', project: projectId(advisoryRoot),
      phases: ['pre_exit'], level: 'advise', gateIds: ['test-core'], paths: [],
      confirmation: { userConfirmed: true },
    });
    const advisory = await runRelay(
      binary, 'governance-gate', JSON.stringify(stopInput(advisoryRoot, 'advisory')), stateRoot,
    );
    assert.equal(advisory.stdout, '');
  });
});
