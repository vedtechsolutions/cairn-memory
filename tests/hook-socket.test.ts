/**
 * hook-socket — embedded hook daemon router (src/mcp/hook-socket.ts).
 *
 * Covers routing (404 vs dispatch), the /statusline fast path and its state
 * file side effect, /file-changed reminder firing, the /stop dirty-tracker
 * flush (M2), readBody stalled-client teardown (M9), and malformed-JSON
 * resilience — all over a real Unix-socket HTTP server backed by an
 * in-memory DB and a real SessionCache.
 *
 * NOTE: this suite SKIPS in environments that deny Unix-socket listen
 * (the before() capability probe), same pattern as hook-relay-status.test.ts.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, request, type Server as HttpServer } from 'node:http';

import { createHookDbClient, type HookDbClient } from '../src/hooks/shared/db-client.js';
import { SessionCache } from '../src/hooks/shared/session-cache.js';
import { getTrackerPath, loadTracker, type EditTracker } from '../src/hooks/shared/edit-tracker.js';

// hook-socket resolves its socket/PID paths lazily from CAIRN_DIR (like
// edit-tracker/state-io), so pointing CAIRN_DIR at a sandbox before the
// server starts is sufficient — no HOME juggling or import-order games.
const stateDir = mkdtempSync(join(tmpdir(), 'cairn-hook-socket-state-'));
process.env.CAIRN_DIR = join(stateDir, '.cairn');
process.env.CAIRN_STATE_PATH = join(stateDir, 'cairn-state.json');

const SOCKET_PATH = join(stateDir, '.cairn', 'hook-daemon.sock');
const PROBE_SOCKET_PATH = join(stateDir, '.cairn', 'probe.sock');

/** Per-request client-side guard so a wedged server can never hang the suite. */
const CLIENT_TIMEOUT_MS = 5_000;
/** readBody's REQUEST_TIMEOUT_MS (5s) plus scheduling margin. */
const STALL_TEARDOWN_BUDGET_MS = 6_500;

interface HttpReply {
  status: number;
  body: string;
}

type StallOutcome = { kind: 'response'; status: number } | { kind: 'teardown' };

function rawRequest(method: 'GET' | 'POST', path: string, payload?: string): Promise<HttpReply> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath: SOCKET_PATH,
        path,
        method,
        // Force one connection per request — keep-alive sockets would make
        // server.close() in after() wait out the idle timeout.
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

function post(path: string, input: Record<string, unknown>): Promise<HttpReply> {
  return rawRequest('POST', path, JSON.stringify(input));
}

describe('hook-socket embedded daemon router', () => {
  let skipReason: string | null = null;
  let client: HookDbClient | null = null;
  let cache: SessionCache | null = null;
  let server: HttpServer | null = null;

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

    const { startHookSocket } = await import('../src/mcp/hook-socket.js');
    client = createHookDbClient(':memory:');
    cache = new SessionCache();
    server = await startHookSocket(client, cache);
    assert.ok(server, 'sandboxed CAIRN_DIR must have no live socket owner');
    // startHookSocket now awaits listen + fail-closed verify before returning,
    // so the server is already listening; guard in case that ever changes.
    if (!server.listening) {
      await new Promise<void>((resolveListen, rejectListen) => {
        server!.once('listening', resolveListen);
        server!.once('error', rejectListen);
      });
    }
  });

  after(async () => {
    server?.closeAllConnections();
    if (server) {
      await new Promise<void>((resolveClose) => server!.close(() => resolveClose()));
    }
    cache?.destroy();
    client?.close();
    rmSync(stateDir, { recursive: true, force: true });
  });

  it('reports embedded mode and the route table on GET /health', async (t) => {
    if (skipReason) return t.skip(skipReason);

    const reply = await rawRequest('GET', '/health');

    assert.equal(reply.status, 200);
    const health = JSON.parse(reply.body) as { status: string; mode: string; routes: string[] };
    assert.equal(health.status, 'ok');
    assert.equal(health.mode, 'embedded');
    assert.ok(health.routes.includes('/stop'), 'route table must list /stop');
    assert.ok(health.routes.includes('/pitfall-check'), 'route table must list /pitfall-check');
  });

  it('returns 404 with an Unknown route body for an unrouted POST path', async (t) => {
    if (skipReason) return t.skip(skipReason);

    const reply = await post('/no-such-hook', { session_id: 's-404' });

    assert.equal(reply.status, 404);
    assert.ok(reply.body.startsWith('Unknown route'), `body must name the failure, got: ${reply.body}`);
    assert.ok(reply.body.includes('/no-such-hook'), 'body must echo the unrouted path');
  });

  it('dispatches /statusline end-to-end and writes the context-pressure state file', async (t) => {
    if (skipReason) return t.skip(skipReason);

    const reply = await post('/statusline', {
      session_id: 's-statusline',
      cwd: '/tmp/cairn-statusline-project',
      context_window: {
        used_percentage: 42,
        remaining_percentage: 58,
        context_window_size: 200_000,
        total_input_tokens: 84_000,
        total_output_tokens: 2_000,
      },
    });

    assert.equal(reply.status, 200);
    assert.match(reply.body, /^Waykeep: (normal|compact|minimal|critical) \| \d+% free/);
    assert.match(reply.body, /\| \d+ mem/, 'cwd-scoped DB stats must be appended');

    const statePath = process.env.CAIRN_STATE_PATH!;
    assert.ok(existsSync(statePath), 'statusline must persist cairn-state.json');
    const state = JSON.parse(readFileSync(statePath, 'utf-8')) as { mode: string; freeUntilCompact: number };
    assert.ok(['normal', 'compact', 'minimal', 'critical'].includes(state.mode));
    assert.equal(typeof state.freeUntilCompact, 'number');
  });

  it('dispatches /file-changed and fires a seeded file-triggered reminder', async (t) => {
    if (skipReason) return t.skip(skipReason);

    const created = client!.reminderRepo.create({
      trigger: 'editing generated config',
      action: 're-run codegen after touching hook-socket-config.ts',
      trigger_type: 'file',
      trigger_config: { filePaths: ['hook-socket-config.ts'] },
      project: null,
    });
    assert.ok('id' in created, `reminder seed failed: ${JSON.stringify(created)}`);

    const reply = await post('/file-changed', {
      session_id: 's-file-changed',
      cwd: '/tmp/cairn-file-changed-project',
      file_path: '/tmp/cairn-file-changed-project/src/hook-socket-config.ts',
    });

    assert.equal(reply.status, 200);
    const parsed = JSON.parse(reply.body) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
    assert.equal(parsed.hookSpecificOutput.hookEventName, 'FileChanged');
    assert.ok(
      parsed.hookSpecificOutput.additionalContext.includes('re-run codegen'),
      'reminder action must be injected as context',
    );
  });

  it('flushes dirty trackers to disk on /stop so session-end never reads a stale cursor (M2)', async (t) => {
    if (skipReason) return t.skip(skipReason);

    const sessionId = 's-flush-m2';
    const trackerPath = getTrackerPath(sessionId);
    const tracker: EditTracker = {
      ...loadTracker(sessionId),
      lastEditPath: '/tmp/proj/src/app.ts',
      lastEditTime: Date.now(),
    };
    cache!.setTracker(sessionId, tracker); // marks the tracker dirty
    assert.ok(!existsSync(trackerPath), 'tracker must live only in memory before /stop');

    // Short message → handleStop early-returns 'no-decision'; the route-level
    // flush must still run.
    const reply = await post('/stop', {
      session_id: sessionId,
      cwd: '/tmp/proj',
      stop_hook_active: false,
      last_assistant_message: 'ok',
    });

    assert.equal(reply.status, 200);
    assert.ok(existsSync(trackerPath), '/stop must flush the dirty tracker to disk');
    const persisted = JSON.parse(readFileSync(trackerPath, 'utf-8')) as EditTracker;
    assert.equal(persisted.lastEditPath, '/tmp/proj/src/app.ts');
  });

  it('stores a decision memory when /stop receives a sigil-bearing turn', async (t) => {
    if (skipReason) return t.skip(skipReason);

    const reply = await post('/stop', {
      session_id: 's-sigil',
      cwd: '/tmp/cairn-sigil-project',
      stop_hook_active: false,
      last_assistant_message:
        'Wrapped up the harness. [dec: chose node:test over vitest because it needs zero new dependencies] Next step is wiring CI.',
    });

    assert.equal(reply.status, 200);
    const decisions = client!.db
      .prepare("SELECT content FROM memories WHERE kind = 'decision' AND invalidated = 0")
      .all() as Array<{ content: string }>;
    assert.ok(
      decisions.some((d) => d.content.includes('node:test over vitest')),
      `sigil decision must be persisted, got: ${JSON.stringify(decisions)}`,
    );

    const telemetry = client!.db
      .prepare("SELECT COUNT(*) AS c FROM hook_telemetry WHERE hook_name = 'stop' AND success = 1")
      .get() as { c: number };
    assert.ok(telemetry.c >= 1, 'routed dispatch must record telemetry');
  });

  it('responds 400 Invalid JSON to a malformed body and keeps serving', async (t) => {
    if (skipReason) return t.skip(skipReason);

    const bad = await rawRequest('POST', '/stop', '{"session_id": not-json');
    assert.equal(bad.status, 400);
    assert.equal(bad.body, 'Invalid JSON');

    const health = await rawRequest('GET', '/health');
    assert.equal(health.status, 200, 'server must stay up after a malformed body');
  });

  it('tears down a stalled partial-body request within the body timeout and stays healthy (M9)', async (t) => {
    if (skipReason) return t.skip(skipReason);

    const started = Date.now();
    const outcome = await new Promise<StallOutcome>((resolveStall, rejectStall) => {
      const req = request({
        socketPath: SOCKET_PATH,
        path: '/stop',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': '4096', Connection: 'close' },
      });
      const guard = setTimeout(() => {
        req.destroy();
        rejectStall(new Error(`server did not tear down the stalled request within ${STALL_TEARDOWN_BUDGET_MS}ms`));
      }, STALL_TEARDOWN_BUDGET_MS);
      req.on('response', (res) => {
        res.resume();
        res.on('end', () => {
          clearTimeout(guard);
          resolveStall({ kind: 'response', status: res.statusCode ?? 0 });
        });
        res.on('error', () => {
          clearTimeout(guard);
          resolveStall({ kind: 'teardown' });
        });
      });
      req.on('error', () => {
        clearTimeout(guard);
        resolveStall({ kind: 'teardown' });
      });
      // Send a partial body and stall — never call end().
      req.write('{"session_id":"s-stall"');
    });

    const elapsed = Date.now() - started;
    assert.ok(elapsed <= STALL_TEARDOWN_BUDGET_MS, `teardown took ${elapsed}ms`);
    if (outcome.kind === 'response') {
      assert.ok(outcome.status >= 400, `a stalled body must not be treated as success, got ${outcome.status}`);
    }

    const followUp = await post('/statusline', {
      session_id: 's-after-stall',
      context_window: {
        used_percentage: 10,
        remaining_percentage: 90,
        context_window_size: 200_000,
        total_input_tokens: 20_000,
        total_output_tokens: 1_000,
      },
    });
    assert.equal(followUp.status, 200, 'server must serve normal requests after a stalled client');
    assert.match(followUp.body, /^Waykeep: /);
  });
});
