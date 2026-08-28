/**
 * GAP A — hook-relay binary must fall back to direct-node exec when the
 * daemon socket is missing. This is the regression guarantee that keeps
 * every relay-routed hook running during MCP server restart / crash /
 * cold-boot race instead of silently no-opping.
 *
 * Driven through the shared async-spawn harness (relay-harness.ts), which
 * matches production stdin delivery; see the harness header for why
 * spawnSync(..., { input }) is avoided.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { prepareRelayDir, runRelay } from './relay-harness.js';
import { nodeGrandchildSkipReason } from './spawn-probe.js';

/** Make a fake HOME with ~/.cairn present so the relay's fallback diagnostics
 *  land in hook-relay-fallback.log (log_fallback creates the file, not the dir). */
function makeFakeHome(prefix: string): string {
  const home = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(home, '.cairn'), { recursive: true });
  return home;
}

function readRelayLog(home: string): string {
  try {
    return readFileSync(join(home, '.cairn', 'hook-relay-fallback.log'), 'utf8');
  } catch {
    return '(no fallback log written)';
  }
}

describe('GAP A — hook-relay exec fallback on missing socket', () => {
  let tmpBinDir: string;

  before(() => {
    tmpBinDir = prepareRelayDir('cairn-relay-test');
  });

  after(() => {
    rmSync(tmpBinDir, { recursive: true, force: true });
  });

  it('executes fallback JS script when socket is missing and forwards stdin', async (t) => {
    // The fallback is a C parent fork+exec'ing node — sandboxes that deny
    // that (grandchild exec) can't run this regression regardless of relay
    // correctness. The relay logs fallback-exec-node-fail there; see the
    // relay log surfaced in this test's failure message when it does fail.
    const skip = nodeGrandchildSkipReason();
    if (skip) return t.skip(skip);

    // Stub JS that writes a marker file into HOME before touching stdout,
    // so a failure can distinguish "script ran but stdout was lost in
    // transit" from "script never ran at all".
    writeFileSync(
      join(tmpBinDir, 'fake-hook.js'),
      [
        `const fs = require('fs');`,
        `const data = fs.readFileSync(0, 'utf8');`,
        `fs.writeFileSync(process.env.HOME + '/hook-ran.marker', 'ran:' + data.trim());`,
        `process.stdout.write('FALLBACK:' + data.trim());`,
        ``,
      ].join('\n'),
    );

    const fakeHome = makeFakeHome('cairn-fake-home-');
    try {
      const result = await runRelay(join(tmpBinDir, 'hook-relay'), 'fake-hook', '{"session_id":"abc123"}', fakeHome);
      const diag = () => {
        const markerPath = join(fakeHome, 'hook-ran.marker');
        let marker: string;
        try {
          marker = `marker: ${readFileSync(markerPath, 'utf8')} (script RAN — stdout lost in transit)`;
        } catch {
          marker = 'marker: absent (script never ran)';
        }
        return [
          `signal=${result.signal} stderr=[${result.stderr}]`,
          marker,
          `relay fallback log:\n${readRelayLog(fakeHome)}`,
        ].join('\n');
      };
      assert.equal(result.status, 0, diag());
      assert.equal(result.stdout, 'FALLBACK:{"session_id":"abc123"}', diag());
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it('exits silently (no output) when fallback script does not exist', async () => {
    const fakeHome = makeFakeHome('cairn-fake-home-2-');
    try {
      const result = await runRelay(join(tmpBinDir, 'hook-relay'), 'nonexistent-hook-abc', '{}', fakeHome);
      assert.equal(result.status, 0);
      assert.equal(result.stdout, '');
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });
});
