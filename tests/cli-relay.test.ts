import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveRelay, binaryUsable } from '../src/cli/relay.js';
import { waykeepHooks } from '../src/cli/init.js';
import { RELAY_PROBE_FLAG, RELAY_PROBE_SENTINEL, NAMESPACE } from 'waykeep-contract';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

/** A hook dir that always has the shell relay (as the package ships), and
 *  optionally the compiled binary. */
function hookDir(withBinary: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), `${NAMESPACE}-relay-`));
  dirs.push(dir);
  writeFileSync(join(dir, 'hook-relay.sh'), '#!/usr/bin/env bash\n');
  if (withBinary) {
    const bin = join(dir, 'hook-relay');
    // Stand-in relay: answers the probe handshake like the real binary. Both
    // halves come from the contract — a literal here would mask exactly the
    // generator/detector split this test exists to catch.
    writeFileSync(bin, `#!/bin/sh\n[ "$1" = "${RELAY_PROBE_FLAG}" ] && echo ${RELAY_PROBE_SENTINEL}\nexit 0\n`);
    chmodSync(bin, 0o755);
  }
  return dir;
}

describe('relay resolution', () => {
  it('prefers the compiled binary when it is present and executable', () => {
    const dir = hookDir(true);
    assert.equal(binaryUsable(dir), true);
    const relay = resolveRelay(dir);
    assert.equal(relay.kind, 'binary');
    assert.ok(relay.command.endsWith('hook-relay'), 'binary command is the plain binary path');
  });

  it('falls back to the shell relay when the binary is absent', () => {
    const dir = hookDir(false);
    assert.equal(binaryUsable(dir), false);
    const relay = resolveRelay(dir);
    assert.equal(relay.kind, 'shell');
    assert.match(relay.command, /^bash .*hook-relay\.sh$/u, 'shell command invokes bash on hook-relay.sh');
  });

  it('rejects a present-but-non-runnable binary and falls back (wrong-arch / not the relay)', () => {
    const dir = hookDir(false);
    // A +x file that is not the relay: execvp falls back to /bin/sh (exit 127),
    // so only the missing probe sentinel distinguishes it — the exact
    // case where an exec-bit check would wrongly trust it (e.g. as root).
    const bin = join(dir, 'hook-relay');
    writeFileSync(bin, 'not the cairn relay\n');
    chmodSync(bin, 0o755);
    assert.equal(binaryUsable(dir), false);
    assert.equal(resolveRelay(dir).kind, 'shell');
  });
});

describe('hook config generation per relay form', () => {
  it('renders every hook command against the shell-fallback relay prefix', () => {
    const prefix = 'bash /pkg/dist/src/hooks/hook-relay.sh';
    const hooks = waykeepHooks(prefix);
    assert.equal(hooks.SessionStart[0].hooks[0].command, `${prefix} session-start`);
    // async flag preserved through the shell form
    assert.equal(hooks.PostToolUseFailure[0].hooks[0].command, `${prefix} error-learning`);
    assert.equal(hooks.PostToolUseFailure[0].hooks[0].async, true);
    // Stop keeps governance-gate (sync) before stop (async)
    assert.equal(hooks.Stop[0].hooks[0].command, `${prefix} governance-gate`);
    assert.equal(hooks.Stop[0].hooks[0].async, undefined);
    assert.equal(hooks.Stop[0].hooks[1].command, `${prefix} stop`);
    assert.equal(hooks.Stop[0].hooks[1].async, true);
  });
});
