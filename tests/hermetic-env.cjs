/**
 * Hermetic test environment preload (--require, CJS so it runs before any ESM).
 *
 * node --test spawns each test file as a child process with the same execArgv,
 * so this runs once per test process. It points Cairn's mutable state at a
 * per-process temp dir unless the caller already set an override, guaranteeing
 * tests never read or write the real state dir or client state file —
 * required for sandboxed/read-only-home environments (EROFS) and to keep live
 * Cairn state from changing test behavior.
 *
 * The DB is not redirected here: tests open ':memory:' explicitly, and
 * the DB_PATH override is only read by hook entrypoints, which tests don't spawn.
 */
'use strict';
const { mkdtempSync, rmSync, readFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

// Namespace-derived names, from the build-time generator. This file is CJS so
// it can preload before any ESM, which rules out importing the contract
// directly (require(ESM) needs Node >= 20.19, below our declared engines
// floor). Read the generated JSON instead.
//
// THROW, never default: if these names went stale the overrides below would
// set variables nothing reads, every test would fall through to the real home
// directory, and the whole suite would still pass. A missing build must be
// loud.
const IDENTITY_PATH = join(__dirname, '..', 'dist', 'generated', 'identity.json');
let ID;
try {
  ID = JSON.parse(readFileSync(IDENTITY_PATH, 'utf-8'));
} catch (err) {
  throw new Error(
    `hermetic preload cannot read ${IDENTITY_PATH} (${err.code || err.message}). ` +
    'Run `npm run build` first — without it the suite would silently read and write your real home directory.',
  );
}
const E = ID.ENV || {};

// A JSON from an older generator can parse fine yet lack a key. `E.DIR` would
// then be undefined, `process.env[undefined]` would set the literal key
// "undefined", the real override would stay unset, and the suite would run
// against the real home while passing. Validate before using any of them.
for (const key of ['DIR', 'STATE_PATH', 'QUERY_CWD', 'CODEX_DIR', 'CONFIG_PATH', 'ALLOW_TMP_TRANSCRIPTS',
  'CLAUDE_SETTINGS', 'CLAUDE_CONFIG', 'CLAUDE_BIN']) {
  if (typeof E[key] !== 'string' || !E[key]) {
    throw new Error(
      `hermetic preload: ${IDENTITY_PATH} is missing ENV.${key} — stale or partial generator output. ` +
      'Run `npm run build`; without every override the suite would use your real home directory.',
    );
  }
}
for (const key of ['NAMESPACE', 'DATA_DIR', 'CLIENT_STATE_FILE']) {
  if (typeof ID[key] !== 'string' || !ID[key]) {
    throw new Error(`hermetic preload: ${IDENTITY_PATH} is missing ${key} — run \`npm run build\`.`);
  }
}
// The legacy-env scrub below depends on this list; a stale artifact that
// lacks it would silently disable the scrub and let a developer's real
// CAIRN_* leak into hermetic runs. Fail loud instead.
if (!Array.isArray(ID.LEGACY_ENV_PREFIXES)) {
  throw new Error(
    `hermetic preload: ${IDENTITY_PATH} is missing LEGACY_ENV_PREFIXES — stale generator output. ` +
    'Run `npm run build`; without it the legacy-env scrub is disabled and the suite could inherit a real CAIRN_* env.',
  );
}

// Scrub a developer's real LEGACY-prefixed env (CAIRN_*) BEFORE any module
// runs the transitional legacy-env bootstrap (constants/env.js copies
// CAIRN_X → WAYKEEP_X for unset current names). Without this, a developer
// with CAIRN_DB_PATH exported would have it inherited into the hermetic
// run and the suite could touch a real store. Derived from the generated
// legacy prefixes so it needs no maintenance across future renames.
for (const prefix of ID.LEGACY_ENV_PREFIXES || []) {
  for (const name of Object.keys(process.env)) {
    if (name.startsWith(`${prefix}_`)) delete process.env[name];
  }
}

const dir = mkdtempSync(join(tmpdir(), `${ID.NAMESPACE}-hermetic-`));

if (!process.env[E.DIR]) process.env[E.DIR] = join(dir, ID.DATA_DIR);
if (!process.env[E.STATE_PATH]) {
  process.env[E.STATE_PATH] = join(dir, ID.CLIENT_STATE_FILE);
}
// A1: pin the briefing query-fp cwd signal to a token-free basename ('x' is
// under the 3-char token floor) so test behavior can't depend on what the
// checkout directory happens to be called.
if (!process.env[E.QUERY_CWD]) process.env[E.QUERY_CWD] = '/x';

// Parity step 5: `cairn init`/`doctor` read and WRITE the Codex config dir —
// point it at the hermetic temp dir so a test can never touch ~/.codex.
if (!process.env[E.CODEX_DIR]) process.env[E.CODEX_DIR] = join(dir, '.codex');

// `waykeep init` writes ~/.claude/settings.json and shells out to the `claude`
// CLI to edit ~/.claude.json. Point the settings file and the registry into
// the hermetic dir, and the CLI at a path that does not exist, so a test that
// runs init can never rewire the developer's real Claude Code — nor spawn the
// real CLI against it. Tests that need a CLI plant their own fake.
if (!process.env[E.CLAUDE_SETTINGS]) process.env[E.CLAUDE_SETTINGS] = join(dir, '.claude', 'settings.json');
if (!process.env[E.CLAUDE_CONFIG]) process.env[E.CLAUDE_CONFIG] = join(dir, '.claude.json');
if (!process.env[E.CLAUDE_BIN]) process.env[E.CLAUDE_BIN] = join(dir, 'claude-cli-absent');

// Phase 1 step 3: scope policy reads ~/.cairn/config.json — point it at a
// (nonexistent) hermetic path so a developer's real scope config can never
// shape test behavior; tests that need a config write this file themselves.
if (!process.env[E.CONFIG_PATH]) process.env[E.CONFIG_PATH] = join(dir, `${ID.NAMESPACE}-config.json`);

// M3: production only trusts transcripts under ~/.claude/; tests write
// fixtures via mkdtemp, so opt the OS tmpdir into the allowlist here.
process.env[E.ALLOW_TMP_TRANSCRIPTS] = '1';
// Step-5 review HOLD: a developer's CAIRN_RERANK=1 must not leak into
// hermetic runs — tests choose their reranker explicitly via injection.
process.env[E.RERANK] = '0';

process.on('exit', () => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort — OS temp cleanup is the backstop */
  }
});
