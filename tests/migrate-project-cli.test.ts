import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/db/connection.js';
import { MemoryRepository } from '../src/db/memory-repository.js';
import { runMigrateProject } from '../src/cli/migrate-project.js';
import { projectId, __resetProjectIdCacheForTests } from '../src/utils/project-id.js';
import { resetConfigCacheForTests } from '../src/config/cairn-config.js';

const cleanup: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(dir);
  return dir;
}

/** A fake repo whose origin remote yields a deterministic remote-derived id. */
function repoWithRemote(remoteUrl: string): string {
  const dir = tempDir('waykeep-migtest-');
  mkdirSync(join(dir, '.git'));
  writeFileSync(join(dir, '.git', 'config'),
    `[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = ${remoteUrl}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`);
  return dir;
}

const OLD_ID = 'oldname-12345678';
const savedEnv: Record<string, string | undefined> = {};

function seedDb(dbPath: string, project: string, content: string): string {
  const db = openDatabase({ dbPath });
  try {
    return new MemoryRepository(db).create({ content, kind: 'fact', project, skipDedup: true }).id;
  } finally {
    db.close();
  }
}

function projectOf(dbPath: string, memoryId: string): string | undefined {
  const db = openDatabase({ dbPath });
  try {
    return new MemoryRepository(db).findById(memoryId)?.project ?? undefined;
  } finally {
    db.close();
  }
}

beforeEach(() => {
  savedEnv.CAIRN_DB_PATH = process.env.CAIRN_DB_PATH;
  savedEnv.CAIRN_CONFIG_PATH = process.env.CAIRN_CONFIG_PATH;
  process.env.CAIRN_DB_PATH = join(tempDir('waykeep-migdb-'), 'test.db');
  process.env.CAIRN_CONFIG_PATH = join(tempDir('waykeep-migcfg-'), 'config.json');
  resetConfigCacheForTests();
  __resetProjectIdCacheForTests();
});

after(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetConfigCacheForTests();
  for (const dir of cleanup) rmSync(dir, { recursive: true, force: true });
});

describe('migrate-project CLI', () => {
  it('moves rows from the old id to the current project id', () => {
    const repo = repoWithRemote('git@github.com:acme/renamed.git');
    const dbPath = process.env.CAIRN_DB_PATH as string;
    const memoryId = seedDb(dbPath, OLD_ID, 'survives the remote rename');

    assert.equal(runMigrateProject({ oldId: OLD_ID, dryRun: false, cwd: repo }), 0);
    assert.equal(projectOf(dbPath, memoryId), projectId(repo));
  });

  it('dry run reports without writing', () => {
    const repo = repoWithRemote('git@github.com:acme/renamed.git');
    const dbPath = process.env.CAIRN_DB_PATH as string;
    const memoryId = seedDb(dbPath, OLD_ID, 'stays put on dry run');

    assert.equal(runMigrateProject({ oldId: OLD_ID, dryRun: true, cwd: repo }), 0);
    assert.equal(projectOf(dbPath, memoryId), OLD_ID);
  });

  it('refuses when the old id already is the current id', () => {
    const repo = repoWithRemote('git@github.com:acme/renamed.git');
    assert.equal(runMigrateProject({ oldId: projectId(repo), dryRun: false, cwd: repo }), 1);
  });

  it('refuses a malformed project id', () => {
    const repo = repoWithRemote('git@github.com:acme/renamed.git');
    assert.equal(runMigrateProject({ oldId: 'bad id with spaces', dryRun: false, cwd: repo }), 1);
  });

  it('errors when the old id has no rows', () => {
    const repo = repoWithRemote('git@github.com:acme/renamed.git');
    assert.equal(runMigrateProject({ oldId: OLD_ID, dryRun: false, cwd: repo }), 1);
  });

  it('fails closed when the old project is private and the current id is not', () => {
    const repo = repoWithRemote('git@github.com:acme/renamed.git');
    const dbPath = process.env.CAIRN_DB_PATH as string;
    const memoryId = seedDb(dbPath, OLD_ID, 'private content must not lose its scope');
    writeFileSync(process.env.CAIRN_CONFIG_PATH as string,
      JSON.stringify({ scope: { privateProjects: [OLD_ID] } }));
    resetConfigCacheForTests();

    assert.equal(runMigrateProject({ oldId: OLD_ID, dryRun: false, cwd: repo }), 1);
    assert.equal(projectOf(dbPath, memoryId), OLD_ID);
  });

  it('migrates when both the old and current ids are private', () => {
    const repo = repoWithRemote('git@github.com:acme/renamed.git');
    const dbPath = process.env.CAIRN_DB_PATH as string;
    const memoryId = seedDb(dbPath, OLD_ID, 'private content moving to a private id');
    writeFileSync(process.env.CAIRN_CONFIG_PATH as string,
      JSON.stringify({ scope: { privateProjects: [OLD_ID, projectId(repo)] } }));
    resetConfigCacheForTests();

    assert.equal(runMigrateProject({ oldId: OLD_ID, dryRun: false, cwd: repo }), 0);
    assert.equal(projectOf(dbPath, memoryId), projectId(repo));
  });
});
