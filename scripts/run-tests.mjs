#!/usr/bin/env node
/**
 * Test-runner wrapper with a zero-test guard.
 *
 * A bare `node --test <glob>` exits 0 when the glob matches nothing (missing
 * build, moved directory, typo), so a broken invocation passes CI silently.
 * This wrapper fails when zero test files are discovered, and — as a
 * fail-closed belt — when the TAP plan is absent or reports zero tests.
 *
 * Usage: node scripts/run-tests.mjs [testDir]   (default: dist/tests)
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_TEST_DIR = join(REPO_ROOT, 'dist', 'tests');
const TEST_FILE_SUFFIX = '.test.js';
const HERMETIC_PRELOAD = join(REPO_ROOT, 'tests', 'hermetic-env.cjs');

/**
 * Fail before spawning ANY test child if the generated identity is stale.
 *
 * The hermetic preload reads dist/generated/identity.json to learn which env
 * vars to redirect. `npm test` does not rebuild, and `npm run dev` is only a
 * TypeScript watch — so a namespace change compiled without `npm run build`
 * would leave the preload setting the OLD names while the code reads the NEW
 * ones. Every override would go unread, the whole suite would operate on the
 * developer's REAL home directory, and it would still pass.
 *
 * The in-suite drift test cannot cover this: by the time it runs, the children
 * are already started and the damage is done. This check has to be here.
 */
async function assertIdentityFresh() {
  const path = join(REPO_ROOT, 'dist', 'generated', 'identity.json');
  let generated;
  try {
    generated = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (err) {
    console.error(`run-tests: cannot read ${path} (${err.code ?? err.message}) — run \`npm run build\` first.`);
    process.exit(1);
  }
  const contract = await import(join(REPO_ROOT, 'packages', 'contract', 'dist', 'identity.js'));
  const drift = [];
  if (generated.NAMESPACE !== contract.NAMESPACE) drift.push(`NAMESPACE ${generated.NAMESPACE} != ${contract.NAMESPACE}`);
  if (generated.DATA_DIR !== contract.DATA_DIR_NAME) drift.push(`DATA_DIR ${generated.DATA_DIR} != ${contract.DATA_DIR_NAME}`);
  if (generated.ENV_PREFIX !== contract.ENV_PREFIX) drift.push(`ENV_PREFIX ${generated.ENV_PREFIX} != ${contract.ENV_PREFIX}`);
  if (drift.length) {
    console.error(
      'run-tests: dist/generated/identity.json is STALE relative to the contract:\n  ' +
      drift.join('\n  ') +
      '\nRefusing to run: the hermetic preload would set the old variable names and the suite ' +
      'would read and write your REAL home directory while still passing. Run `npm run build`.',
    );
    process.exit(1);
  }
}
// Root-level TAP plan ("1..N" at column 0); subtests are indented.
const TAP_PLAN_PATTERN = /^1\.\.(\d+)$/m;

function discoverTestFiles(dir) {
  try {
    const files = [];
    const pending = [dir];
    while (pending.length > 0) {
      const current = pending.pop();
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const path = join(current, entry.name);
        if (entry.isDirectory()) pending.push(path);
        else if (entry.isFile() && entry.name.endsWith(TEST_FILE_SUFFIX)) files.push(path);
      }
    }
    return files.sort();
  } catch {
    return [];
  }
}

async function main() {
  const testDir = process.argv[2] ? resolve(process.argv[2]) : DEFAULT_TEST_DIR;
  const files = discoverTestFiles(testDir);
  if (files.length === 0) {
    console.error(
      `run-tests: zero test files matching *${TEST_FILE_SUFFIX} under ${testDir} — failing (did the build run?)`,
    );
    return 1;
  }

  const tapDir = mkdtempSync(join(tmpdir(), 'waykeep-tap-'));
  const tapPath = join(tapDir, 'results.tap');
  // When invoked from inside another node:test process (e.g. this wrapper's
  // own guard tests), the inherited NODE_TEST_CONTEXT makes the child runner
  // "skip running files" and exit 0 with zero tests — strip it so the child
  // is always a fresh top-level runner.
  await assertIdentityFresh();

  const childEnv = { ...process.env };
  delete childEnv.NODE_TEST_CONTEXT;
  try {
    const result = spawnSync(
      process.execPath,
      [
        '--experimental-vm-modules',
        '--require',
        HERMETIC_PRELOAD,
        '--test',
        '--test-reporter=spec',
        '--test-reporter-destination=stdout',
        '--test-reporter=tap',
        `--test-reporter-destination=${tapPath}`,
        ...files,
      ],
      { cwd: REPO_ROOT, stdio: 'inherit', env: childEnv },
    );
    if (result.status !== 0) return result.status ?? 1;

    let tap = '';
    try {
      tap = readFileSync(tapPath, 'utf8');
    } catch {
      // Missing reporter output falls through to the fail-closed check.
    }
    const plan = tap.match(TAP_PLAN_PATTERN);
    if (!plan) {
      console.error(
        'run-tests: no TAP plan found in reporter output — failing closed (zero-test guard)',
      );
      return 1;
    }
    const testCount = Number(plan[1]);
    if (testCount === 0) {
      console.error(
        `run-tests: ${files.length} test file(s) discovered but zero tests executed — failing`,
      );
      return 1;
    }
    console.error(
      `run-tests: zero-test guard satisfied (${testCount} top-level tests, ${files.length} files)`,
    );
    return 0;
  } finally {
    rmSync(tapDir, { recursive: true, force: true });
  }
}

process.exit(await main());
