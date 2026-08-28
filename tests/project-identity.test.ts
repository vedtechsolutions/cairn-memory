import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  normalizeGitRemote, projectId, legacyProjectId, remoteProjectId, __resetProjectIdCacheForTests,
} from '../src/utils/project-id.js';
import { getGitRemote } from '../src/utils/project-scanner.js';
import { openDatabase } from '../src/db/connection.js';
import { MemoryRepository } from '../src/db/memory-repository.js';
import { resolveProjectParam } from '../src/db/project-resolver.js';
import { migrateProjectIdentity, __resetProjectMigrationForTests } from '../src/db/project-identity-migration.js';

const cleanup: string[] = [];
function repoWithRemote(remoteUrl: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'cairn-idtest-'));
  mkdirSync(join(dir, '.git'));
  writeFileSync(join(dir, '.git', 'config'),
    `[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = ${remoteUrl}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`);
  cleanup.push(dir);
  return dir;
}
function bareDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cairn-idtest-'));
  cleanup.push(dir);
  return dir;
}

after(() => {
  for (const dir of cleanup) rmSync(dir, { recursive: true, force: true });
});

describe('normalizeGitRemote', () => {
  for (const form of [
    'git@github.com:org/repo.git',
    'https://github.com/org/repo.git',
    'https://github.com/org/repo',
    'ssh://git@github.com/org/repo',
    'https://user:token@github.com/org/repo.git',
    'git@github.com:org/repo',
  ]) {
    it(`normalizes ${form} → github.com/org/repo`, () => {
      assert.equal(normalizeGitRemote(form), 'github.com/org/repo');
    });
  }
  it('preserves a non-default port', () => {
    assert.equal(normalizeGitRemote('ssh://git@gitlab.example.com:2222/org/repo.git'), 'gitlab.example.com:2222/org/repo');
  });
  it('strips a default port', () => {
    assert.equal(normalizeGitRemote('https://github.com:443/org/repo.git'), 'github.com/org/repo');
  });
  it('lowercases host, preserves path case', () => {
    assert.equal(normalizeGitRemote('git@GitHub.com:Org/Repo.git'), 'github.com/Org/Repo');
  });
  it('returns null for a hostless (file://) remote and for garbage', () => {
    assert.equal(normalizeGitRemote('file:///srv/repos/repo.git'), null);
    assert.equal(normalizeGitRemote('   '), null);
  });
});

describe('projectId / getGitRemote (fs-based, no subprocess)', () => {
  beforeEach(() => __resetProjectIdCacheForTests());

  it('reads the origin url straight from .git/config', () => {
    const dir = repoWithRemote('git@github.com:org/repo.git');
    assert.equal(getGitRemote(dir), 'git@github.com:org/repo.git');
  });

  it('falls back to the legacy path hash when there is no remote', () => {
    const dir = bareDir();
    assert.equal(projectId(dir), legacyProjectId(dir));
  });

  it('gives two different paths with the same remote the same id', () => {
    const a = repoWithRemote('git@github.com:org/shared.git');
    __resetProjectIdCacheForTests();
    const b = repoWithRemote('https://github.com/org/shared');
    __resetProjectIdCacheForTests();
    const idA = projectId(a);
    __resetProjectIdCacheForTests();
    const idB = projectId(b);
    assert.equal(idA, idB);
    assert.equal(idA, remoteProjectId('github.com/org/shared'));
    assert.notEqual(idA, legacyProjectId(a)); // remote id differs from path hash
  });
});

describe('migrateProjectIdentity', () => {
  beforeEach(() => { __resetProjectIdCacheForTests(); __resetProjectMigrationForTests(); });

  it('moves rows from the legacy id to the remote id, non-destructively', () => {
    const dir = repoWithRemote('git@github.com:org/migrate-me.git');
    const db = openDatabase({ dbPath: ':memory:' });
    try {
      const oldId = legacyProjectId(dir);
      __resetProjectIdCacheForTests();
      const newId = projectId(dir);
      assert.notEqual(oldId, newId);

      const repo = new MemoryRepository(db);
      const { id } = repo.create({ content: 'lesson stored under the old id', kind: 'fact', project: oldId, skipDedup: true });

      __resetProjectIdCacheForTests();
      migrateProjectIdentity(db, dir);

      assert.equal(repo.findById(id)?.project, newId, 'memory moved to the new id');
      assert.equal((db.prepare('SELECT count(*) n FROM memories WHERE project = ?').get(oldId) as { n: number }).n, 0, 'nothing left under old id');
      assert.ok(repo.findById(id)?.content.includes('lesson stored'), 'content preserved');
    } finally { db.close(); }
  });

  it('is idempotent — a second run changes nothing', () => {
    const dir = repoWithRemote('git@github.com:org/idem.git');
    const db = openDatabase({ dbPath: ':memory:' });
    try {
      const oldId = legacyProjectId(dir);
      const repo = new MemoryRepository(db);
      repo.create({ content: 'a', kind: 'fact', project: oldId, skipDedup: true });
      __resetProjectIdCacheForTests();
      const newId = projectId(dir);

      __resetProjectIdCacheForTests();
      migrateProjectIdentity(db, dir);
      __resetProjectMigrationForTests(); // force a real second pass, not the in-mem short-circuit
      __resetProjectIdCacheForTests();
      migrateProjectIdentity(db, dir);

      assert.equal((db.prepare('SELECT count(*) n FROM memories WHERE project = ?').get(newId) as { n: number }).n, 1, 'exactly one row, no duplication');
      assert.equal((db.prepare('SELECT count(*) n FROM memories WHERE project = ?').get(oldId) as { n: number }).n, 0);
    } finally { db.close(); }
  });

  it('merges append-only rows losslessly when both ids already have rows', () => {
    const dir = repoWithRemote('git@github.com:org/collide.git');
    const db = openDatabase({ dbPath: ':memory:' });
    try {
      const oldId = legacyProjectId(dir);
      __resetProjectIdCacheForTests();
      const newId = projectId(dir);
      const repo = new MemoryRepository(db);
      repo.create({ content: 'from old clone path', kind: 'fact', project: oldId, skipDedup: true });
      repo.create({ content: 'from new clone path', kind: 'fact', project: newId, skipDedup: true });

      __resetProjectIdCacheForTests();
      migrateProjectIdentity(db, dir);

      assert.equal((db.prepare('SELECT count(*) n FROM memories WHERE project = ?').get(newId) as { n: number }).n, 2, 'both memories under the new id');
      assert.equal((db.prepare('SELECT count(*) n FROM memories WHERE project = ?').get(oldId) as { n: number }).n, 0);
    } finally { db.close(); }
  });

  it('resolves keyed-cache collisions by recency (governance_client_state)', () => {
    const dir = repoWithRemote('git@github.com:org/keyed.git');
    const db = openDatabase({ dbPath: ':memory:' });
    try {
      const oldId = legacyProjectId(dir);
      __resetProjectIdCacheForTests();
      const newId = projectId(dir);
      // a memory so the migration's canary fires
      new MemoryRepository(db).create({ content: 'x', kind: 'fact', project: oldId, skipDedup: true });

      const seed = (proj: string, heartbeat: string): void => {
        db.prepare(`INSERT INTO governance_client_state (
          project, client_installation_id, client_name, client_version,
          supports_post_tool_use, supports_post_tool_failure, supports_file_changed,
          supports_structured_output, supports_stop, supports_blocking,
          adapter_version, settings_source, last_heartbeat_at, last_probe_result
        ) VALUES (?, 'inst-1', 'claude-code', '1', 1,1,1,1,1,1, 1, 's', ?, 'p')`).run(proj, heartbeat);
      };
      seed(oldId, '2026-08-27T10:00:00.000Z'); // fresher
      seed(newId, '2026-08-26T10:00:00.000Z'); // staler — should be replaced

      __resetProjectIdCacheForTests();
      migrateProjectIdentity(db, dir);

      const rows = db.prepare('SELECT last_heartbeat_at h FROM governance_client_state WHERE project = ? AND client_installation_id = ?').all(newId, 'inst-1') as Array<{ h: string }>;
      assert.equal(rows.length, 1, 'exactly one row under the new id (no PK violation)');
      assert.equal(rows[0].h, '2026-08-27T10:00:00.000Z', 'the fresher row won');
      assert.equal((db.prepare('SELECT count(*) n FROM governance_client_state WHERE project = ?').get(oldId) as { n: number }).n, 0);
    } finally { db.close(); }
  });

  it('migrates a project with only session history (no memories)', () => {
    const dir = repoWithRemote('git@github.com:org/no-memories.git');
    const db = openDatabase({ dbPath: ':memory:' });
    try {
      const oldId = legacyProjectId(dir);
      __resetProjectIdCacheForTests();
      const newId = projectId(dir);
      // A session row under the old id but ZERO memories — the memories-only
      // canary used to skip this, stranding the session/audit history.
      db.prepare('INSERT INTO sessions (id, project, started_at) VALUES (?, ?, ?)').run('s1', oldId, '2026-08-27T10:00:00.000Z');

      __resetProjectIdCacheForTests();
      migrateProjectIdentity(db, dir);

      assert.equal((db.prepare('SELECT count(*) n FROM sessions WHERE project = ?').get(newId) as { n: number }).n, 1, 'session migrated despite no memories');
      assert.equal((db.prepare('SELECT count(*) n FROM sessions WHERE project = ?').get(oldId) as { n: number }).n, 0);
    } finally { db.close(); }
  });
});

describe('resolveProjectParam (bare-name resolver)', () => {
  it('passes a full id through unchanged', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    try { assert.equal(resolveProjectParam(db, 'cairn-2f161aa3'), 'cairn-2f161aa3'); }
    finally { db.close(); }
  });

  it('preserves null and undefined (global vs all)', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    try {
      assert.equal(resolveProjectParam(db, null), null);
      assert.equal(resolveProjectParam(db, undefined), undefined);
    } finally { db.close(); }
  });

  it('resolves a unique bare name to its full id', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    try {
      new MemoryRepository(db).create({ content: 'm', kind: 'fact', project: 'cairn-391586af', skipDedup: true });
      assert.equal(resolveProjectParam(db, 'cairn'), 'cairn-391586af');
    } finally { db.close(); }
  });

  it('passes an ambiguous bare name through unresolved (fail closed)', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    try {
      const repo = new MemoryRepository(db);
      repo.create({ content: 'a', kind: 'fact', project: 'app-11111111', skipDedup: true });
      repo.create({ content: 'b', kind: 'fact', project: 'app-22222222', skipDedup: true });
      assert.equal(resolveProjectParam(db, 'app'), 'app', 'ambiguous → unresolved, not a wrong guess');
    } finally { db.close(); }
  });
});
