import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type Database from 'better-sqlite3';
import { openDatabase } from '../src/db/connection.js';
import { MemoryRepository } from '../src/db/memory-repository.js';
import { buildQueryFingerprint, type ContextFingerprint } from '../src/utils/fingerprint.js';
import { FINGERPRINT } from '../src/constants/index.js';

let db: Database.Database;
let repo: MemoryRepository;

beforeEach(() => {
  db = openDatabase({ dbPath: ':memory:' });
  repo = new MemoryRepository(db);
});

afterEach(() => {
  db.close();
});

function createPitfall(content: string, fp: ContextFingerprint, project = 'test-proj') {
  return repo.create({
    content,
    kind: 'pitfall',
    project,
    confidence: 0.65,
    fingerprint: fp,
  });
}

describe('recallByFingerprint', () => {
  it('should surface TypeScript pitfall when editing .ts file', () => {
    createPitfall(
      'Schema migrations in connection.ts must be idempotent',
      { lang: ['typescript'], framework: ['better-sqlite3'], module: ['db', 'schema'] },
    );
    createPitfall(
      'Python ORM models need explicit table names',
      { lang: ['python'], framework: ['django'], module: ['orm', 'models'] },
    );

    const qfp = buildQueryFingerprint({ filePath: 'src/db/connection.ts' });
    const results = repo.recallByFingerprint(qfp, 'database connection schema', {
      project: 'test-proj', kind: 'pitfall', maxResults: 3,
    });

    assert.ok(results.length >= 1, 'Should find at least 1 result');
    assert.ok(
      results[0].memory.content.includes('Schema migrations'),
      'TypeScript/db pitfall should rank first',
    );
  });

  it('should surface hooks pitfall when editing src/hooks/* file', () => {
    createPitfall(
      'Hooks must exit 0 even on error to avoid blocking Claude',
      { lang: ['typescript'], framework: ['node'], module: ['hooks'] },
    );
    createPitfall(
      'Always validate XML attributes in Odoo views',
      { lang: ['python', 'xml'], framework: ['odoo'], module: ['views'] },
    );

    const qfp = buildQueryFingerprint({ filePath: 'src/hooks/session-start.ts' });
    const results = repo.recallByFingerprint(qfp, 'hooks session start', {
      project: 'test-proj', kind: 'pitfall', maxResults: 3,
    });

    assert.ok(results.length >= 1);
    assert.ok(
      results[0].memory.content.includes('Hooks must exit'),
      'hooks pitfall should rank first',
    );
  });

  it('should NOT rank Python pitfall highly when editing TypeScript file', () => {
    createPitfall(
      'Python IndentationError in nested functions',
      { lang: ['python'], framework: ['flask'], module: ['api'] },
    );

    const qfp = buildQueryFingerprint({ filePath: 'src/mcp/server.ts' });
    const results = repo.recallByFingerprint(qfp, 'server typescript', {
      project: 'test-proj', kind: 'pitfall', maxResults: 3,
    });

    // Should either not return the Python pitfall, or rank it very low
    if (results.length > 0) {
      assert.ok(results[0].score < FINGERPRINT.MIN_SCORE + 0.1,
        `Python pitfall score should be low, got ${results[0].score}`);
    }
  });

  it('should fall back to content FTS when fingerprint has no match', () => {
    // Memory with no fingerprint but matching content
    repo.create({
      content: 'Always use parameterized SQL queries to prevent injection',
      kind: 'pitfall',
      project: 'test-proj',
      confidence: 0.65,
      // No fingerprint
    });

    const qfp = buildQueryFingerprint({ filePath: 'src/db/query.ts' });
    const results = repo.recallByFingerprint(qfp, 'SQL queries parameterized injection', {
      project: 'test-proj', kind: 'pitfall', maxResults: 3,
    });

    assert.ok(results.length >= 1, 'Should find via content FTS fallback');
    assert.ok(results[0].memory.content.includes('parameterized'));
  });

  it('should rank module match higher than lang-only match', () => {
    createPitfall(
      'Generic TypeScript import issue',
      { lang: ['typescript'], framework: ['node'], module: ['utils'] },
    );
    createPitfall(
      'Hook-specific TypeScript lifecycle issue',
      { lang: ['typescript'], framework: ['node'], module: ['hooks', 'lifecycle'] },
    );

    const qfp = buildQueryFingerprint({ filePath: 'src/hooks/precompact.ts' });
    const results = repo.recallByFingerprint(qfp, 'hooks precompact lifecycle', {
      project: 'test-proj', kind: 'pitfall', maxResults: 3,
    });

    assert.ok(results.length >= 2);
    assert.ok(
      results[0].memory.content.includes('Hook-specific'),
      'Module-matched pitfall should rank higher than lang-only match',
    );
  });

  it('should handle memories without fingerprints (backward compat)', () => {
    // Create without fingerprint
    repo.create({
      content: 'Legacy pitfall without fingerprint about database connections',
      kind: 'pitfall',
      project: 'test-proj',
      confidence: 0.65,
      tags: ['database'],
    });

    const qfp = buildQueryFingerprint({ filePath: 'src/db/connection.ts' });
    const results = repo.recallByFingerprint(qfp, 'database connection', {
      project: 'test-proj', kind: 'pitfall', maxResults: 3,
    });

    // Should still find via FTS on content
    assert.ok(results.length >= 1);
  });
});

describe('topPitfalls with fingerprint re-ranking', () => {
  it('should re-rank pitfalls by fingerprint relevance when queryFp provided', () => {
    // Python pitfall has HIGHER confidence — would rank first without fingerprint re-ranking
    repo.create({
      content: 'Python-specific pitfall about imports',
      kind: 'pitfall', project: 'test-proj', confidence: 0.9,
      fingerprint: { lang: ['python'], framework: ['django'], module: ['imports'] },
    });
    repo.create({
      content: 'TypeScript hooks pitfall about lifecycle',
      kind: 'pitfall', project: 'test-proj', confidence: 0.65,
      fingerprint: { lang: ['typescript'], framework: ['node'], module: ['hooks'] },
    });

    const qfp: ContextFingerprint = { lang: ['typescript'], framework: ['node'], module: ['hooks'] };
    const results = repo.topPitfalls('test-proj', 2, qfp);

    assert.ok(results.length >= 1);
    assert.ok(
      results[0].content.includes('TypeScript hooks'),
      'TypeScript pitfall should rank first when query is TypeScript/hooks context',
    );
  });
});
