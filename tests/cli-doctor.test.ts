import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Compiled CLI: dist/tests/ -> dist/src/cli/index.js
const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli', 'index.js');

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cairn-doctor-'));
  dirs.push(dir);
  return dir;
}

/** Spawn the compiled CLI. Pin the default (pinned) embedding model so the
 *  embedding check is deterministically OK unless a case overrides it. */
function run(env: Record<string, string>, args: string[] = ['doctor']): SpawnSyncReturns<string> {
  // encoding: 'utf8' makes stdout/stderr strings at runtime; the cast reflects that.
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, CAIRN_EMBEDDING_MODEL: 'minilm-l6', ...env },
  }) as SpawnSyncReturns<string>;
}

describe('cairn doctor CLI', () => {
  it('exits 0 and reports no-database when the DB path does not exist, without creating it', () => {
    const dir = tempDir();
    const dbPath = join(dir, 'absent', 'cairn.db');
    const result = run({ CAIRN_DIR: dir, CAIRN_DB_PATH: dbPath });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /no database yet/u);
    assert.equal(existsSync(dbPath), false, 'doctor must not create the database');
  });

  it('exits 1 with a failing database check when the DB file is not sqlite', () => {
    const dir = tempDir();
    const dbPath = join(dir, 'garbage.db');
    writeFileSync(dbPath, 'this is not a sqlite database');
    const result = run({ CAIRN_DIR: dir, CAIRN_DB_PATH: dbPath });
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stdout, /✗ database/u);
  });

  it('exits 1 when the selected embedding model is unpinned (server would refuse to boot)', () => {
    const dir = tempDir();
    const result = run({
      CAIRN_DIR: dir,
      CAIRN_DB_PATH: join(dir, 'x.db'),
      CAIRN_EMBEDDING_MODEL: 'embeddinggemma-300m',
    });
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stdout, /embedding model.*unpinned/u);
  });

  it('exits 1 and prints usage on an unknown subcommand', () => {
    const result = run({}, ['frobnicate']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /unknown command/u);
    assert.match(result.stdout, /Usage:/u);
  });

  it('exits 0 and prints usage for --help', () => {
    const result = run({}, ['--help']);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Usage:/u);
  });
});
