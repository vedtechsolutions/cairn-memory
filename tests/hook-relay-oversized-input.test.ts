/**
 * Oversized hook inputs (> CAIRN_MAX_INPUT, 256 KB) must reach the JS hook
 * intact. The relay buffers stdin into a fixed 256 KB buffer; before this
 * fix an oversized payload was silently truncated there, so BOTH delivery
 * paths (daemon socket and buffered fallback) received unparseable JSON —
 * observed live 2026-08-25 as a success-tracker "Unterminated string in
 * JSON at position 260451". The relay now detects buffer-full-before-EOF,
 * skips the socket entirely, and streams the buffered prefix plus the
 * unread remainder of stdin to the direct-node hook.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { prepareRelayDir, runRelay } from './relay-harness.js';
import { nodeGrandchildSkipReason } from './spawn-probe.js';
import { DATA_DIR_NAME } from 'waykeep-contract';

const RELAY_BUFFER_CAP = 256 * 1024;

function makeFakeHome(prefix: string): string {
  const home = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(home, DATA_DIR_NAME), { recursive: true });
  return home;
}

function readRelayLog(home: string): string {
  try {
    return readFileSync(join(home, DATA_DIR_NAME, 'hook-relay-fallback.log'), 'utf8');
  } catch {
    return '(no fallback log written)';
  }
}

describe('hook-relay — oversized stdin streams to the fallback intact', () => {
  let tmpBinDir: string;

  before(() => {
    tmpBinDir = prepareRelayDir('cairn-relay-big');
    // Stub hook: read ALL of stdin, prove it arrived intact (byte length +
    // JSON parses + payload survives), report via marker file AND stdout.
    writeFileSync(
      join(tmpBinDir, 'big-hook.js'),
      [
        `const fs = require('fs');`,
        `const data = fs.readFileSync(0, 'utf8');`,
        `let verdict;`,
        `try {`,
        `  const obj = JSON.parse(data);`,
        `  verdict = 'parsed len=' + data.length + ' payload=' + obj.payload.length;`,
        `} catch (e) {`,
        `  verdict = 'PARSE-FAIL len=' + data.length + ' err=' + e.message;`,
        `}`,
        `fs.writeFileSync(process.env.HOME + '/big-hook.marker', verdict);`,
        `process.stdout.write(verdict);`,
        ``,
      ].join('\n'),
    );
  });

  after(() => {
    rmSync(tmpBinDir, { recursive: true, force: true });
  });

  it('delivers a payload larger than the 256 KB buffer without truncation', async (t) => {
    const skip = nodeGrandchildSkipReason();
    if (skip) return t.skip(skip);

    // Comfortably past the cap so several streamed chunks are exercised.
    const payload = 'x'.repeat(RELAY_BUFFER_CAP * 2 + 12_345);
    const input = JSON.stringify({ session_id: 'big', payload });
    assert.ok(input.length > RELAY_BUFFER_CAP, 'test input must exceed the relay buffer');

    const fakeHome = makeFakeHome('cairn-big-home-');
    try {
      const result = await runRelay(join(tmpBinDir, 'hook-relay'), 'big-hook', input, fakeHome);
      const diag = () =>
        `status=${result.status} signal=${result.signal} stdout=${result.stdout.slice(0, 200)} ` +
        `stderr=${result.stderr.slice(0, 200)} relay-log:\n${readRelayLog(fakeHome)}`;

      assert.equal(result.status, 0, `relay should exit 0 — ${diag()}`);
      assert.equal(
        result.stdout,
        `parsed len=${input.length} payload=${payload.length}`,
        `hook must receive the FULL untruncated JSON — ${diag()}`,
      );
      assert.match(
        readRelayLog(fakeHome),
        /input-overflow-stream/,
        'the oversized path must be diagnosable in the fallback log',
      );
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it('still delivers small inputs through the plain buffered fallback', async (t) => {
    const skip = nodeGrandchildSkipReason();
    if (skip) return t.skip(skip);

    const input = JSON.stringify({ session_id: 'small', payload: 'tiny' });
    const fakeHome = makeFakeHome('cairn-small-home-');
    try {
      const result = await runRelay(join(tmpBinDir, 'hook-relay'), 'big-hook', input, fakeHome);
      assert.equal(result.status, 0);
      assert.equal(result.stdout, `parsed len=${input.length} payload=4`);
      assert.doesNotMatch(readRelayLog(fakeHome), /input-overflow-stream/);
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });
});
