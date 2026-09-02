/**
 * Canary for the hermetic-env preload: asserts every test process runs with
 * Cairn state redirected away from the real home directory. If this fails,
 * the --require preload in package.json's test script was removed or node's
 * test runner stopped propagating execArgv to test child processes — either
 * way, tests would silently start touching real ~/.cairn again.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

import { getTrackerPath } from '../src/hooks/shared/edit-tracker.js';
import { ENV } from '../src/constants/env.js';

describe('hermetic test environment', () => {
  it('CAIRN_DIR is overridden away from the real ~/.cairn', () => {
    assert.ok(process.env[ENV.DIR], 'preload must set CAIRN_DIR');
    assert.notEqual(process.env[ENV.DIR], join(homedir(), '.cairn'));
    assert.ok(getTrackerPath('canary').startsWith(process.env[ENV.DIR] as string));
  });

  it('CAIRN_STATE_PATH is overridden away from the real ~/.claude', () => {
    assert.ok(process.env[ENV.STATE_PATH], 'preload must set CAIRN_STATE_PATH');
    assert.notEqual(
      process.env[ENV.STATE_PATH],
      join(homedir(), '.claude', 'cairn-state.json'),
    );
  });

  it('Claude Code wiring targets are overridden away from the real home, and the real CLI is unreachable', () => {
    // `waykeep init` writes settings.json and drives `claude mcp` against
    // ~/.claude.json; a test running init with these unset would rewire the
    // developer's real Claude Code (the same hazard class as the plugin
    // launcher's real-home cache leak).
    assert.ok(process.env[ENV.CLAUDE_SETTINGS], 'preload must set the settings override');
    assert.notEqual(process.env[ENV.CLAUDE_SETTINGS], join(homedir(), '.claude', 'settings.json'));
    assert.ok(process.env[ENV.CLAUDE_CONFIG], 'preload must set the registry override');
    assert.notEqual(process.env[ENV.CLAUDE_CONFIG], join(homedir(), '.claude.json'));
    assert.ok(process.env[ENV.CLAUDE_BIN], 'preload must set the CLI override');
    assert.equal(existsSync(process.env[ENV.CLAUDE_BIN] as string), false, 'the CLI override must point at nothing');
  });
});
