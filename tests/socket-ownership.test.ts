/**
 * socket-ownership — cooperative claim protocol for the shared hook socket
 * (src/mcp/socket-ownership.ts + the startHookSocket claim flow).
 *
 * Regression focus: the pre-fix startup path SIGTERMed whatever PID the
 * pid-file named and stole the socket, so concurrent agent clients
 * (Claude Code + Codex) killed each other's MCP servers. These tests pin
 * the cooperative behavior: live owners answer probes and stay untouched,
 * live foreign claimants are never signalled, and only dead sockets are
 * claimed.
 *
 * NOTE: this suite SKIPS in environments that deny Unix-socket listen
 * (the before() capability probe), same pattern as hook-socket.test.ts.
 */
import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, request, type Server as HttpServer } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';

import { createHookDbClient, type HookDbClient } from '../src/hooks/shared/db-client.js';
import { SessionCache } from '../src/hooks/shared/session-cache.js';

// socket-ownership resolves its socket/PID paths lazily from CAIRN_DIR, so
// pointing CAIRN_DIR at a sandbox before anything starts is sufficient.
const stateDir = mkdtempSync(join(tmpdir(), 'cairn-socket-ownership-'));
process.env.CAIRN_DIR = join(stateDir, '.cairn');
process.env.CAIRN_STATE_PATH = join(stateDir, 'cairn-state.json');

const SOCKET_PATH = join(stateDir, '.cairn', 'hook-daemon.sock');
const PID_PATH = join(stateDir, '.cairn', 'hook-daemon.pid');
const PROBE_SOCKET_PATH = join(stateDir, '.cairn', 'probe.sock');

/** Per-request client-side guard so a wedged server can never hang the suite. */
const CLIENT_TIMEOUT_MS = 5_000;

interface HttpReply {
  status: number;
  body: string;
}

function rawRequest(method: 'GET' | 'POST', path: string, payload?: string): Promise<HttpReply> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath: SOCKET_PATH,
        path,
        method,
        headers: { 'Content-Type': 'application/json', Connection: 'close' },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf-8') }));
      },
    );
    req.setTimeout(CLIENT_TIMEOUT_MS, () => {
      req.destroy(new Error(`client timeout after ${CLIENT_TIMEOUT_MS}ms on ${method} ${path}`));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

/** Resolve once the server is listening. startHookSocket now awaits listen +
 *  fail-closed verify before returning, so it is usually already listening;
 *  this stays correct either way. */
function waitListening(server: HttpServer): Promise<void> {
  if (server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
}

/** Spawn a child, wait for it to exit, and return its now-dead PID. */
function reapDeadPid(): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn('true', [], { stdio: 'ignore' });
    child.once('error', reject);
    child.once('exit', () => resolve(child.pid ?? 0));
  });
}

describe('socket-ownership cooperative claim', () => {
  let skipReason: string | null = null;
  let client: HookDbClient | null = null;
  let servers: HttpServer[] = [];
  let children: ChildProcess[] = [];
  // Loaded dynamically after CAIRN_DIR is sandboxed, like hook-socket.test.ts.
  let startHookSocket: typeof import('../src/mcp/hook-socket.js')['startHookSocket'];
  let ownership: typeof import('../src/mcp/socket-ownership.js');

  before(async () => {
    mkdirSync(join(stateDir, '.cairn'), { recursive: true });

    // Capability probe: sandboxed environments may deny Unix-socket listen
    // (EPERM). Skip the suite there instead of failing.
    try {
      await new Promise<void>((resolveProbe, rejectProbe) => {
        const probe = createServer(() => {});
        probe.once('error', rejectProbe);
        probe.listen(PROBE_SOCKET_PATH, () => probe.close(() => resolveProbe()));
      });
      rmSync(PROBE_SOCKET_PATH, { force: true });
    } catch (err) {
      skipReason = `unix-socket listen not permitted in this environment: ${(err as Error).message}`;
      return;
    }

    ({ startHookSocket } = await import('../src/mcp/hook-socket.js'));
    ownership = await import('../src/mcp/socket-ownership.js');
    client = createHookDbClient(':memory:');
  });

  afterEach(async () => {
    for (const server of servers) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    servers = [];
    for (const child of children) child.kill('SIGKILL');
    children = [];
    rmSync(SOCKET_PATH, { force: true });
    rmSync(PID_PATH, { force: true });
  });

  after(() => {
    client?.close();
    rmSync(stateDir, { recursive: true, force: true });
  });

  async function claimSocket(mode?: 'embedded' | 'standalone'): Promise<HttpServer> {
    const server = await startHookSocket(client!, new SessionCache(), undefined, mode ? { mode } : undefined);
    assert.ok(server, 'expected to claim the sandboxed hook socket');
    servers.push(server);
    await waitListening(server);
    return server;
  }

  it('shares a live owner instead of claiming: second start returns null and the owner keeps serving', async (t) => {
    if (skipReason) return t.skip(skipReason);
    await claimSocket();

    const second = await startHookSocket(client!, new SessionCache());
    assert.equal(second, null, 'second claimant must not take a served socket');

    const health = await rawRequest('GET', '/health');
    assert.equal(health.status, 200);
    const parsed = JSON.parse(health.body) as { pid: number };
    assert.equal(parsed.pid, process.pid, 'original owner must still serve /health');
    assert.equal(readFileSync(PID_PATH, 'utf-8'), String(process.pid), 'claim file must still name the owner');
  });

  it('never signals a live process named by the PID file when its socket is not yet up', async (t) => {
    if (skipReason) return t.skip(skipReason);
    // A live foreign PID with no socket is a claimant mid-startup. The
    // pre-fix code SIGTERMed it here; the claim must back off instead.
    const bystander = spawn('sleep', ['30'], { stdio: 'ignore' });
    children.push(bystander);
    await new Promise<void>((resolve, reject) => {
      bystander.once('spawn', resolve);
      bystander.once('error', reject);
    });
    writeFileSync(PID_PATH, String(bystander.pid));

    const result = await startHookSocket(client!, new SessionCache());
    assert.equal(result, null, 'must back off from a live claimant');
    assert.equal(bystander.exitCode, null, 'the process named by the PID file must not be signalled');
    assert.equal(readFileSync(PID_PATH, 'utf-8'), String(bystander.pid), 'the claimant PID file must survive');
  });

  it('claims a stale socket left behind by a dead owner', async (t) => {
    if (skipReason) return t.skip(skipReason);
    writeFileSync(SOCKET_PATH, ''); // dead remnant: a plain file nobody serves
    writeFileSync(PID_PATH, String(await reapDeadPid()));

    await claimSocket();
    const health = await rawRequest('GET', '/health');
    assert.equal(health.status, 200);
    assert.equal((JSON.parse(health.body) as { pid: number }).pid, process.pid);
    assert.equal(readFileSync(PID_PATH, 'utf-8'), String(process.pid));
  });

  it('reports standalone mode on /health when started as the daemon', async (t) => {
    if (skipReason) return t.skip(skipReason);
    await claimSocket('standalone');
    const health = await rawRequest('GET', '/health');
    assert.equal((JSON.parse(health.body) as { mode: string }).mode, 'standalone');
  });

  it('invalidates the owner skip-gate through POST /bump-memory-version', async (t) => {
    if (skipReason) return t.skip(skipReason);
    const ownerCache = new SessionCache();
    const server = await startHookSocket(client!, ownerCache);
    assert.ok(server);
    servers.push(server);
    await waitListening(server);
    assert.equal(ownerCache.getMemoryVersion(), 0);

    const reply = await rawRequest('POST', '/bump-memory-version', '{}');
    assert.equal(reply.status, 200);
    assert.equal(ownerCache.getMemoryVersion(), 1, 'a relayed bump must invalidate the owner cache');
  });

  it('fires the bump notifier so non-owner servers can relay invalidations', async (t) => {
    if (skipReason) return t.skip(skipReason);
    const cache = new SessionCache();
    let fired = 0;
    cache.setBumpNotifier(() => { fired++; });
    cache.bumpMemoryVersion();
    assert.equal(fired, 1);
    cache.setBumpNotifier(null);
    cache.bumpMemoryVersion();
    assert.equal(fired, 1, 'a cleared notifier must not fire');
  });

  it('release is PID-guarded: a former owner cannot delete a successor claim', async (t) => {
    if (skipReason) return t.skip(skipReason);
    writeFileSync(SOCKET_PATH, '');
    writeFileSync(PID_PATH, String(await reapDeadPid()));
    ownership.releaseSocketClaim();
    assert.ok(existsSync(PID_PATH), 'foreign claim must survive a release by a non-owner');
    assert.ok(existsSync(SOCKET_PATH), 'foreign socket must survive a release by a non-owner');

    writeFileSync(PID_PATH, String(process.pid));
    ownership.releaseSocketClaim();
    assert.ok(!existsSync(PID_PATH), 'own claim must be released');
    assert.ok(!existsSync(SOCKET_PATH), 'own socket must be released');
  });

  it('isOwnerOnly: true for an owner 0600 file, false for group/other bits or a missing path', (t) => {
    if (skipReason) return t.skip(skipReason);
    if (typeof process.geteuid !== 'function') return t.skip('non-POSIX: ownership not enforceable');
    const dir = join(stateDir, '.cairn');
    const secure = join(dir, 'secure.probe');
    const exposed = join(dir, 'exposed.probe');
    writeFileSync(secure, 'x', { mode: 0o600 });
    writeFileSync(exposed, 'x', { mode: 0o600 });
    chmodSync(secure, 0o600);
    chmodSync(exposed, 0o644);
    try {
      assert.equal(ownership.isOwnerOnly(secure), true, 'owner-only 0600 file is accepted');
      assert.equal(ownership.isOwnerOnly(exposed), false, 'a world-readable file is refused');
      assert.equal(ownership.isOwnerOnly(join(dir, 'nope.absent')), false, 'a missing path is refused');
    } finally {
      rmSync(secure, { force: true });
      rmSync(exposed, { force: true });
    }
  });

  it('the served socket is verified owner-only (0600, no group/other bits)', async (t) => {
    if (skipReason) return t.skip(skipReason);
    await claimSocket();
    assert.ok(existsSync(SOCKET_PATH), 'socket bound');
    if (typeof process.geteuid !== 'function') return; // non-POSIX: perms not enforced this way
    assert.equal(ownership.isOwnerOnly(SOCKET_PATH), true, 'the live socket must pass the fail-closed check');
    const mode = lstatSync(SOCKET_PATH).mode & 0o777;
    assert.equal(mode & 0o077, 0, `socket must have no group/other bits (got ${mode.toString(8)})`);
  });
});
