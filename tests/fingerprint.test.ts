import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateFingerprint,
  buildQueryFingerprint,
  fingerprintOverlap,
  fingerprintLikeConditions,
} from '../src/utils/fingerprint.js';
import { scanProject } from '../src/utils/project-scanner.js';

describe('generateFingerprint', () => {
  it('should generate fingerprint from TypeScript project context', () => {
    const ctx = scanProject(process.cwd());
    const fp = generateFingerprint({ projectContext: ctx });
    assert.ok(fp.lang.includes('typescript'), 'Should detect TypeScript');
    assert.ok(fp.framework.length > 0, 'Should have framework entries');
  });

  it('should extract module from file path without stopword filtering', () => {
    const fp = generateFingerprint({ filePath: 'src/hooks/precompact.ts' });
    assert.ok(fp.module.includes('hooks'), 'hooks should NOT be filtered');
    assert.ok(fp.module.includes('precompact'), 'filename stem should be included');
    assert.ok(fp.lang.includes('typescript'), 'Should detect TypeScript from .ts extension');
  });

  it('should preserve short directory names like db', () => {
    const fp = generateFingerprint({ filePath: 'src/db/memory-repository.ts' });
    assert.ok(fp.module.includes('db'), 'db (2 chars) should be included');
    assert.ok(fp.module.includes('memory'), 'memory from filename should be included');
    assert.ok(fp.module.includes('repository'), 'repository from filename should be included');
  });

  it('should drop filesystem-root segments from absolute paths', () => {
    // Absolute path leading segments (opt, usr, var, home, root, tmp, etc) carry
    // no retrieval signal — they're filesystem structure, not module names.
    const fp = generateFingerprint({ filePath: '/opt/cairn/src/hooks/handlers/stop-handler.ts' });
    assert.ok(!fp.module.includes('opt'), 'leading /opt should be filtered');
    assert.ok(fp.module.includes('cairn'), 'real project segment should be kept');
    assert.ok(fp.module.includes('hooks'), 'real module segment should be kept');
    assert.ok(fp.module.includes('handlers'), 'real module segment should be kept');

    const fp2 = generateFingerprint({ filePath: '/home/alice/code/proj/src/foo.ts' });
    assert.ok(!fp2.module.includes('home'), 'leading /home should be filtered');

    const fp3 = generateFingerprint({ filePath: '/usr/local/lib/thing/bar.ts' });
    assert.ok(!fp3.module.includes('usr'), 'leading /usr should be filtered');
  });

  it('should drop Claude Code worktree path structure', () => {
    // `.claude/worktrees/<slug>/...` is Claude Code scaffolding — every worktree
    // shares the same two leading segments, so they carry zero retrieval signal.
    const fp = generateFingerprint({
      filePath: '/opt/cairn/.claude/worktrees/zealous-euclid/src/hooks/foo.ts',
    });
    assert.ok(!fp.module.includes('.claude'), '.claude should be filtered');
    assert.ok(!fp.module.includes('worktrees'), 'worktrees should be filtered');
    assert.ok(fp.module.includes('hooks'), 'downstream real segments should survive');
  });

  it('should map file extensions to language names', () => {
    const tsFp = generateFingerprint({ filePath: 'foo.ts' });
    assert.ok(tsFp.lang.includes('typescript'));

    const pyFp = generateFingerprint({ filePath: 'foo.py' });
    assert.ok(pyFp.lang.includes('python'));

    const goFp = generateFingerprint({ filePath: 'foo.go' });
    assert.ok(goFp.lang.includes('go'));
  });

  it('should extract framework names from tech stack', () => {
    const ctx = scanProject(process.cwd());
    const fp = generateFingerprint({ projectContext: ctx });
    // Check that at least one known dependency appears (top 3 from package.json)
    const hasKnownDep = fp.framework.some(f =>
      f.includes('tokenizer') || f.includes('sdk') || f.includes('sqlite') || f.includes('transformers')
    );
    assert.ok(hasKnownDep, `Should include a known dep, got: ${fp.framework.join(', ')}`);
  });

  it('should extract from tags using TAG_DIMENSION_MAP', () => {
    const fp = generateFingerprint({ tags: ['python', 'orm', 'security', 'high'] });
    assert.ok(fp.lang.includes('python'), 'python tag → lang');
    assert.ok(fp.module.includes('orm'), 'orm tag → module');
    assert.ok(fp.module.includes('security'), 'security tag → module');
    // 'high' is a severity tag — should NOT appear in any dimension
    assert.ok(!fp.lang.includes('high'));
    assert.ok(!fp.framework.includes('high'));
    assert.ok(!fp.module.includes('high'));
  });

  it('should extract language from command', () => {
    const fp = generateFingerprint({ command: 'python manage.py runserver' });
    assert.ok(fp.lang.includes('python'));

    const fp2 = generateFingerprint({ command: 'npm test' });
    assert.ok(fp2.lang.includes('javascript'));
  });
});

describe('buildQueryFingerprint', () => {
  it('should build query fingerprint from file path + project context', () => {
    const ctx = scanProject(process.cwd());
    const qfp = buildQueryFingerprint({
      projectContext: ctx,
      filePath: 'src/hooks/precompact.ts',
    });
    assert.ok(qfp.lang.includes('typescript'));
    assert.ok(qfp.module.includes('hooks'));
    assert.ok(qfp.module.includes('precompact'));
    assert.ok(qfp.framework.length > 0);
  });
});

describe('fingerprintOverlap', () => {
  it('should return high score for identical fingerprints', () => {
    const fp = { lang: ['typescript'], framework: ['node'], module: ['hooks', 'db'] };
    const score = fingerprintOverlap(fp, fp);
    assert.ok(score > 0.9, `Expected > 0.9, got ${score}`);
  });

  it('should return partial score for partial module match', () => {
    const stored = { lang: ['typescript'], framework: ['node'], module: ['hooks', 'db'] };
    const query = { lang: ['typescript'], framework: ['node'], module: ['hooks'] };
    const score = fingerprintOverlap(stored, query);
    assert.ok(score > 0.5, `Expected > 0.5, got ${score}`);
    assert.ok(score < 1.0, `Expected < 1.0, got ${score}`);
  });

  it('should return low score for different language', () => {
    const stored = { lang: ['python'], framework: ['django'], module: ['views'] };
    const query = { lang: ['typescript'], framework: ['node'], module: ['hooks'] };
    const score = fingerprintOverlap(stored, query);
    assert.ok(score < 0.1, `Expected < 0.1, got ${score}`);
  });

  it('should return 0 for empty fingerprints', () => {
    const empty = { lang: [], framework: [], module: [] };
    assert.equal(fingerprintOverlap(empty, empty), 0);
  });

  it('should weight module highest', () => {
    const queryWithModule = { lang: ['typescript'], framework: ['node'], module: ['hooks'] };
    const storedWithModule = { lang: ['typescript'], framework: ['node'], module: ['hooks'] };
    const storedWithoutModule = { lang: ['typescript'], framework: ['node'], module: ['db'] };

    const matchScore = fingerprintOverlap(storedWithModule, queryWithModule);
    const noMatchScore = fingerprintOverlap(storedWithoutModule, queryWithModule);
    assert.ok(matchScore > noMatchScore, 'Module match should produce higher score');
  });
});

describe('fingerprintLikeConditions', () => {
  it('should return deduplicated terms from all dimensions', () => {
    const fp = { lang: ['typescript'], framework: ['node'], module: ['hooks', 'db'] };
    const terms = fingerprintLikeConditions(fp);
    assert.ok(terms.includes('typescript'));
    assert.ok(terms.includes('node'));
    assert.ok(terms.includes('hooks'));
    assert.ok(terms.includes('db'));
    assert.equal(terms.length, 4);
  });

  it('should deduplicate across dimensions', () => {
    const fp = { lang: ['node'], framework: ['node'], module: [] };
    const terms = fingerprintLikeConditions(fp);
    assert.equal(terms.length, 1);
    assert.equal(terms[0], 'node');
  });
});
