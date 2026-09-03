import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import {
  createServer, type IncomingMessage, type Server, type ServerResponse,
} from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterBody, prepareRelayDir, runRelay, TEST_GENEROUS_TIMEOUT_MS } from './relay-harness.js';
import { ENV } from '../src/constants/env.js';
import { DATA_DIR_NAME } from 'waykeep-contract';

/** Env override giving round-trip tests a generous watchdog so they don't race
 *  the 400 ms production deadline under load. The watchdog-timing test below
 *  deliberately omits this to keep the tight default. */
const GENEROUS_GATE_ENV = { [ENV.GOVERNANCE_TIMEOUT_MS]: TEST_GENEROUS_TIMEOUT_MS };

const roots: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function home(): string {
  const value = mkdtempSync(join(tmpdir(), 'cairn-governance-relay-home-'));
  roots.push(value);
  mkdirSync(join(value, DATA_DIR_NAME));
  return value;
}

async function listen(
  homePath: string,
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<Server> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(join(homePath, DATA_DIR_NAME, 'hook-daemon.sock'), resolve);
  });
  return server;
}

function relayDir(): string {
  const value = prepareRelayDir('cairn-governance-relay');
  roots.push(value);
  return value;
}

describe('governance-gate compiled relay', () => {
  it('passes only a complete non-controlling systemMessage response', async (t) => {
    const homePath = home();
    try {
      await listen(homePath, (request, response) => afterBody(request, () => {
        response.writeHead(200, { 'Content-Type': 'text/plain' });
        response.end(JSON.stringify({ systemMessage: 'Governance warning: rerun tests.' }));
      }));
    } catch (error) {
      return t.skip(`unix sockets unavailable: ${String(error)}`);
    }
    const result = await runRelay(join(relayDir(), 'hook-relay'), 'governance-gate', '{}', homePath, GENEROUS_GATE_ENV);
    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(result.stdout), { systemMessage: 'Governance warning: rerun tests.' });
    assert.doesNotMatch(result.stdout, /"decision"/u);
  });

  it('fails open with empty output when the daemon socket is absent', async () => {
    const homePath = home();
    const started = performance.now();
    const result = await runRelay(join(relayDir(), 'hook-relay'), 'governance-gate', '{}', homePath);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
    assert.ok(performance.now() - started < 1_000);
  });

  it('drops malformed and decision-bearing daemon responses in full', async (t) => {
    for (const body of [
      'partial warning', '{"systemMessage":"bad\\q"}',
      '{"systemMessage":"warn","decision":"block"}',
    ]) {
      const homePath = home();
      try {
        await listen(homePath, (request, response) => afterBody(request, () => { response.writeHead(200); response.end(body); }));
      } catch (error) {
        return t.skip(`unix sockets unavailable: ${String(error)}`);
      }
      const result = await runRelay(join(relayDir(), 'hook-relay'), 'governance-gate', '{}', homePath, GENEROUS_GATE_ENV);
      assert.equal(result.status, 0);
      assert.equal(result.stdout, '', body);
      const server = servers.shift()!;
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('watchdog exits zero and emits nothing when the daemon hangs', async (t) => {
    const homePath = home();
    try {
      await listen(homePath, () => { /* injected hang */ });
    } catch (error) {
      return t.skip(`unix sockets unavailable: ${String(error)}`);
    }
    // A hung governance daemon costs the governance timer (the SIGALRM
    // watchdog and the response poll both use it) and nothing more. Set it
    // explicitly, require the relay to have waited for it, and bound above
    // only against a hang: a fixed 1 s ceiling also measured host scheduling
    // (it failed at a load average near 60 with the timer firing at ~400 ms).
    const governanceTimerMs = 400;
    // Below the relay's 3 s daemon wait, so a governance route that fell back
    // to the daemon timer fails decisively rather than by spawn overhead.
    const hangBoundMs = 2_000;
    const started = performance.now();
    const result = await runRelay(join(relayDir(), 'hook-relay'), 'governance-gate', '{}', homePath, {
      [ENV.GOVERNANCE_TIMEOUT_MS]: String(governanceTimerMs),
    });
    const elapsed = performance.now() - started;
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
    assert.ok(elapsed >= governanceTimerMs - 100 && elapsed < hangBoundMs, `watchdog elapsed ${elapsed.toFixed(2)} ms`);
  });

  it('emits no partial warning when the daemon drops the connection', async (t) => {
    const homePath = home();
    try {
      await listen(homePath, (request) => { request.socket.destroy(); });
    } catch (error) {
      return t.skip(`unix sockets unavailable: ${String(error)}`);
    }
    const result = await runRelay(join(relayDir(), 'hook-relay'), 'governance-gate', '{}', homePath, GENEROUS_GATE_ENV);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
  });
});
