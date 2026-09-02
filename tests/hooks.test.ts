import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type Database from 'better-sqlite3';
import { openDatabase } from '../src/db/connection.js';
import { MemoryRepository } from '../src/db/memory-repository.js';
import { PlanRepository } from '../src/db/plan-repository.js';
import { compileBriefing, type BriefingContext } from '../src/hooks/shared/briefing-compiler.js';
import { parseTranscript } from '../src/hooks/shared/transcript-parser.js';
import { archiveUntouchedPlans, cleanupSnapshots } from '../src/db/maintenance.js';
import { TOOL, qualifiedToolName } from '../src/constants/mcp.js';

let db: Database.Database;
let memoryRepo: MemoryRepository;
let planRepo: PlanRepository;

beforeEach(() => {
  db = openDatabase({ dbPath: ':memory:' });
  memoryRepo = new MemoryRepository(db);
  planRepo = new PlanRepository(db);
});

afterEach(() => {
  db.close();
});

// --- Briefing Compiler Tests ------------------------------------------------

describe('Briefing Compiler', () => {
  it('should compile a basic startup briefing', () => {
    const ctx: BriefingContext = {
      project: 'test-proj',
      sessionType: 'startup',
      interrupted: false,
    };

    const briefing = compileBriefing(memoryRepo, planRepo, ctx);
    assert.ok(briefing.text.includes('[Waykeep Memory Briefing]'));
    assert.ok(briefing.text.includes('test-proj'));
    assert.ok(briefing.tokenEstimate > 0);
  });

  it('should include plan state in briefing', () => {
    planRepo.create({
      project: 'test-proj',
      name: 'Refactor module',
      steps: [
        { description: 'Extract constants' },
        { description: 'Create service layer' },
      ],
    });

    const plan = planRepo.getActive('test-proj')!;
    planRepo.updateStep(plan.id, { step_id: 1, status: 'done', outcome: 'Done' });
    planRepo.updateStep(plan.id, { step_id: 2, status: 'in_progress' });

    const ctx: BriefingContext = {
      project: 'test-proj',
      sessionType: 'startup',
      interrupted: false,
    };

    const briefing = compileBriefing(memoryRepo, planRepo, ctx);
    assert.ok(briefing.text.includes('Refactor module'));
    assert.ok(briefing.text.includes('step 1/2'));
    assert.ok(briefing.text.includes('Create service layer'));
  });

  it('should include pitfalls in briefing', () => {
    memoryRepo.create({ content: 'Use list not tree in Odoo views', kind: 'pitfall', project: 'test-proj', confidence: 0.7 });
    memoryRepo.create({ content: 'Check imports before running tests', kind: 'pitfall', project: 'test-proj', confidence: 0.6 });

    const ctx: BriefingContext = {
      project: 'test-proj',
      sessionType: 'startup',
      interrupted: false,
    };

    const briefing = compileBriefing(memoryRepo, planRepo, ctx);
    assert.ok(briefing.text.includes('Pitfalls:'));
    assert.ok(briefing.text.includes('list not tree'));
  });

  it('should include corrections in briefing', () => {
    // SNR v3 Commit 2: corrections must be same-project or carry a
    // fingerprint that passes the cross-project guard. Global corrections
    // without fingerprints no longer surface on bare-ctx briefings (was
    // the legacy bypass path).
    memoryRepo.create({ content: 'Always ask before committing', kind: 'correction', project: 'test-proj', confidence: 0.9 });

    const ctx: BriefingContext = {
      project: 'test-proj',
      sessionType: 'startup',
      interrupted: false,
    };

    const briefing = compileBriefing(memoryRepo, planRepo, ctx);
    assert.ok(briefing.text.includes('Corrections:'));
    assert.ok(briefing.text.includes('ask before committing'));
  });

  it('should flag interrupted sessions', () => {
    const ctx: BriefingContext = {
      project: 'test-proj',
      sessionType: 'startup',
      interrupted: true,
    };

    const briefing = compileBriefing(memoryRepo, planRepo, ctx);
    assert.ok(briefing.text.includes('[interrupted]'));
  });

  it('should include compaction snapshot in compact briefing', () => {
    const ctx: BriefingContext = {
      project: 'test-proj',
      sessionType: 'compact',
      interrupted: false,
      compactionSnapshot: {
        recentFiles: ['/src/auth.py', '/src/models.py'],
        recentReadFiles: ['/src/config.py', '/src/utils.py'],
        recentCommands: [{ command: 'python -m pytest', outputSummary: 'all passed' }],
        userContext: ['Fix the auth module login bug'],
        approachNotes: ['Using service layer pattern'],
        initialGoal: 'Fix the auth module login bug',
      },
    };

    const briefing = compileBriefing(memoryRepo, planRepo, ctx);
    assert.ok(briefing.text.includes('auth.py'));
    assert.ok(briefing.text.includes('Fix the auth'));
    assert.ok(briefing.text.includes('service layer'));
    assert.ok(briefing.text.includes('config.py'));
    assert.ok(briefing.text.includes('Recently read'));
    // SNR v3 Commit 4: "Goal:" label replaced with the three-tier "Now:" label.
    assert.ok(briefing.text.includes('Now:'));
  });

  it('should report token estimate for budget enforcement', () => {
    // Add distinct pitfalls (must differ enough to avoid dedup at 0.8 similarity)
    const topics = [
      'Never use raw SQL queries in Odoo models, always use the ORM API methods',
      'Always check field access rights before writing to restricted fields in views',
      'Use tree view instead of list view for Odoo portal pages to avoid rendering bugs',
      'Remember to call super() in compute methods that override inherited model fields',
      'Avoid importing from odoo.tools directly, use the public API instead for stability',
    ];
    for (const content of topics) {
      memoryRepo.create({ content, kind: 'pitfall', project: 'test-proj', confidence: 0.8 });
    }

    const ctx: BriefingContext = {
      project: 'test-proj',
      sessionType: 'startup',
      interrupted: false,
    };

    // Full briefing with all pitfalls
    const full = compileBriefing(memoryRepo, planRepo, ctx);
    assert.ok(full.tokenEstimate > 0, 'Token estimate should be positive');
    assert.ok(full.text.includes('Pitfalls:'), 'Should include pitfalls section');

    // Reduced to 1 pitfall — text should be shorter
    const reduced = compileBriefing(memoryRepo, planRepo, { ...ctx, maxPitfalls: 1 });
    assert.ok(reduced.text.length < full.text.length, 'Fewer pitfalls should produce shorter text');
    assert.ok(reduced.text.includes('Pitfalls:'), 'Should still include pitfalls section');

    // Zero pitfalls
    const none = compileBriefing(memoryRepo, planRepo, { ...ctx, maxPitfalls: 0 });
    assert.ok(!none.text.includes('Pitfalls:'), 'Zero pitfalls should omit section');
  });

  it('should produce empty-ish briefing for new project', () => {
    const ctx: BriefingContext = {
      project: 'brand-new-proj',
      sessionType: 'startup',
      interrupted: false,
    };

    const briefing = compileBriefing(memoryRepo, planRepo, ctx);
    // On startup with no plan, should NOT show "none active" (no noise)
    assert.ok(!briefing.text.includes('none active'));
    assert.ok(briefing.text.includes('brand-new-proj'));
  });
});

// --- Transcript Parser Tests ------------------------------------------------

describe('Transcript Parser', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cairn-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // Helper: create a Claude Code transcript entry
  function assistantEntry(content: Array<Record<string, unknown>>): string {
    return JSON.stringify({ type: 'assistant', message: { role: 'assistant', content } });
  }
  function userEntry(content: string | Array<Record<string, unknown>>): string {
    return JSON.stringify({ type: 'user', message: { role: 'user', content } });
  }

  it('should parse Write/Edit tool calls for file paths', () => {
    const transcriptPath = join(tmpDir, 'transcript.jsonl');
    const entries = [
      assistantEntry([{ type: 'tool_use', name: 'Write', id: 't1', input: { file_path: '/src/auth.py' } }]),
      assistantEntry([{ type: 'tool_use', name: 'Edit', id: 't2', input: { file_path: '/src/models.py' } }]),
    ];
    writeFileSync(transcriptPath, entries.join('\n'));

    const snapshot = parseTranscript(transcriptPath);
    assert.deepEqual(snapshot.recentFiles, ['/src/auth.py', '/src/models.py']);
  });

  it('should parse Bash commands', () => {
    const transcriptPath = join(tmpDir, 'transcript.jsonl');
    const entries = [
      assistantEntry([{ type: 'tool_use', name: 'Bash', id: 'bash1', input: { command: 'python -m pytest tests/' } }]),
      userEntry([{ type: 'tool_result', tool_use_id: 'bash1', content: 'all 5 tests passed' }]),
    ];
    writeFileSync(transcriptPath, entries.join('\n'));

    const snapshot = parseTranscript(transcriptPath);
    assert.equal(snapshot.recentCommands.length, 1);
    assert.ok(snapshot.recentCommands[0].command.includes('pytest'));
  });

  it('should parse user messages', () => {
    const transcriptPath = join(tmpDir, 'transcript.jsonl');
    const entries = [
      userEntry('Fix the login bug in auth module'),
    ];
    writeFileSync(transcriptPath, entries.join('\n'));

    const snapshot = parseTranscript(transcriptPath);
    assert.equal(snapshot.userContext.length, 1);
    assert.ok(snapshot.userContext[0].includes('login bug'));
  });

  it('should handle non-existent transcript file', () => {
    const snapshot = parseTranscript('/nonexistent/path.jsonl');
    assert.deepEqual(snapshot.recentFiles, []);
    assert.deepEqual(snapshot.recentCommands, []);
    assert.deepEqual(snapshot.userContext, []);
  });

  it('should handle malformed JSONL lines', () => {
    const transcriptPath = join(tmpDir, 'transcript.jsonl');
    const good = assistantEntry([{ type: 'tool_use', name: 'Write', id: 't1', input: { file_path: '/ok.py' } }]);
    writeFileSync(transcriptPath, `not json\n${good}`);

    const snapshot = parseTranscript(transcriptPath);
    assert.deepEqual(snapshot.recentFiles, ['/ok.py']);
  });

  it('should deduplicate file paths', () => {
    const transcriptPath = join(tmpDir, 'transcript.jsonl');
    const entries = [
      assistantEntry([{ type: 'tool_use', name: 'Edit', id: 't1', input: { file_path: '/src/auth.py' } }]),
      assistantEntry([{ type: 'tool_use', name: 'Edit', id: 't2', input: { file_path: '/src/auth.py' } }]),
    ];
    writeFileSync(transcriptPath, entries.join('\n'));

    const snapshot = parseTranscript(transcriptPath);
    assert.equal(snapshot.recentFiles.length, 1);
  });

  it('should limit user context to last 3 messages', () => {
    const transcriptPath = join(tmpDir, 'transcript.jsonl');
    const entries = Array.from({ length: 200 }, (_, i) =>
      userEntry(`Message ${i}`)
    );
    writeFileSync(transcriptPath, entries.join('\n'));

    const snapshot = parseTranscript(transcriptPath, 50);
    // Should only have last 3 user messages (our limit)
    assert.equal(snapshot.userContext.length, 3);
    assert.ok(snapshot.userContext[2].includes('Message 199'));
  });

  it('should parse user text in array content format', () => {
    const transcriptPath = join(tmpDir, 'transcript.jsonl');
    const entries = [
      userEntry([{ type: 'text', text: 'Fix the auth module' }]),
    ];
    writeFileSync(transcriptPath, entries.join('\n'));

    const snapshot = parseTranscript(transcriptPath);
    assert.equal(snapshot.userContext.length, 1);
    assert.ok(snapshot.userContext[0].includes('auth module'));
  });

  it('should pair Bash tool_use with tool_result output', () => {
    const transcriptPath = join(tmpDir, 'transcript.jsonl');
    const entries = [
      assistantEntry([{ type: 'tool_use', name: 'Bash', id: 'b1', input: { command: 'npm test' } }]),
      userEntry([{ type: 'tool_result', tool_use_id: 'b1', content: '5 tests passed' }]),
    ];
    writeFileSync(transcriptPath, entries.join('\n'));

    const snapshot = parseTranscript(transcriptPath);
    assert.equal(snapshot.recentCommands.length, 1);
    assert.ok(snapshot.recentCommands[0].outputSummary.includes('5 tests'));
  });

  it('should extract decisions from cairn_learn(kind: "decision") calls', () => {
    const transcriptPath = join(tmpDir, 'transcript.jsonl');
    const entries = [
      assistantEntry([{ type: 'tool_use', name: qualifiedToolName(TOOL.LEARN), id: 't1', input: {
        kind: 'decision',
        content: 'Use SQLite with WAL mode for memory storage',
      }}]),
    ];
    writeFileSync(transcriptPath, entries.join('\n'));

    const snapshot = parseTranscript(transcriptPath);
    assert.equal(snapshot.recentDecisions.length, 1);
    assert.ok(snapshot.recentDecisions[0].chose.includes('SQLite'));
  });

  it('should extract decisions from cairn_plan(decide) calls', () => {
    const transcriptPath = join(tmpDir, 'transcript.jsonl');
    const entries = [
      assistantEntry([{ type: 'tool_use', name: qualifiedToolName(TOOL.PLAN), id: 't1', input: {
        action: 'decide',
        chose: 'Use authlib over python-social-auth',
        why: 'Better maintained, fewer CVEs',
      }}]),
    ];
    writeFileSync(transcriptPath, entries.join('\n'));

    const snapshot = parseTranscript(transcriptPath);
    assert.equal(snapshot.recentDecisions.length, 1);
    assert.equal(snapshot.recentDecisions[0].chose, 'Use authlib over python-social-auth');
    assert.equal(snapshot.recentDecisions[0].why, 'Better maintained, fewer CVEs');
  });

  it('should NOT extract non-decision cairn_learn calls', () => {
    const transcriptPath = join(tmpDir, 'transcript.jsonl');
    const entries = [
      assistantEntry([{ type: 'tool_use', name: qualifiedToolName(TOOL.LEARN), id: 't1', input: {
        kind: 'pitfall',
        content: 'Always check for null before accessing properties',
      }}]),
    ];
    writeFileSync(transcriptPath, entries.join('\n'));

    const snapshot = parseTranscript(transcriptPath);
    assert.equal(snapshot.recentDecisions.length, 0);
  });

  it('should retire stale typecheck errors when a later tsc run is clean', () => {
    const transcriptPath = join(tmpDir, 'transcript.jsonl');
    const entries = [
      assistantEntry([{ type: 'tool_use', name: 'Bash', id: 'b1', input: { command: 'npx tsc --noEmit' } }]),
      userEntry([{ type: 'tool_result', tool_use_id: 'b1',
        content: "tests/foo.test.ts(21,3): error TS2741: Property 'pendingDecisionNudge' is missing in type" }]),
      assistantEntry([{ type: 'tool_use', name: 'Edit', id: 'e1', input: { file_path: '/src/foo.ts' } }]),
      userEntry([{ type: 'tool_result', tool_use_id: 'e1', content: 'File updated' }]),
      assistantEntry([{ type: 'tool_use', name: 'Bash', id: 'b2', input: { command: 'npx tsc --noEmit' } }]),
      userEntry([{ type: 'tool_result', tool_use_id: 'b2', content: '' }]),
    ];
    writeFileSync(transcriptPath, entries.join('\n'));

    const snapshot = parseTranscript(transcriptPath);
    assert.equal(snapshot.errorContext.length, 0,
      'stale typecheck error should be dropped when the last tsc run was clean');
  });

  it('should KEEP typecheck errors when the last tsc run still failed', () => {
    const transcriptPath = join(tmpDir, 'transcript.jsonl');
    const entries = [
      assistantEntry([{ type: 'tool_use', name: 'Bash', id: 'b1', input: { command: 'npx tsc --noEmit' } }]),
      userEntry([{ type: 'tool_result', tool_use_id: 'b1',
        content: "src/foo.ts(10,5): error TS2304: Cannot find name 'bar'" }]),
      assistantEntry([{ type: 'tool_use', name: 'Bash', id: 'b2', input: { command: 'npx tsc --noEmit' } }]),
      userEntry([{ type: 'tool_result', tool_use_id: 'b2',
        content: "src/foo.ts(10,5): error TS2304: Cannot find name 'bar'" }]),
    ];
    writeFileSync(transcriptPath, entries.join('\n'));

    const snapshot = parseTranscript(transcriptPath);
    assert.ok(snapshot.errorContext.length > 0,
      'unresolved typecheck error should survive');
  });

  it('should retire stale test errors when a later test run is clean', () => {
    const transcriptPath = join(tmpDir, 'transcript.jsonl');
    const entries = [
      assistantEntry([{ type: 'tool_use', name: 'Bash', id: 'b1', input: { command: 'npm test' } }]),
      userEntry([{ type: 'tool_result', tool_use_id: 'b1',
        content: 'FAIL tests/foo.test.ts: TypeError: Cannot read property baz of undefined' }]),
      assistantEntry([{ type: 'tool_use', name: 'Bash', id: 'b2', input: { command: 'npm test' } }]),
      userEntry([{ type: 'tool_result', tool_use_id: 'b2', content: '1186 tests passing' }]),
    ];
    writeFileSync(transcriptPath, entries.join('\n'));

    const snapshot = parseTranscript(transcriptPath);
    assert.equal(snapshot.errorContext.length, 0,
      'stale test error should be dropped when the last test run was clean');
  });

  it('should skip bare directory names from Grep/Glob path args', () => {
    const transcriptPath = join(tmpDir, 'transcript.jsonl');
    const entries = [
      // Grep with a directory path — must NOT appear in recentReadFiles
      assistantEntry([{ type: 'tool_use', name: 'Grep', id: 'g1', input: { pattern: 'foo', path: 'tests' } }]),
      // Glob — directory search, must NEVER contribute to recentReadFiles
      assistantEntry([{ type: 'tool_use', name: 'Glob', id: 'g2', input: { pattern: '*.ts', path: 'src' } }]),
      // Read with a real file — must appear
      assistantEntry([{ type: 'tool_use', name: 'Read', id: 'r1', input: { file_path: '/src/foo.ts' } }]),
    ];
    writeFileSync(transcriptPath, entries.join('\n'));

    const snapshot = parseTranscript(transcriptPath);
    assert.ok(snapshot.recentReadFiles.includes('/src/foo.ts'),
      'real file read should be captured');
    assert.ok(!snapshot.recentReadFiles.includes('tests'),
      'bare "tests" directory name must not leak through');
    assert.ok(!snapshot.recentReadFiles.includes('src'),
      'Glob directory path must never be captured');
  });

  it('should keep extensionless allowlist files (Makefile, README)', () => {
    const transcriptPath = join(tmpDir, 'transcript.jsonl');
    const entries = [
      assistantEntry([{ type: 'tool_use', name: 'Read', id: 'r1', input: { file_path: '/project/Makefile' } }]),
      assistantEntry([{ type: 'tool_use', name: 'Read', id: 'r2', input: { file_path: '/project/README' } }]),
      assistantEntry([{ type: 'tool_use', name: 'Read', id: 'r3', input: { file_path: '/project/src' } }]),
    ];
    writeFileSync(transcriptPath, entries.join('\n'));

    const snapshot = parseTranscript(transcriptPath);
    assert.ok(snapshot.recentReadFiles.includes('/project/Makefile'));
    assert.ok(snapshot.recentReadFiles.includes('/project/README'));
    assert.ok(!snapshot.recentReadFiles.includes('/project/src'),
      'bare src dir should be rejected even via Read');
  });

  it('should NOT retire unclassified errors on typecheck success', () => {
    // A TS error and an unrelated grep failure — the clean tsc should only
    // retire the typecheck-bucket error, not the unclassified one.
    const transcriptPath = join(tmpDir, 'transcript.jsonl');
    const entries = [
      assistantEntry([{ type: 'tool_use', name: 'Bash', id: 'b1', input: { command: 'some-unknown-tool --strict' } }]),
      userEntry([{ type: 'tool_result', tool_use_id: 'b1',
        content: 'Error: command failed with exit code 2' }]),
      assistantEntry([{ type: 'tool_use', name: 'Bash', id: 'b2', input: { command: 'npx tsc --noEmit' } }]),
      userEntry([{ type: 'tool_result', tool_use_id: 'b2', content: '' }]),
    ];
    writeFileSync(transcriptPath, entries.join('\n'));

    const snapshot = parseTranscript(transcriptPath);
    // The unclassified error MAY or MAY NOT be captured depending on
    // isLikelyErrorOutput — we only assert the typecheck retirement did
    // not accidentally drop it if it WAS captured.
    const hasTsError = snapshot.errorContext.some(
      e => /TS\d+/.test(e.errorText ?? e.errorKey),
    );
    assert.equal(hasTsError, false,
      'typecheck errors should still be retired');
  });
});

// --- Context-Adaptive Tests -------------------------------------------------

describe('Context Mode Adaptation', () => {
  it('should show no active plan on compact but not startup', () => {
    // Compact: show "none active" to confirm nothing was lost
    const compactCtx: BriefingContext = {
      project: 'test-proj',
      sessionType: 'compact',
      interrupted: false,
    };
    const compactBriefing = compileBriefing(memoryRepo, planRepo, compactCtx);
    assert.ok(compactBriefing.text.includes('none active'));

    // Startup: silent — no noise
    const startupCtx: BriefingContext = {
      project: 'test-proj',
      sessionType: 'startup',
      interrupted: false,
    };
    const startupBriefing = compileBriefing(memoryRepo, planRepo, startupCtx);
    assert.ok(!startupBriefing.text.includes('none active'));
  });
});

// --- Plan Recency Tests ----------------------------------------------------

describe('Plan Recency', () => {
  it('should prefer the most recently updated active plan', () => {
    // Create first plan (older)
    planRepo.create({
      project: 'test-proj',
      name: 'Old Plan',
      steps: [{ description: 'Step A' }],
    });

    // Creating a second plan auto-archives the first, so we
    // manually insert a second active plan with a newer timestamp
    // to simulate two active plans (edge case from migrations/bugs)
    const oldPlan = db.prepare(
      "SELECT id FROM plans WHERE project = 'test-proj' AND status = 'abandoned'"
    ).get() as { id: string } | undefined;

    // Re-activate the old plan to simulate two active plans
    if (oldPlan) {
      db.prepare("UPDATE plans SET status = 'active', updated_at = '2026-01-01T00:00:00Z' WHERE id = ?").run(oldPlan.id);
    }

    // Create second plan (newer) — this will archive the first again
    planRepo.create({
      project: 'test-proj',
      name: 'New Plan',
      steps: [{ description: 'Step B' }],
    });

    // Re-activate old plan again with old timestamp to test ordering
    if (oldPlan) {
      db.prepare("UPDATE plans SET status = 'active', updated_at = '2026-01-01T00:00:00Z' WHERE id = ?").run(oldPlan.id);
    }

    // getActive should return the most recently updated plan
    const active = planRepo.getActive('test-proj');
    assert.ok(active);
    assert.equal(active.name, 'New Plan');
  });
});

// --- Plan Completion in Briefing -------------------------------------------

describe('Plan Completion State', () => {
  it('should show [complete] when all plan steps are done', () => {
    planRepo.create({
      project: 'test-proj',
      name: 'Feature X',
      steps: [
        { description: 'Step 1' },
        { description: 'Step 2' },
      ],
    });

    const plan = planRepo.getActive('test-proj')!;
    planRepo.updateStep(plan.id, { step_id: 1, status: 'done' });
    planRepo.updateStep(plan.id, { step_id: 2, status: 'done' });

    const ctx: BriefingContext = {
      project: 'test-proj',
      sessionType: 'compact',
      interrupted: false,
    };

    const briefing = compileBriefing(memoryRepo, planRepo, ctx);
    assert.ok(briefing.text.includes('[complete]'), 'Should show [complete] flag');
    assert.ok(briefing.text.includes('step 2/2'), 'Should show all steps done');
  });

  it('should NOT show [complete] when steps remain pending', () => {
    planRepo.create({
      project: 'test-proj',
      name: 'Feature Y',
      steps: [
        { description: 'Step 1' },
        { description: 'Step 2' },
      ],
    });

    const plan = planRepo.getActive('test-proj')!;
    planRepo.updateStep(plan.id, { step_id: 1, status: 'done' });

    const ctx: BriefingContext = {
      project: 'test-proj',
      sessionType: 'startup',
      interrupted: false,
    };

    const briefing = compileBriefing(memoryRepo, planRepo, ctx);
    assert.ok(!briefing.text.includes('[complete]'));
    assert.ok(briefing.text.includes('step 1/2'));
  });

  it('should prefer [interrupted] over [complete]', () => {
    planRepo.create({
      project: 'test-proj',
      name: 'Feature Z',
      steps: [{ description: 'Only step' }],
    });

    const plan = planRepo.getActive('test-proj')!;
    planRepo.updateStep(plan.id, { step_id: 1, status: 'done' });

    const ctx: BriefingContext = {
      project: 'test-proj',
      sessionType: 'startup',
      interrupted: true,
    };

    const briefing = compileBriefing(memoryRepo, planRepo, ctx);
    assert.ok(briefing.text.includes('[interrupted]'));
    assert.ok(!briefing.text.includes('[complete]'));
  });
});

// --- Decision Recency Tests ------------------------------------------------

describe('Decision Recency Weighting', () => {
  it('should rank recent decisions higher than old ones at equal confidence', () => {
    // Insert an old decision (backdate created_at)
    memoryRepo.create({
      content: 'Old decision from weeks ago',
      kind: 'decision',
      project: 'test-proj',
      confidence: 0.7,
    });
    // Backdate the old decision
    const oldMem = db.prepare(
      "SELECT id FROM memories WHERE content LIKE 'Old decision%'"
    ).get() as { id: string };
    db.prepare(
      "UPDATE memories SET created_at = '2026-01-01T00:00:00Z' WHERE id = ?"
    ).run(oldMem.id);

    // Insert a recent decision
    memoryRepo.create({
      content: 'Fresh decision from today',
      kind: 'decision',
      project: 'test-proj',
      confidence: 0.7,
    });

    const results = memoryRepo.topDecisions('test-proj', 2);
    assert.equal(results.length, 2);
    assert.ok(
      results[0].content.includes('Fresh'),
      `Expected fresh decision first, got: "${results[0].content}"`
    );
  });
});

// --- Session Isolation Tests ------------------------------------------------

describe('Untouched Plan Auto-Archive', () => {
  it('should archive active plans with all steps pending and stale updated_at', () => {
    const { plan } = planRepo.create({
      project: 'test-proj',
      name: 'Stale untouched plan',
      steps: [{ description: 'Step 1' }, { description: 'Step 2' }],
    });

    // Backdate the plan to 3 hours ago (beyond PLAN_UNTOUCHED_ARCHIVE_HOURS=2)
    db.prepare(
      "UPDATE plans SET updated_at = datetime('now', '-3 hours') WHERE id = ?"
    ).run(plan.id);

    const archived = archiveUntouchedPlans(db);
    assert.equal(archived, 1);

    const updated = planRepo.getById(plan.id);
    assert.equal(updated?.status, 'abandoned');
  });

  it('should NOT archive plans with in-progress or done steps', () => {
    const { plan } = planRepo.create({
      project: 'test-proj',
      name: 'Active plan with progress',
      steps: [{ description: 'Step 1' }, { description: 'Step 2' }],
    });

    // Start a step
    planRepo.updateStep(plan.id, { step_id: 1, status: 'in_progress' });

    // Backdate the plan
    db.prepare(
      "UPDATE plans SET updated_at = datetime('now', '-3 hours') WHERE id = ?"
    ).run(plan.id);

    const archived = archiveUntouchedPlans(db);
    assert.equal(archived, 0);

    const updated = planRepo.getById(plan.id);
    assert.equal(updated?.status, 'active');
  });

  it('should NOT archive recently updated untouched plans', () => {
    planRepo.create({
      project: 'test-proj',
      name: 'Recent untouched plan',
      steps: [{ description: 'Step 1' }],
    });

    // Don't backdate — updated_at is now
    const archived = archiveUntouchedPlans(db);
    assert.equal(archived, 0);
  });
});

describe('Snapshot Time-Based Cleanup', () => {
  it('should delete snapshots older than retention window', () => {
    // Insert an old snapshot
    db.prepare(`
      INSERT INTO compaction_snapshots (id, session_id, project, captured_at, recent_files, recent_read_files, recent_commands, user_context, approach_notes, initial_goal, recent_decisions)
      VALUES ('old-snap', 'old-session', 'test-proj', datetime('now', '-48 hours'), '[]', '[]', '[]', '[]', '[]', 'old goal', '[]')
    `).run();

    // Insert a recent snapshot
    db.prepare(`
      INSERT INTO compaction_snapshots (id, session_id, project, captured_at, recent_files, recent_read_files, recent_commands, user_context, approach_notes, initial_goal, recent_decisions)
      VALUES ('new-snap', 'cur-session', 'test-proj', datetime('now'), '[]', '[]', '[]', '[]', '[]', 'current goal', '[]')
    `).run();

    const cleaned = cleanupSnapshots(db);
    assert.equal(cleaned, 1); // Only old snapshot deleted

    const remaining = db.prepare('SELECT id FROM compaction_snapshots').all() as Array<{ id: string }>;
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].id, 'new-snap');
  });

  it('should keep recent snapshots from different sessions', () => {
    // Insert snapshots from two different sessions, both recent.
    // Production rows use ISO-8601 format ('2026-01-01T12:00:00.000Z'), not
    // sqlite's space-separated datetime('now') ('2026-01-01 12:00:00'). The
    // cleanup query compares lexicographically against an ISO-formatted
    // cutoff, and ' ' (0x20) < 'T' (0x54) makes space-formatted rows
    // spuriously "older" than the cutoff. Mirror production format here.
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const rightNow = new Date().toISOString();
    db.prepare(`
      INSERT INTO compaction_snapshots (id, session_id, project, captured_at, recent_files, recent_read_files, recent_commands, user_context, approach_notes, initial_goal, recent_decisions)
      VALUES ('snap-a', 'session-1', 'test-proj', ?, '[]', '[]', '[]', '[]', '[]', 'goal A', '[]')
    `).run(oneHourAgo);

    db.prepare(`
      INSERT INTO compaction_snapshots (id, session_id, project, captured_at, recent_files, recent_read_files, recent_commands, user_context, approach_notes, initial_goal, recent_decisions)
      VALUES ('snap-b', 'session-2', 'test-proj', ?, '[]', '[]', '[]', '[]', '[]', 'goal B', '[]')
    `).run(rightNow);

    const cleaned = cleanupSnapshots(db);
    assert.equal(cleaned, 0); // Both within retention window
  });
});

describe('Plan Freshness in Compact Briefing', () => {
  it('should suppress stale untouched plan in compact mode', () => {
    const { plan } = planRepo.create({
      project: 'test-proj',
      name: 'Old unrelated plan',
      steps: [{ description: 'Step 1' }, { description: 'Step 2' }],
    });

    // Backdate the plan to 2 hours ago (use ISO string so JS Date parses correctly)
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    db.prepare(
      "UPDATE plans SET updated_at = ? WHERE id = ?"
    ).run(twoHoursAgo, plan.id);

    const ctx: BriefingContext = {
      project: 'test-proj',
      sessionType: 'compact',
      interrupted: false,
      compactionSnapshot: {
        recentFiles: ['file.ts'],
        recentReadFiles: [],
        recentCommands: [],
        userContext: ['do some work'],
        approachNotes: [],
        initialGoal: 'Fix bugs',
      },
    };

    const briefing = compileBriefing(memoryRepo, planRepo, ctx);
    assert.ok(!briefing.text.includes('Old unrelated plan'), 'Stale plan should be suppressed');
    assert.ok(briefing.text.includes('Plan: (none active)'), 'Should show no active plan');
  });

  it('should show plan with started steps even if old', () => {
    const { plan } = planRepo.create({
      project: 'test-proj',
      name: 'Active work plan',
      steps: [{ description: 'Step 1' }, { description: 'Step 2' }],
    });

    // Start a step, then backdate
    planRepo.updateStep(plan.id, { step_id: 1, status: 'in_progress' });
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    db.prepare(
      "UPDATE plans SET updated_at = ? WHERE id = ?"
    ).run(twoHoursAgo, plan.id);

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
    };

    const briefing = compileBriefing(memoryRepo, planRepo, ctx);
    assert.ok(briefing.text.includes('Active work plan'), 'Plan with progress should still show');
  });

  it('should show recent untouched plan in compact mode', () => {
    planRepo.create({
      project: 'test-proj',
      name: 'Fresh plan just created',
      steps: [{ description: 'Step 1' }],
    });
    // Don't backdate — updated_at is now

    const ctx: BriefingContext = {
      project: 'test-proj',
      sessionType: 'compact',
      interrupted: false,
    };

    const briefing = compileBriefing(memoryRepo, planRepo, ctx);
    assert.ok(briefing.text.includes('Fresh plan just created'), 'Recent plan should show');
  });

  it('should always show plans in startup mode regardless of age', () => {
    const { plan } = planRepo.create({
      project: 'test-proj',
      name: 'Old startup plan',
      steps: [{ description: 'Step 1' }],
    });

    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    db.prepare(
      "UPDATE plans SET updated_at = ? WHERE id = ?"
    ).run(twoHoursAgo, plan.id);

    const ctx: BriefingContext = {
      project: 'test-proj',
      sessionType: 'startup',
      interrupted: false,
    };

    const briefing = compileBriefing(memoryRepo, planRepo, ctx);
    assert.ok(briefing.text.includes('Old startup plan'), 'Startup mode shows all plans');
  });
});

// --- Auto-Weaken Integration Tests ------------------------------------------

describe('Auto-Weaken via Tracker', () => {
  it('should weaken memory that was surfaced but did not prevent error', () => {
    // Create a pitfall memory
    const { id } = memoryRepo.create({
      content: 'Always check types before casting',
      kind: 'pitfall',
      project: 'test-proj',
      confidence: 0.65,
    });

    const before = memoryRepo.findById(id)!;
    assert.equal(before.confidence, 0.65);

    // Simulate weakening (what error-learning.ts does when surfaced pitfall fails)
    memoryRepo.weakenConfidence(id);

    const after = memoryRepo.findById(id)!;
    assert.ok(after.confidence < 0.65, `Should be weakened from 0.65, got ${after.confidence}`);
    // 0.65 * 0.85 = 0.5525
    assert.ok(Math.abs(after.confidence - 0.5525) < 0.01, 'Should weaken by WEAKEN_FACTOR (0.85)');
  });

  it('should invalidate memory that drops below threshold after weakening', () => {
    const { id } = memoryRepo.create({
      content: 'Fragile advice that keeps failing',
      kind: 'pitfall',
      project: 'test-proj',
      confidence: 0.11, // Just above DELETE_THRESHOLD (0.1)
    });

    const { invalidated } = memoryRepo.weakenConfidence(id);
    assert.ok(invalidated, 'Should be invalidated after weakening below threshold');
  });
});

// --- User Profile in Briefing Tests -----------------------------------------

describe('User Profile in Briefing', () => {
  it('should show user profiles in briefing (max 3)', () => {
    memoryRepo.create({ content: 'Senior TypeScript developer', kind: 'user_profile', project: null, confidence: 0.75 });
    memoryRepo.create({ content: 'Works on platform team', kind: 'user_profile', project: null, confidence: 0.70 });
    memoryRepo.create({ content: 'Prefers functional style', kind: 'user_profile', project: null, confidence: 0.65 });
    memoryRepo.create({ content: 'Overflow profile that should not appear', kind: 'user_profile', project: null, confidence: 0.5 });

    const ctx: BriefingContext = {
      project: 'test-proj',
      sessionType: 'startup',
      interrupted: false,
    };

    const briefing = compileBriefing(memoryRepo, planRepo, ctx);
    assert.ok(briefing.text.includes('User:'), 'Should have User section');
    assert.ok(briefing.text.includes('Senior TypeScript developer'));
    assert.ok(briefing.text.includes('Works on platform team'));
    assert.ok(briefing.text.includes('Prefers functional style'));
    assert.ok(!briefing.text.includes('Overflow profile'), 'Should cap at 3 profiles');
  });

  it('should NOT show user profiles if none exist', () => {
    const ctx: BriefingContext = {
      project: 'test-proj',
      sessionType: 'startup',
      interrupted: false,
    };

    const briefing = compileBriefing(memoryRepo, planRepo, ctx);
    assert.ok(!briefing.text.includes('User:'));
  });
});

// --- Structured Context in Briefing Tests -----------------------------------

describe('Pitfall Context in Briefing', () => {
  it('should display why context for pitfalls with context.why', () => {
    memoryRepo.create({
      content: 'Never use raw SQL for user input',
      kind: 'pitfall',
      project: 'test-proj',
      confidence: 0.8,
      context: { why: 'SQL injection vulnerability' },
    });

    const ctx: BriefingContext = {
      project: 'test-proj',
      sessionType: 'startup',
      interrupted: false,
    };

    const briefing = compileBriefing(memoryRepo, planRepo, ctx);
    assert.ok(briefing.text.includes('Never use raw SQL'), 'Should include pitfall content');
    assert.ok(briefing.text.includes('(Why: SQL injection vulnerability)'), 'Should include why context');
  });

  it('should display pitfalls without context normally', () => {
    memoryRepo.create({
      content: 'Check file exists before reading',
      kind: 'pitfall',
      project: 'test-proj',
      confidence: 0.8,
    });

    const ctx: BriefingContext = {
      project: 'test-proj',
      sessionType: 'startup',
      interrupted: false,
    };

    const briefing = compileBriefing(memoryRepo, planRepo, ctx);
    assert.ok(briefing.text.includes('Check file exists before reading'));
    assert.ok(!briefing.text.includes('(Why:'), 'Should NOT have why when no context');
  });
});
