import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type Database from 'better-sqlite3';
import { openDatabase } from '../src/db/connection.js';
import { ContextRepository } from '../src/db/context-repository.js';
import type { ProjectContext } from '../src/utils/project-scanner.js';

let db: Database.Database;
let repo: ContextRepository;

function makeContext(overrides: Partial<ProjectContext> = {}): ProjectContext {
  return {
    gitHash: 'abc123def456abc123def456abc123def456abc1',
    projectName: 'test-project',
    techStack: 'TypeScript/Node.js',
    structure: ['src/{db/,hooks/}', 'tests/'],
    entryPoints: ['dist/index.js'],
    keyConfigs: ['package.json', 'tsconfig.json'],
    scannedAt: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  db = openDatabase({ dbPath: ':memory:' });
  repo = new ContextRepository(db);
});

afterEach(() => {
  db.close();
});

describe('ContextRepository — Store & Retrieve', () => {
  it('should store and retrieve by project + git hash', () => {
    const ctx = makeContext();
    repo.store('proj-a', ctx);

    const result = repo.get('proj-a', ctx.gitHash);
    assert.ok(result);
    assert.equal(result.projectName, 'test-project');
    assert.equal(result.techStack, 'TypeScript/Node.js');
    assert.deepEqual(result.structure, ['src/{db/,hooks/}', 'tests/']);
    assert.deepEqual(result.entryPoints, ['dist/index.js']);
  });

  it('should return null on cache miss (wrong hash)', () => {
    const ctx = makeContext();
    repo.store('proj-a', ctx);

    const result = repo.get('proj-a', 'wrong-hash');
    assert.equal(result, null);
  });

  it('should return null on cache miss (wrong project)', () => {
    const ctx = makeContext();
    repo.store('proj-a', ctx);

    const result = repo.get('proj-b', ctx.gitHash);
    assert.equal(result, null);
  });

  it('should upsert on same project + git hash', () => {
    const ctx1 = makeContext({ techStack: 'v1' });
    repo.store('proj-a', ctx1);

    const ctx2 = makeContext({ techStack: 'v2' });
    repo.store('proj-a', ctx2);

    const result = repo.get('proj-a', ctx1.gitHash);
    assert.ok(result);
    assert.equal(result.techStack, 'v2');
  });
});

describe('ContextRepository — getLatest', () => {
  it('should return most recent context for a project', () => {
    const ctx1 = makeContext({ gitHash: 'aaa', scannedAt: '2026-01-01T00:00:00Z' });
    const ctx2 = makeContext({ gitHash: 'bbb', scannedAt: '2026-01-02T00:00:00Z', techStack: 'latest' });
    repo.store('proj-a', ctx1);
    repo.store('proj-a', ctx2);

    const result = repo.getLatest('proj-a');
    assert.ok(result);
    assert.equal(result.techStack, 'latest');
  });

  it('should return null when no context exists', () => {
    const result = repo.getLatest('proj-nonexistent');
    assert.equal(result, null);
  });
});

describe('ContextRepository — Cleanup', () => {
  it('should keep only MAX_CACHE_PER_PROJECT entries', () => {
    // Create 7 entries
    for (let i = 0; i < 7; i++) {
      const ctx = makeContext({
        gitHash: `hash${i.toString().padStart(38, '0')}`,
        scannedAt: new Date(Date.now() + i * 1000).toISOString(),
      });
      repo.store('proj-a', ctx);
    }

    const deleted = repo.cleanup('proj-a');
    assert.equal(deleted, 2, 'Should delete 2 oldest (7 - 5 = 2)');

    // Verify the most recent 5 still exist
    const latest = repo.getLatest('proj-a');
    assert.ok(latest);
  });

  it('should not delete entries from other projects', () => {
    for (let i = 0; i < 7; i++) {
      repo.store('proj-a', makeContext({
        gitHash: `hasha${i.toString().padStart(37, '0')}`,
        scannedAt: new Date(Date.now() + i * 1000).toISOString(),
      }));
    }
    repo.store('proj-b', makeContext({ gitHash: 'hashb' }));

    repo.cleanup('proj-a');

    const projB = repo.getLatest('proj-b');
    assert.ok(projB, 'proj-b context should still exist');
  });
});
