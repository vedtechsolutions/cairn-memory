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

import { afterBody, prepareRelayDir, runRelay, TEST_GENEROUS_TIMEOUT_MS } from './relay-harness.js';
import { ENV } from '../src/constants/env.js';
import { DATA_DIR_NAME } from 'waykeep-contract';

/** Round-trip tests that read a 200 body must not race the production daemon
 *  timeout against a CPU-starved mock socket under full-suite load. */
const GENEROUS_DAEMON_ENV = { [ENV.DAEMON_TIMEOUT_MS]: TEST_GENEROUS_TIMEOUT_MS };

describe('hook-relay HTTP status + body integrity (H1/H2/M12)', () => {
  let tmpBinDir: string;
  let server: Server | null = null;
  let skipReason: string | null = null;
  const homes: string[] = [];

  before(async () => {
    tmpBinDir = prepareRelayDir('cairn-relay-status');

    // Capability probe: sandboxed environments may deny Unix-socket listen
    // (EPERM). Skip the suite there instead of failing — the relay logic
    // itself is environment-independent.
    const probeHome = mkdtempSync(join(tmpdir(), 'cairn-relay-home-'));
    mkdirSync(join(probeHome, DATA_DIR_NAME), { recursive: true });
    homes.push(probeHome);
    try {
      await new Promise<void>((resolveProbe, rejectProbe) => {
        const probe = createServer(() => {});
        probe.once('error', rejectProbe);
        probe.listen(join(probeHome, DATA_DIR_NAME, 'hook-daemon.sock'), () => probe.close(() => resolveProbe()));
      });
    } catch (err) {
      skipReason = `unix-socket listen not permitted in this environment: ${(err as Error).message}`;
    }
  });

  after(async () => {
    if (server) await new Promise<void>((resolveClose) => server!.close(() => resolveClose()));
    rmSync(tmpBinDir, { recursive: true, force: true });
    for (const home of homes) rmSync(home, { recursive: true, force: true });
  });

  /** Start a mock daemon on a PER-TEST socket (fresh fake HOME — the
   *  relay derives its socket path from $HOME/.cairn). The shared-path
   *  version raced the previous server's ASYNC close against the next
   *  unlink+listen under full-suite load (recorded flake, guarding the
   *  silent-capture-loss fallback): a unique path per test removes the
   *  shared resource instead of timing around it. Returns the home to
   *  pass to runRelay. */
  async function listen(handler: Parameters<typeof createServer>[1]): Promise<string> {
    if (server) await new Promise<void>((resolveClose) => server!.close(() => resolveClose()));
    const home = mkdtempSync(join(tmpdir(), 'cairn-relay-home-'));
    mkdirSync(join(home, DATA_DIR_NAME), { recursive: true });
    homes.push(home);
    server = createServer(handler);
    await new Promise<void>((resolveListen) =>
      server!.listen(join(home, DATA_DIR_NAME, 'hook-daemon.sock'), () => resolveListen()));
    return home;
  }

  it('falls back to direct-node exec on daemon 404 instead of printing the error body', async (t) => {
    if (skipReason) return t.skip(skipReason);
    writeFileSync(
      join(tmpBinDir, 'unrouted-hook.js'),
      `const data = require('fs').readFileSync(0, 'utf8');\nprocess.stdout.write('FALLBACK:' + data.trim());\n`,
    );
    const fakeHome = await listen((req, res) => afterBody(req, () => {
      res.writeHead(404);
      res.end('Unknown route: /unrouted-hook');
    }));

    const result = await runRelay(join(tmpBinDir, 'hook-relay'), 'unrouted-hook', '{"session_id":"s1"}', fakeHome);

    assert.equal(result.status, 0);
    assert.ok(!result.stdout.includes('Unknown route'), 'error body must not leak to stdout');
    assert.equal(result.stdout, 'FALLBACK:{"session_id":"s1"}');
  });

  it('sends the full Content-Length body even when input contains NUL bytes', async (t) => {
    if (skipReason) return t.skip(skipReason);
    const fakeHome = await listen((req, res) => {
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
    const fakeHome = await listen((req, res) => afterBody(req, () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"decision":"allow","note":"ok"}');
    }));

    const result = await runRelay(join(tmpBinDir, 'hook-relay'), 'ok-hook', '{}', fakeHome, GENEROUS_DAEMON_ENV);

    assert.equal(result.status, 0);
    assert.equal(result.stdout, '{"decision":"allow","note":"ok"}');
  });
});
