/**
 * H1/H2/M12 — hook-relay binary HTTP correctness:
 *  - non-2xx daemon responses (e.g. 404 for an unrouted hook type) must
 *    fall back to direct-node exec instead of printing the error body
 *    as hook output and exiting 0 (silent hook drop).
 *  - request bodies containing NUL bytes must be sent in full (the old
 *    %s-embedded body truncated at the first NUL while Content-Length
 *    claimed the full size, hanging the daemon read).
 *  - 2xx response bodies must be printed to stdout unchanged.
 *
 * NOTE: this whole suite SKIPS in environments that deny Unix-socket listen
 * (the before() capability probe). A pass in such an environment is skips,
 * not evidence — the fallback branch is separately covered by
 * hook-gap-relay-fallback.test.ts, which has its own capability probe.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';

import { prepareRelayDir, runRelay, TEST_GENEROUS_TIMEOUT_MS } from './relay-harness.js';

/** Round-trip tests that read a 200 body must not race the production daemon
 *  timeout against a CPU-starved mock socket under full-suite load. */
const GENEROUS_DAEMON_ENV = { CAIRN_DAEMON_TIMEOUT_MS: TEST_GENEROUS_TIMEOUT_MS };

describe('hook-relay HTTP status + body integrity (H1/H2/M12)', () => {
  let tmpBinDir: string;
  let fakeHome: string;
  let sockPath: string;
  let server: Server | null = null;
  let skipReason: string | null = null;

  before(async () => {
    tmpBinDir = prepareRelayDir('cairn-relay-status');

    fakeHome = mkdtempSync(join(tmpdir(), 'cairn-relay-home-'));
    mkdirSync(join(fakeHome, '.cairn'), { recursive: true });
    sockPath = join(fakeHome, '.cairn', 'hook-daemon.sock');

    // Capability probe: sandboxed environments may deny Unix-socket listen
    // (EPERM). Skip the suite there instead of failing — the relay logic
    // itself is environment-independent.
    try {
      await new Promise<void>((resolveProbe, rejectProbe) => {
        const probe = createServer(() => {});
        probe.once('error', rejectProbe);
        probe.listen(sockPath, () => probe.close(() => resolveProbe()));
      });
      rmSync(sockPath, { force: true });
    } catch (err) {
      skipReason = `unix-socket listen not permitted in this environment: ${(err as Error).message}`;
    }
  });

  after(() => {
    server?.close();
    rmSync(tmpBinDir, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  });

  function listen(handler: Parameters<typeof createServer>[1]): Promise<void> {
    return new Promise((resolvePromise) => {
      server?.close();
      rmSync(sockPath, { force: true });
      server = createServer(handler);
      server.listen(sockPath, () => resolvePromise());
    });
  }

  it('falls back to direct-node exec on daemon 404 instead of printing the error body', async (t) => {
    if (skipReason) return t.skip(skipReason);
    writeFileSync(
      join(tmpBinDir, 'unrouted-hook.js'),
      `const data = require('fs').readFileSync(0, 'utf8');\nprocess.stdout.write('FALLBACK:' + data.trim());\n`,
    );
    await listen((_req, res) => {
      res.writeHead(404);
      res.end('Unknown route: /unrouted-hook');
    });

    const result = await runRelay(join(tmpBinDir, 'hook-relay'), 'unrouted-hook', '{"session_id":"s1"}', fakeHome);

    assert.equal(result.status, 0);
    assert.ok(!result.stdout.includes('Unknown route'), 'error body must not leak to stdout');
    assert.equal(result.stdout, 'FALLBACK:{"session_id":"s1"}');
  });

  it('sends the full Content-Length body even when input contains NUL bytes', async (t) => {
    if (skipReason) return t.skip(skipReason);
    await listen((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const received = Buffer.concat(chunks);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ len: received.length }));
      });
    });

    const input = Buffer.from('{"before":"a"}\0{"after":"b"}', 'utf8');
    const result = await runRelay(join(tmpBinDir, 'hook-relay'), 'nul-hook', input, fakeHome, GENEROUS_DAEMON_ENV);

    assert.equal(result.status, 0);
    assert.equal(JSON.parse(result.stdout).len, input.length, 'daemon must receive every byte, including past the NUL');
  });

  it('prints the response body unchanged on 200', async (t) => {
    if (skipReason) return t.skip(skipReason);
    await listen((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"decision":"allow","note":"ok"}');
    });

    const result = await runRelay(join(tmpBinDir, 'hook-relay'), 'ok-hook', '{}', fakeHome, GENEROUS_DAEMON_ENV);

    assert.equal(result.status, 0);
    assert.equal(result.stdout, '{"decision":"allow","note":"ok"}');
  });
});
