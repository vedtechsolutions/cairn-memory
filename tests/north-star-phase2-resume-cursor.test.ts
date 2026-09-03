import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type Database from 'better-sqlite3';
import { openDatabase } from '../src/db/connection.js';
import { MemoryRepository } from '../src/db/memory-repository.js';
import { PlanRepository } from '../src/db/plan-repository.js';
import {
  compileBriefing,
  compileIndexBriefing,
  type BriefingContext,
} from '../src/hooks/shared/briefing-compiler.js';
import { LIMITS } from '../src/constants/index.js';

// ============================================================================
// Phase 2: Resume Cursor — last edit (file, line, tool, at) in the briefing
//
// Covers:
//   1. Briefing renders "Resume: <basename>:<line> (<tool>, Nm ago)"
//   2. Stale cursors (> RESUME_CURSOR_STALE_MS) are suppressed
//   3. Cursors pointing to non-existent files are suppressed
//   4. Line = null still renders (without the :N part)
//   5. "just now" label for fresh cursors
//   6. Index briefing path renders cursor identically
//   7. No cursor → no Resume line (back-compat)
// ============================================================================

let db: Database.Database;
let memoryRepo: MemoryRepository;
let planRepo: PlanRepository;
let tmpDir: string;

beforeEach(() => {
  db = openDatabase({ dbPath: ':memory:' });
  memoryRepo = new MemoryRepository(db);
  planRepo = new PlanRepository(db);
  tmpDir = mkdtempSync(join(tmpdir(), 'cairn-cursor-test-'));
});

afterEach(() => {
  db.close();
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe('Briefing renders Resume cursor', () => {
  it('renders Resume line with line number for fresh Edit cursor', () => {
    const file = join(tmpDir, 'pitfall-handler.ts');
    writeFileSync(file, 'line 1\nline 2\nline 3\nline 4\n');
    const ctx: BriefingContext = {
      project: 'test-proj',
      sessionType: 'startup',
      interrupted: false,
      lastEditCursor: {
        file,
        line: 240,
        tool: 'Edit',
        at: Date.now() - 3 * 60_000, // 3 minutes ago
      },
    };
    const briefing = compileBriefing(memoryRepo, planRepo, ctx);
    assert.match(briefing.text, /Resume: pitfall-handler\.ts:240 \(Edit, 3m ago\)/);
  });

  it('renders Resume line without line number when line is null', () => {
    const file = join(tmpDir, 'foo.ts');
    writeFileSync(file, 'content\n');
    const ctx: BriefingContext = {
      project: 'test-proj',
      sessionType: 'startup',
      interrupted: false,
      lastEditCursor: {
        file,
        line: null,
        tool: 'Edit',
        at: Date.now() - 60_000,
      },
    };
    const briefing = compileBriefing(memoryRepo, planRepo, ctx);
    assert.match(briefing.text, /Resume: foo\.ts \(Edit, 1m ago\)/);
  });

  it('uses "just now" label for cursors under a minute old', () => {
    const file = join(tmpDir, 'bar.ts');
    writeFileSync(file, 'x');
    const ctx: BriefingContext = {
      project: 'test-proj',
      sessionType: 'startup',
      interrupted: false,
      lastEditCursor: {
        file,
        line: 10,
        tool: 'Write',
        at: Date.now() - 5_000, // 5 seconds ago
      },
    };
    const briefing = compileBriefing(memoryRepo, planRepo, ctx);
    assert.match(briefing.text, /Resume: bar\.ts:10 \(Write, just now\)/);
  });

  it('suppresses stale cursors (older than RESUME_CURSOR_STALE_MS)', () => {
    const file = join(tmpDir, 'stale.ts');
    writeFileSync(file, 'x');
    const ctx: BriefingContext = {
      project: 'test-proj',
      sessionType: 'startup',
      interrupted: false,
      lastEditCursor: {
        file,
        line: 100,
        tool: 'Edit',
        at: Date.now() - (LIMITS.RESUME_CURSOR_STALE_MS + 60_000),
      },
    };
    const briefing = compileBriefing(memoryRepo, planRepo, ctx);
    assert.ok(!briefing.text.includes('Resume:'), 'Stale cursor should not render');
  });

  it('suppresses cursors pointing to non-existent files', () => {
    const ctx: BriefingContext = {
      project: 'test-proj',
      sessionType: 'startup',
      interrupted: false,
      lastEditCursor: {
        file: join(tmpDir, 'does-not-exist.ts'),
        line: 10,
        tool: 'Edit',
        at: Date.now() - 60_000,
      },
    };
    const briefing = compileBriefing(memoryRepo, planRepo, ctx);
    assert.ok(!briefing.text.includes('Resume:'), 'Non-existent file cursor should not render');
  });

  it('omits Resume line when cursor is null', () => {
    const ctx: BriefingContext = {
      project: 'test-proj',
      sessionType: 'startup',
      interrupted: false,
      lastEditCursor: null,
    };
    const briefing = compileBriefing(memoryRepo, planRepo, ctx);
    assert.ok(!briefing.text.includes('Resume:'), 'Null cursor should not render');
  });

  it('omits Resume line when cursor field is absent (back-compat)', () => {
    const ctx: BriefingContext = {
      project: 'test-proj',
      sessionType: 'startup',
      interrupted: false,
    };
    const briefing = compileBriefing(memoryRepo, planRepo, ctx);
    assert.ok(!briefing.text.includes('Resume:'), 'Absent cursor should not render');
  });

  it('renders cursor on compact session too', () => {
    const file = join(tmpDir, 'compact.ts');
    writeFileSync(file, 'x\n');
    const ctx: BriefingContext = {
      project: 'test-proj',
      sessionType: 'compact',
      interrupted: false,
      compactionSnapshot: {
        recentFiles: [],
        recentReadFiles: [],
        recentCommands: [],
        userContext: [],
        approachNotes: [],
        initialGoal: null,
      },
      lastEditCursor: {
        file,
        line: 42,
        tool: 'Edit',
        at: Date.now() - 120_000, // 2m
      },
    };
    const briefing = compileBriefing(memoryRepo, planRepo, ctx);
    assert.match(briefing.text, /Resume: compact\.ts:42 \(Edit, 2m ago\)/);
  });

  it('tolerates "at in the future" (clock skew) — treats negative age as stale', () => {
    const file = join(tmpDir, 'skew.ts');
    writeFileSync(file, 'x');
    const ctx: BriefingContext = {
      project: 'test-proj',
      sessionType: 'startup',
      interrupted: false,
      lastEditCursor: {
        file,
        line: 1,
        tool: 'Write',
        at: Date.now() + 60_000, // 1 minute in the future
      },
    };
    const briefing = compileBriefing(memoryRepo, planRepo, ctx);
    assert.ok(!briefing.text.includes('Resume:'), 'Future-dated cursor should not render');
  });
});

describe('Index briefing renders Resume cursor', () => {
  it('index briefing includes Resume line when cursor is fresh', () => {
    const file = join(tmpDir, 'idx.ts');
    writeFileSync(file, 'x\n');
    const ctx: BriefingContext = {
      project: 'test-proj',
      sessionType: 'compact',
      interrupted: false,
      compactionSnapshot: {
        recentFiles: [],
        recentReadFiles: [],
        recentCommands: [],
        userContext: [],
        approachNotes: [],
        initialGoal: null,
      },
      lastEditCursor: {
        file,
        line: 77,
        tool: 'MultiEdit',
        at: Date.now() - 5 * 60_000, // 5m ago
      },
    };
    const briefing = compileIndexBriefing(memoryRepo, planRepo, ctx);
    assert.match(briefing.text, /Resume: idx\.ts:77 \(MultiEdit, 5m ago\)/);
  });
});

describe('EditTracker default shape (Phase 2)', () => {
  it('defaultTracker includes lastEditCursor: null', async () => {
    const { loadTracker } = await import('../src/hooks/shared/edit-tracker.js');
    const tracker = loadTracker('phase2-test-session-should-not-exist');
    assert.equal(tracker.lastEditCursor, null);
  });
});

describe('Cursor persistence through snapshot (v21 reassessment fix)', () => {
  it('compaction_snapshots has last_edit_cursor column', () => {
    const cols = db.prepare("PRAGMA table_info('compaction_snapshots')")
      .all() as Array<{ name: string }>;
    const names = cols.map(c => c.name);
    assert.ok(names.includes('last_edit_cursor'),
      'last_edit_cursor column missing — SessionEnd cursor would be lost');
  });

  it('round-trips a cursor through INSERT/SELECT', () => {
    const cursor = { file: '/tmp/foo.ts', line: 42, tool: 'Edit', at: Date.now() };
    db.prepare(`
      INSERT INTO compaction_snapshots
        (id, session_id, project, captured_at, last_edit_cursor)
      VALUES (?, ?, ?, ?, ?)
    `).run('snap-cursor-1', 'sess-1', 'test-proj', new Date().toISOString(),
           JSON.stringify(cursor));
    const row = db.prepare(`
      SELECT last_edit_cursor FROM compaction_snapshots WHERE id = ?
    `).get('snap-cursor-1') as { last_edit_cursor: string };
    const parsed = JSON.parse(row.last_edit_cursor);
    assert.equal(parsed.file, cursor.file);
    assert.equal(parsed.line, 42);
    assert.equal(parsed.tool, 'Edit');
  });

  it('INSERT placeholder count matches column count (precompact + session-end parity)', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    // Resolve against process cwd so both ts-source runs and dist runs
    // read the same authoritative source files.
    const precompactSrc = readFileSync(resolve('src/hooks/precompact.ts'), 'utf-8');
    // The SessionEnd INSERT lives in the final-snapshot stage module (phase 4 split).
    const sessionEndSrc = readFileSync(resolve('src/hooks/shared/session-end/final-snapshot.ts'), 'utf-8');
    const countInserts = (src: string): number => {
      const match = src.match(/INSERT INTO compaction_snapshots[\s\S]+?VALUES \(([^)]+)\)/);
      return match ? (match[1].match(/\?/g) ?? []).length : 0;
    };
    const preCount = countInserts(precompactSrc);
    const endCount = countInserts(sessionEndSrc);
    // SNR v3 Commit 4 (schema v23): 18 → 20 placeholders after adding
    // goal_captured_at + project_goal_captured_at columns.
    assert.equal(preCount, 20, `precompact must have 20 placeholders, got ${preCount}`);
    assert.equal(endCount, 20, `session-end must have 20 placeholders, got ${endCount}`);
    assert.equal(preCount, endCount, 'precompact and session-end INSERTs must stay in lockstep');
  });
});
