/**
 * Canary for the hermetic-env preload: asserts every test process runs with
 * Cairn state redirected away from the real home directory. If this fails,
 * the --require preload in package.json's test script was removed or node's
 * test runner stopped propagating execArgv to test child processes — either
 * way, tests would silently start touching real ~/.cairn again.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
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
});
