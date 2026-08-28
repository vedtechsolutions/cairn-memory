import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db/connection.js';
import { MemoryRepository } from '../src/db/memory-repository.js';
import { PlanRepository } from '../src/db/plan-repository.js';
import { compileBriefing, type BriefingContext } from '../src/hooks/shared/briefing-compiler.js';
import { formatProjectContextCompact } from '../src/utils/project-scanner.js';
import { TOKEN_BUDGET } from '../src/constants/index.js';
import type { ProjectContext } from '../src/utils/project-scanner.js';

const testProjectContext: ProjectContext = {
  techStack: 'TypeScript/Node.js, @huggingface/transformers, better-sqlite3',
  structure: ['scripts/', 'src/{constants/,db/,hooks/,mcp/,utils/}', 'tests/'],
  entryPoints: ['dist/src/mcp/server.js'],
  keyConfigs: ['package.json', 'tsconfig.json'],
  gitHash: 'abc123',
  projectName: 'cairn',
  scannedAt: new Date().toISOString(),
};

describe('Phase 7: formatProjectContextCompact', () => {
  it('should produce a single string with tech + structure', () => {
    const result = formatProjectContextCompact(testProjectContext, 200);
    assert.ok(result.includes('TypeScript'), 'should include tech stack');
    assert.ok(result.includes('src/'), 'should include structure');
    assert.ok(!result.includes('\n'), 'should be a single line');
  });

  it('should truncate to maxChars with ellipsis', () => {
    const result = formatProjectContextCompact(testProjectContext, 50);
    assert.ok(result.length <= 50);
    assert.ok(result.endsWith('…'), 'should have ellipsis when truncated');
  });

  it('should not include Entry or Config lines', () => {
    const result = formatProjectContextCompact(testProjectContext, 200);
    assert.ok(!result.includes('Entry:'), 'no Entry line');
    assert.ok(!result.includes('Config:'), 'no Config line');
    assert.ok(!result.includes('package.json'), 'no config file names');
  });
});

describe('Phase 7: Briefing Compact Skip', () => {
  it('should skip project context entirely on compact sessions', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    const memRepo = new MemoryRepository(db);
    const planRepo = new PlanRepository(db);

    const ctx: BriefingContext = {
      project: 'tp',
      sessionType: 'compact',
      interrupted: false,
      projectContext: testProjectContext,
      compactionSnapshot: {
        recentFiles: [], recentReadFiles: [], recentCommands: [],
        userContext: ['do the thing'], approachNotes: [],
        initialGoal: 'Do the thing', recentDecisions: [],
      },
    };
    const result = compileBriefing(memRepo, planRepo, ctx);
    assert.ok(!result.text.includes('Stack:'), 'compact should have no project context');
    assert.ok(!result.text.includes('Tech:'), 'compact should have no Tech line');
    assert.ok(!result.text.includes('Structure:'), 'compact should have no Structure line');
    db.close();
  });

  it('should use single Stack: line on startup', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    const memRepo = new MemoryRepository(db);
    const planRepo = new PlanRepository(db);

    const ctx: BriefingContext = {
      project: 'tp',
      sessionType: 'startup',
      interrupted: false,
      projectContext: testProjectContext,
    };
    const result = compileBriefing(memRepo, planRepo, ctx);
    assert.ok(result.text.includes('Stack:'), 'startup should have Stack line');
    // Should NOT have separate Tech/Structure/Entry/Config lines
    assert.ok(!result.text.includes('Tech:'), 'no separate Tech line');
    assert.ok(!result.text.includes('Structure:'), 'no separate Structure line');
    assert.ok(!result.text.includes('Entry:'), 'no separate Entry line');
    assert.ok(!result.text.includes('Config:'), 'no separate Config line');
    db.close();
  });

  it('should respect PROJECT_CONTEXT_COMPACT_MAX_CHARS', () => {
    assert.ok(TOKEN_BUDGET.PROJECT_CONTEXT_COMPACT_MAX_CHARS <= 150,
      'compact context should be short');
    assert.ok(TOKEN_BUDGET.PROJECT_CONTEXT_COMPACT_MAX_CHARS >= 80,
      'compact context needs enough room for tech + dirs');
  });
});
