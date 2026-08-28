/**
 * Hermetic test environment preload (--require, CJS so it runs before any ESM).
 *
 * node --test spawns each test file as a child process with the same execArgv,
 * so this runs once per test process. It points Cairn's mutable state at a
 * per-process temp dir unless the caller already set an override, guaranteeing
 * tests never read or write the real ~/.cairn or ~/.claude/cairn-state.json —
 * required for sandboxed/read-only-home environments (EROFS) and to keep live
 * Cairn state from changing test behavior.
 *
 * The DB is not redirected here: tests open ':memory:' explicitly, and
 * CAIRN_DB_PATH is only read by hook entrypoints, which tests don't spawn.
 */
'use strict';
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const dir = mkdtempSync(join(tmpdir(), 'cairn-hermetic-'));

if (!process.env.CAIRN_DIR) process.env.CAIRN_DIR = join(dir, '.cairn');
if (!process.env.CAIRN_STATE_PATH) {
  process.env.CAIRN_STATE_PATH = join(dir, 'cairn-state.json');
}
// A1: pin the briefing query-fp cwd signal to a token-free basename ('x' is
// under the 3-char token floor) so test behavior can't depend on what the
// checkout directory happens to be called.
if (!process.env.CAIRN_QUERY_CWD) process.env.CAIRN_QUERY_CWD = '/x';

// Parity step 5: `cairn init`/`doctor` read and WRITE the Codex config dir —
// point it at the hermetic temp dir so a test can never touch ~/.codex.
if (!process.env.CAIRN_CODEX_DIR) process.env.CAIRN_CODEX_DIR = join(dir, '.codex');

// M3: production only trusts transcripts under ~/.claude/; tests write
// fixtures via mkdtemp, so opt the OS tmpdir into the allowlist here.
process.env.CAIRN_ALLOW_TMP_TRANSCRIPTS = '1';

process.on('exit', () => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort — OS temp cleanup is the backstop */
  }
});
