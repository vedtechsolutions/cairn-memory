import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import {
  captureWorktreeDigestV2, WORKTREE_DIGEST_HARD_CEILING_MS,
} from '../src/governance/worktree-digest.js';
import { gitSpawnSkipReason } from './spawn-probe.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.length = 0;
});

function tempRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `cairn-digest-v2-${label}-`));
  roots.push(root);
  return root;
}

function run(root: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function initRepo(): string {
  const root = tempRoot('git');
  run(root, 'init', '-q');
  run(root, 'config', 'user.email', 'tests@cairn.invalid');
  run(root, 'config', 'user.name', 'Cairn Tests');
  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, 'docs'));
  writeFileSync(join(root, 'src', 'tracked.ts'), 'export const value = 1;\n');
  writeFileSync(join(root, 'docs', 'note.md'), 'outside\n');
  run(root, 'add', '.');
  run(root, 'commit', '-qm', 'initial');
  return root;
}

async function digest(root: string, paths: string[] = ['**']): Promise<string> {
  const result = await captureWorktreeDigestV2({
    projectRoot: root, relevantPaths: paths, configSha256: 'a'.repeat(64),
  });
  assert.equal(result.status, 'complete', result.reason ?? undefined);
  assert.equal(result.version, 2);
  assert.match(result.digest ?? '', /^[a-f0-9]{64}$/u);
  return result.digest!;
}

describe('governance worktree digest v2', () => {
  it('captures every v1 Git state class without hashing clean tracked worktree content', {
    skip: gitSpawnSkipReason() ?? false,
  }, async () => {
    const root = initRepo();
    const values = new Set<string>();
    values.add(await digest(root));

    writeFileSync(join(root, 'src', 'tracked.ts'), 'export const value = 2;\n');
    values.add(await digest(root));
    run(root, 'add', 'src/tracked.ts');
    values.add(await digest(root));

    writeFileSync(join(root, 'src', 'untracked.ts'), 'untracked\n');
    values.add(await digest(root));
    run(root, 'add', 'src/untracked.ts');
    run(root, 'mv', 'src/untracked.ts', 'src/renamed.ts');
    values.add(await digest(root));

    unlinkSync(join(root, 'src', 'tracked.ts'));
    values.add(await digest(root));
    writeFileSync(join(root, 'src', 'tracked.ts'), '#!/bin/sh\n');
    chmodSync(join(root, 'src', 'tracked.ts'), 0o755);
    values.add(await digest(root));
    symlinkSync('tracked.ts', join(root, 'src', 'link.ts'));
    values.add(await digest(root));

    assert.equal(values.size, 8, 'every v1 status/content class changes the v2 baseline');
  });

  it('excludes files outside an explicit relevant path set', {
    skip: gitSpawnSkipReason() ?? false,
  }, async () => {
    const root = initRepo();
    const before = await digest(root, ['src/**']);
    writeFileSync(join(root, 'docs', 'note.md'), 'unrelated change\n');
    assert.equal(await digest(root, ['src/**']), before);
    writeFileSync(join(root, 'src', 'tracked.ts'), 'relevant change\n');
    assert.notEqual(await digest(root, ['src/**']), before);
  });

  it('captures dirty and staged submodule worktree state', {
    skip: gitSpawnSkipReason() ?? false,
  }, async () => {
    const child = tempRoot('submodule-source');
    run(child, 'init', '-q');
    run(child, 'config', 'user.email', 'tests@cairn.invalid');
    run(child, 'config', 'user.name', 'Cairn Tests');
    writeFileSync(join(child, 'nested.txt'), 'clean\n');
    run(child, 'add', '.');
    run(child, 'commit', '-qm', 'nested');

    const root = initRepo();
    run(root, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', child, 'vendor/sub');
    run(root, 'commit', '-qam', 'submodule');
    const clean = await digest(root);
    writeFileSync(join(root, 'vendor', 'sub', 'nested.txt'), 'dirty\n');
    const dirty = await digest(root);
    assert.notEqual(dirty, clean);
    run(join(root, 'vendor', 'sub'), 'add', 'nested.txt');
    assert.notEqual(await digest(root), dirty);
  });

  it('records an explicit unborn HEAD marker', {
    skip: gitSpawnSkipReason() ?? false,
  }, async () => {
    const root = tempRoot('unborn');
    run(root, 'init', '-q');
    writeFileSync(join(root, 'first.txt'), 'not committed\n');
    const result = await captureWorktreeDigestV2({
      projectRoot: root, relevantPaths: ['**'], configSha256: 'c'.repeat(64),
    });
    assert.equal(result.status, 'complete', result.reason ?? undefined);
    assert.equal(result.repositoryKind, 'git');
  });

  it('uses a bounded non-Git manifest and records a second race as incomplete', async () => {
    const root = tempRoot('manifest');
    mkdirSync(join(root, 'src'));
    mkdirSync(join(root, 'docs'));
    writeFileSync(join(root, 'src', 'a.ts'), 'one\n');
    writeFileSync(join(root, 'docs', 'note.md'), 'outside\n');
    symlinkSync('a.ts', join(root, 'src', 'link.ts'));
    const before = await digest(root, ['src/**']);
    writeFileSync(join(root, 'docs', 'note.md'), 'outside two\n');
    assert.equal(await digest(root, ['src/**']), before);

    const raced = await captureWorktreeDigestV2({
      projectRoot: root, relevantPaths: ['src/**'], configSha256: 'b'.repeat(64),
      onSnapshot(snapshot) {
        if (snapshot === 1 || snapshot === 3) {
          writeFileSync(join(root, 'src', 'a.ts'), `race-${snapshot}\n`);
        }
      },
    });
    assert.equal(raced.status, 'incomplete');
    assert.equal(raced.digest, null);
    assert.equal(raced.attempts, 2);
    assert.match(raced.reason ?? '', /changed during both/u);
  });

  it('honors a monotonic deadline and stays below the generous correctness ceiling', {
    skip: gitSpawnSkipReason() ?? false,
  }, async () => {
    const root = initRepo();
    const expired = await captureWorktreeDigestV2({
      projectRoot: root, relevantPaths: ['**'], configSha256: 'd'.repeat(64),
      deadlineMs: performance.now() - 1,
    });
    assert.equal(expired.status, 'incomplete');
    assert.equal(expired.reason, 'digest deadline exceeded');

    for (let sample = 0; sample < 3; sample += 1) {
      const started = performance.now();
      const result = await captureWorktreeDigestV2({
        projectRoot: root, relevantPaths: ['**'], configSha256: 'e'.repeat(64),
        deadlineMs: started + WORKTREE_DIGEST_HARD_CEILING_MS,
      });
      const elapsed = performance.now() - started;
      assert.equal(result.status, 'complete', result.reason ?? undefined);
      assert.ok(elapsed <= WORKTREE_DIGEST_HARD_CEILING_MS,
        `digest exceeded correctness ceiling: ${elapsed.toFixed(2)}ms`);
    }
  });
});
