/**
 * Guard tests for scripts/run-tests.mjs: the wrapper must fail when zero
 * test files are discovered (a bare `node --test <glob>` exits 0 in that
 * case, letting a missing build pass CI silently) and pass through a
 * normal run untouched.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const RUNNER = join(REPO_ROOT, 'scripts', 'run-tests.mjs');

function runWrapper(testDir: string) {
  return spawnSync(process.execPath, [RUNNER, testDir], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
}

describe('run-tests zero-test guard', () => {
  it('fails with a clear error when zero test files are discovered', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cairn-guard-empty-'));
    try {
      const result = runWrapper(dir);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /zero test files/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails when the test directory does not exist', () => {
    const result = runWrapper(join(tmpdir(), 'cairn-guard-nonexistent-dir'));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /zero test files/);
  });

  it('recursively discovers and passes through a real passing test', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cairn-guard-pass-'));
    try {
      const nested = join(dir, 'nested');
      mkdirSync(nested);
      writeFileSync(
        join(nested, 'trivial.test.js'),
        "const { test } = require('node:test');\ntest('trivial passes', () => {});\n",
      );
      const result = runWrapper(dir);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stderr, /zero-test guard satisfied/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
