import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanProject, getGitHash, formatProjectContext } from '../src/utils/project-scanner.js';
import { gitSpawnSkipReason } from './spawn-probe.js';

describe('getGitHash', () => {
  it('should return a 40-char hex hash for a git repo', (t) => {
    const skip = gitSpawnSkipReason();
    if (skip) return t.skip(skip);
    const hash = getGitHash(process.cwd());
    assert.ok(hash, 'Should return a hash for the cairn repo');
    assert.match(hash, /^[0-9a-f]{40}$/, 'Should be a 40-char hex string');
  });

  it('should return null for non-git directory', () => {
    const hash = getGitHash('/tmp');
    assert.equal(hash, null);
  });
});

describe('scanProject', () => {
  it('should detect TypeScript/Node.js project', () => {
    const ctx = scanProject(process.cwd());
    assert.ok(ctx.techStack.includes('TypeScript'));
    assert.ok(ctx.techStack.includes('Node.js'));
  });

  it('should extract project name from package.json', () => {
    const ctx = scanProject(process.cwd());
    assert.equal(ctx.projectName, 'waykeep');
  });

  it('should extract structure from directory listing', () => {
    const ctx = scanProject(process.cwd());
    assert.ok(ctx.structure.length > 0, 'Should have directory entries');
    const srcEntry = ctx.structure.find(s => s.startsWith('src/'));
    assert.ok(srcEntry, 'Should include src/ directory');
    assert.ok(srcEntry!.includes('mcp/'), 'src/ should contain mcp/ subdirectory');
    assert.ok(srcEntry!.includes('db/'), 'src/ should contain db/ subdirectory');
  });

  it('should extract entry points from package.json', () => {
    const ctx = scanProject(process.cwd());
    assert.ok(ctx.entryPoints.length > 0, 'Should have entry points');
    assert.ok(ctx.entryPoints.some(e => e.includes('server.js')), 'Should include server entry');
  });

  it('should detect key config files', () => {
    const ctx = scanProject(process.cwd());
    assert.ok(ctx.keyConfigs.includes('package.json'));
    assert.ok(ctx.keyConfigs.includes('tsconfig.json'));
  });

  it('should include git hash when git is spawnable, no-git fail-safe otherwise', () => {
    const ctx = scanProject(process.cwd());
    if (gitSpawnSkipReason()) {
      assert.equal(ctx.gitHash, 'no-git', 'fail-safe marker when Node cannot spawn git');
    } else {
      assert.match(ctx.gitHash, /^[0-9a-f]{40}$/);
    }
  });

  it('should include scannedAt timestamp', () => {
    const ctx = scanProject(process.cwd());
    assert.ok(ctx.scannedAt, 'Should have scannedAt');
    assert.ok(!isNaN(Date.parse(ctx.scannedAt)), 'Should be a valid ISO date');
  });

  it('should not include ignored directories in structure', () => {
    const ctx = scanProject(process.cwd());
    for (const entry of ctx.structure) {
      assert.ok(!entry.startsWith('node_modules/'), 'Should not include node_modules');
      assert.ok(!entry.startsWith('dist/'), 'Should not include dist');
      assert.ok(!entry.startsWith('.git/'), 'Should not include .git');
    }
  });
});

describe('formatProjectContext', () => {
  it('should format context as compact briefing lines', () => {
    const ctx = scanProject(process.cwd());
    const lines = formatProjectContext(ctx);
    assert.ok(lines.length >= 2, 'Should have at least Tech and Structure lines');

    const techLine = lines.find(l => l.startsWith('Tech:'));
    assert.ok(techLine, 'Should have a Tech: line');
    assert.ok(techLine!.includes('TypeScript'));

    const structLine = lines.find(l => l.startsWith('Structure:'));
    assert.ok(structLine, 'Should have a Structure: line');
  });

  it('should deduplicate entry points', () => {
    const ctx = scanProject(process.cwd());
    const lines = formatProjectContext(ctx);
    const entryLine = lines.find(l => l.startsWith('Entry:'));
    if (entryLine) {
      // cairn has main and bin pointing to the same file — should be deduped
      const parts = entryLine.replace('Entry: ', '').split(', ');
      const unique = new Set(parts);
      assert.equal(parts.length, unique.size, 'Entry points should be deduplicated');
    }
  });

  it('should keep total output under 100 tokens (rough estimate)', () => {
    // A FIXTURE tree, not process.cwd(): the live repo's shape grows over
    // time (adding packages/ broke the cap), and the compactness contract
    // must be judged on a representative project, not on whatever this
    // checkout looks like today.
    const dir = mkdtempSync(join(tmpdir(), 'cairn-scan-fixture-'));
    try {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({
        name: 'fixture-app', version: '1.0.0', main: 'src/index.ts',
        dependencies: { express: '4.0.0', zod: '3.0.0', pg: '8.0.0' },
        devDependencies: { typescript: '5.0.0', vitest: '1.0.0' },
      }));
      for (const d of ['src', 'tests', 'docs', 'scripts', 'config']) {
        mkdirSync(join(dir, d));
      }
      writeFileSync(join(dir, 'src', 'index.ts'), 'export {};\n');

      const ctx = scanProject(dir);
      const lines = formatProjectContext(ctx);
      const text = lines.join('\n');
      // Rough token estimate: ~4 chars per token
      const roughTokens = Math.ceil(text.length / 4);
      assert.ok(roughTokens < 100, `Should be under 100 tokens, got ~${roughTokens}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
