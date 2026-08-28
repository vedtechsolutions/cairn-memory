/**
 * Behavioral tests for the PostToolUseFailure error-learning handler and the
 * PostToolUse success-tracker handler — previously zero direct coverage.
 *
 * Harness: real repositories over an in-memory DB + a real SessionCache.
 * Tracker state is isolated per test by pointing CAIRN_DIR at a mkdtemp dir.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import type Database from 'better-sqlite3';
import { openDatabase } from '../src/db/connection.js';
import { MemoryRepository } from '../src/db/memory-repository.js';
import { PlanRepository } from '../src/db/plan-repository.js';
import { ReminderRepository } from '../src/db/reminder-repository.js';
import { ContextRepository } from '../src/db/context-repository.js';
import { InvestigationRepository } from '../src/db/investigation-repository.js';
import { SessionCache } from '../src/hooks/shared/session-cache.js';
import type { CachedHookContext } from '../src/hooks/shared/db-client.js';
import { handleErrorLearning } from '../src/hooks/handlers/error-learning-handler.js';
import { handleSuccessTracker } from '../src/hooks/handlers/success-tracker-handler.js';
import { loadTracker, type EditTracker } from '../src/hooks/shared/edit-tracker.js';
import { resetErrorTracker } from '../src/utils/error-classifier.js';
import { projectId } from '../src/utils/project-id.js';
import {
  CONFIDENCE,
  ESCALATION,
  ESCALATION_ALTERNATIVES,
} from '../src/constants/index.js';
import type { PostToolUseFailureInput, PostToolUseInput } from '../src/hooks/shared/hook-io.js';

const SESSION = 'sess-error-success';
const TS_ERROR = "error TS2345: Argument of type 'string' is not assignable to type 'number'";

let db: Database.Database;
let cache: SessionCache;
let client: CachedHookContext;
let cairnDir: string;
let workDir: string;
let savedCairnDir: string | undefined;

beforeEach(() => {
  savedCairnDir = process.env.CAIRN_DIR;
  cairnDir = mkdtempSync(join(tmpdir(), 'cairn-esh-state-'));
  workDir = mkdtempSync(join(tmpdir(), 'cairn-esh-work-'));
  process.env.CAIRN_DIR = cairnDir;
  resetErrorTracker();

  db = openDatabase({ dbPath: ':memory:' });
  cache = new SessionCache();
  client = {
    db,
    memoryRepo: new MemoryRepository(db),
    planRepo: new PlanRepository(db),
    reminderRepo: new ReminderRepository(db),
    contextRepo: new ContextRepository(db),
    investigationRepo: new InvestigationRepository(db),
    close: () => db.close(),
    cache,
  };
});

afterEach(() => {
  try { db.close(); } catch { /* already closed */ }
  if (savedCairnDir === undefined) {
    delete process.env.CAIRN_DIR;
  } else {
    process.env.CAIRN_DIR = savedCairnDir;
  }
  rmSync(cairnDir, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
});

function failureInput(overrides: {
  error: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  is_interrupt?: boolean;
}): PostToolUseFailureInput {
  return {
    session_id: SESSION,
    transcript_path: join(workDir, 'transcript.jsonl'),
    cwd: workDir,
    tool_name: overrides.tool_name ?? 'Edit',
    tool_input: overrides.tool_input ?? { file_path: join(workDir, 'app.ts') },
    error: overrides.error,
    is_interrupt: overrides.is_interrupt ?? false,
  };
}

function successInput(overrides: {
  tool_name: string;
  tool_input?: Record<string, unknown>;
  tool_response?: string;
}): PostToolUseInput {
  return {
    session_id: SESSION,
    transcript_path: join(workDir, 'transcript.jsonl'),
    cwd: workDir,
    tool_name: overrides.tool_name,
    tool_input: overrides.tool_input ?? {},
    tool_response: overrides.tool_response ?? '',
  };
}

function pitfallCount(): number {
  const row = db.prepare("SELECT COUNT(*) AS c FROM memories WHERE kind = 'pitfall'").get() as { c: number };
  return row.c;
}

function memoryRow(id: string): { confidence: number; impact_count: number } {
  return db.prepare('SELECT confidence, impact_count FROM memories WHERE id = ?').get(id) as {
    confidence: number;
    impact_count: number;
  };
}

/** Fresh default tracker (CAIRN_DIR temp dir is empty, so this is pure defaults). */
function freshTracker(): EditTracker {
  return loadTracker(SESSION);
}

describe('handleErrorLearning', () => {
  it('creates a pitfall memory with a distilled lesson from a learnable TypeScript error', async () => {
    const result = await handleErrorLearning(failureInput({ error: TS_ERROR }), client);

    assert.equal(result.action, 'learned-new');
    assert.equal(result.sessionCount, 1);
    assert.ok(result.output, 'first occurrence must inject the lesson');
    assert.ok(result.output.includes('[CAIRN]'));
    assert.ok(result.output.includes('TS2345'));

    assert.equal(pitfallCount(), 1);
    const row = db.prepare("SELECT content, project, confidence, tags FROM memories WHERE kind = 'pitfall'").get() as {
      content: string; project: string; confidence: number; tags: string;
    };
    assert.ok(row.content.includes('TS2345'));
    assert.ok(row.content.includes('Fix:'), 'distilled lesson carries an actionable fix');
    assert.equal(row.project, projectId(workDir));
    assert.equal(row.confidence, CONFIDENCE.AUTO_DETECTED);
    assert.ok((JSON.parse(row.tags) as string[]).includes('typescript'));
  });

  it('does not create a pitfall for noise/transient errors', async () => {
    const result = await handleErrorLearning(
      failureInput({ error: 'ECONNREFUSED: connection refused by 127.0.0.1:5432', tool_name: 'Bash', tool_input: { command: 'curl localhost' } }),
      client,
    );

    assert.equal(result.action, 'skip');
    assert.equal(result.output, null);
    assert.equal(result.sessionCount, 0);
    assert.equal(pitfallCount(), 0);
  });

  it('skips user interrupts and empty errors without touching the DB', async () => {
    const interrupted = await handleErrorLearning(failureInput({ error: TS_ERROR, is_interrupt: true }), client);
    assert.equal(interrupted.action, 'skip');
    assert.equal(interrupted.output, null);

    const empty = await handleErrorLearning(failureInput({ error: '' }), client);
    assert.equal(empty.action, 'skip');

    assert.equal(pitfallCount(), 0);
  });

  it('dedups the same error within a session: one pitfall plus a pre-escalation warning', async () => {
    const first = await handleErrorLearning(failureInput({ error: TS_ERROR }), client);
    assert.equal(first.action, 'learned-new');

    const second = await handleErrorLearning(failureInput({ error: TS_ERROR }), client);
    assert.equal(second.action, 'warning');
    assert.equal(second.sessionCount, 2);
    assert.ok(second.output);
    assert.ok(second.output.includes('occurred before this session'));

    assert.equal(pitfallCount(), 1, 'repeated error must not create a second identical pitfall');
  });

  it('escalates with a category-specific alternative once the session threshold is reached', async () => {
    let last = await handleErrorLearning(failureInput({ error: TS_ERROR }), client);
    for (let i = 1; i < ESCALATION.THRESHOLD; i++) {
      last = await handleErrorLearning(failureInput({ error: TS_ERROR }), client);
    }

    assert.equal(last.action, 'escalation');
    assert.equal(last.sessionCount, ESCALATION.THRESHOLD);
    assert.ok(last.output);
    assert.ok(last.output.includes('[CAIRN ESCALATION]'));
    assert.ok(last.output.includes(`${ESCALATION.THRESHOLD} times`));
    assert.ok(last.output.includes(ESCALATION_ALTERNATIVES['typescript']));

    const tracker = cache.getTracker(SESSION);
    assert.ok(tracker, 'session error counts must be tracked in the cache');
    const counts = Object.values(tracker.sessionErrorCounts).map(e => e.count);
    assert.deepEqual(counts, [ESCALATION.THRESHOLD]);
  });

  it('weakens a surfaced pitfall that failed to prevent an unrelated error and clears the file entry', async () => {
    const filePath = join(workDir, 'app.ts');
    const planted = client.memoryRepo.storePitfall({
      content: 'Beware circular imports between hooks modules',
      project: projectId(workDir),
      confidence: 0.9,
    });

    const tracker = freshTracker();
    tracker.surfacedPitfalls[filePath] = [planted.id];
    tracker.recentlySurfaced[planted.id] = Date.now();
    cache.setTracker(SESSION, tracker);

    await handleErrorLearning(failureInput({ error: TS_ERROR, tool_input: { file_path: filePath } }), client);

    const row = memoryRow(planted.id);
    assert.ok(
      Math.abs(row.confidence - 0.9 * CONFIDENCE.WEAKEN_FACTOR) < 1e-9,
      `irrelevant surfaced pitfall must be weakened (got ${row.confidence})`,
    );
    assert.equal(row.impact_count, 0);

    const after = cache.getTracker(SESSION);
    assert.ok(after);
    assert.equal(after.surfacedPitfalls[filePath], undefined, 'surfaced entry must be cleared after the failure');
  });

  it('credits double impact instead of weakening when the surfaced pitfall predicted the error', async () => {
    const filePath = join(workDir, 'app.ts');
    const planted = client.memoryRepo.storePitfall({
      content: 'Refactoring generics: argument shapes drift until assignable checks fail',
      project: projectId(workDir),
      confidence: 0.9,
    });

    const tracker = freshTracker();
    tracker.surfacedPitfalls[filePath] = [planted.id];
    tracker.recentlySurfaced[planted.id] = Date.now();
    cache.setTracker(SESSION, tracker);

    await handleErrorLearning(failureInput({ error: TS_ERROR, tool_input: { file_path: filePath } }), client);

    const row = memoryRow(planted.id);
    assert.equal(row.impact_count, 2, 'ignored-but-correct warning earns double impact credit');
    assert.equal(row.confidence, 0.9, 'correctly predicting pitfall must not be weakened');
  });

  it('creates an investigation chain on the first error and appends attempts on subsequent errors', async () => {
    const project = projectId(workDir);

    await handleErrorLearning(failureInput({ error: TS_ERROR }), client);
    const chain = client.investigationRepo.getActiveChain(project, SESSION);
    assert.ok(chain, 'first classified error must open an investigation chain');
    assert.ok(chain.trigger_error.includes('TSN'), 'trigger uses the digit-normalized error key');
    assert.equal(chain.attempts.length, 1);
    assert.equal(chain.attempts[0].approach, 'Edit on app.ts');
    assert.equal(chain.memory_ids.length, 1, 'newly learned pitfall is linked to the chain');

    await handleErrorLearning(
      failureInput({ error: 'ReferenceError: undefinedVar is not defined', tool_name: 'Bash', tool_input: { command: 'node app.js' } }),
      client,
    );
    const updated = client.investigationRepo.getActiveChain(project, SESSION);
    assert.ok(updated);
    assert.equal(updated.id, chain.id, 'second error appends to the same chain');
    assert.equal(updated.attempts.length, 2);
    assert.equal(updated.attempts[1].approach, 'Bash');
  });
});

describe('handleSuccessTracker', () => {
  it('ignores tools other than Write/Edit/MultiEdit/Bash', async () => {
    const result = await handleSuccessTracker(
      successInput({ tool_name: 'Read', tool_input: { file_path: join(workDir, 'a.ts') } }),
      client,
    );
    assert.equal(result.tracked, false);
    assert.equal(cache.getTracker(SESSION), undefined, 'tracker must not be created for untracked tools');
  });

  it('records last edit path, time, resume cursor line, and per-file edit count on successful Edit', async () => {
    const filePath = join(workDir, 'cursor.ts');
    writeFileSync(filePath, 'const one = 1;\nconst two = 2;\nconst target = 3;\n', 'utf-8');
    const before = Date.now();

    const result = await handleSuccessTracker(
      successInput({
        tool_name: 'Edit',
        tool_input: { file_path: filePath, old_string: 'const target = 3;', new_string: 'const target = 4;' },
      }),
      client,
    );

    assert.equal(result.tracked, true);
    const tracker = cache.getTracker(SESSION);
    assert.ok(tracker);
    assert.equal(tracker.lastEditPath, filePath);
    assert.ok(tracker.lastEditTime >= before);
    assert.ok(tracker.lastEditCursor);
    assert.equal(tracker.lastEditCursor.file, filePath);
    assert.equal(tracker.lastEditCursor.tool, 'Edit');
    assert.equal(tracker.lastEditCursor.line, 3, 'cursor line located via the old_string anchor');
    assert.equal(tracker.editCountsByFile[filePath], 1);
    assert.equal(tracker.toolChain.length, 1);
    assert.equal(tracker.toolChain[0].success, true);
  });

  it('anchors the resume cursor at line 1 for Write', async () => {
    const filePath = join(workDir, 'fresh.ts');
    await handleSuccessTracker(
      successInput({ tool_name: 'Write', tool_input: { file_path: filePath, content: 'export {};\n' } }),
      client,
    );

    const tracker = cache.getTracker(SESSION);
    assert.ok(tracker?.lastEditCursor);
    assert.equal(tracker.lastEditCursor.tool, 'Write');
    assert.equal(tracker.lastEditCursor.line, 1);
  });

  it('increments the edit count for each unique file touched by MultiEdit', async () => {
    const fileA = join(workDir, 'a.ts');
    const fileB = join(workDir, 'b.ts');
    await handleSuccessTracker(
      successInput({
        tool_name: 'MultiEdit',
        tool_input: {
          file_path: fileA,
          edits: [
            { file_path: fileA, old_string: 'x', new_string: 'y' },
            { file_path: fileB, old_string: 'x', new_string: 'y' },
          ],
        },
      }),
      client,
    );

    const tracker = cache.getTracker(SESSION);
    assert.ok(tracker);
    assert.equal(tracker.editCountsByFile[fileA], 1);
    assert.equal(tracker.editCountsByFile[fileB], 1);
  });

  it('boosts confidence and credits impact for surfaced pitfalls on a successful edit, then clears the entry', async () => {
    const filePath = join(workDir, 'guarded.ts');
    const planted = client.memoryRepo.storePitfall({
      content: 'Always update the barrel export when renaming guarded module symbols',
      project: projectId(workDir),
      confidence: 0.5,
    });

    const tracker = freshTracker();
    tracker.surfacedPitfalls[filePath] = [planted.id];
    cache.setTracker(SESSION, tracker);

    await handleSuccessTracker(
      successInput({ tool_name: 'Edit', tool_input: { file_path: filePath, old_string: 'a', new_string: 'b' } }),
      client,
    );

    const row = memoryRow(planted.id);
    assert.ok(
      Math.abs(row.confidence - (0.5 + CONFIDENCE.PREDICTION_VERIFIED_BOOST)) < 1e-9,
      `verified pitfall must gain the prediction boost (got ${row.confidence})`,
    );
    assert.equal(row.impact_count, 1);

    const after = cache.getTracker(SESSION);
    assert.ok(after);
    assert.equal(after.surfacedPitfalls[filePath], undefined, 'confirmed entry must be cleared');
  });

  it('adds a plan note to the in_progress step when an edit chain ends in a passing test, then resets the chain', async () => {
    const project = projectId(workDir);
    const { plan } = client.planRepo.create({
      project,
      name: 'ship feature',
      steps: [{ description: 'implement handler' }],
    });
    client.planRepo.updateStep(plan.id, { step_id: 1, status: 'in_progress' });

    const filePath = join(workDir, 'feature.ts');
    await handleSuccessTracker(
      successInput({ tool_name: 'Edit', tool_input: { file_path: filePath, old_string: 'a', new_string: 'b' } }),
      client,
    );
    await handleSuccessTracker(
      successInput({ tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: 'all tests pass' }),
      client,
    );

    const active = client.planRepo.getActive(project);
    assert.ok(active);
    const step = active.steps.find(s => s.step_id === 1);
    assert.ok(step);
    assert.equal(step.notes.length, 1);
    assert.ok(step.notes[0].note.startsWith('Verified:'));
    assert.ok(step.notes[0].note.includes(basename(filePath)));

    const tracker = cache.getTracker(SESSION);
    assert.ok(tracker);
    assert.deepEqual(tracker.toolChain, [], 'tool chain resets after a detected success pattern');
    assert.equal(tracker.successDedup.lastPattern, 'Direct edit → test pass');
  });

  it('resolves the active investigation chain when the success pattern fires', async () => {
    const project = projectId(workDir);
    const chain = client.investigationRepo.create(project, SESSION, 'error TSN: something', {
      approach: 'Edit on feature.ts',
      outcome: 'error',
      timestamp: new Date().toISOString(),
    });

    const filePath = join(workDir, 'feature.ts');
    await handleSuccessTracker(
      successInput({ tool_name: 'Edit', tool_input: { file_path: filePath, old_string: 'a', new_string: 'b' } }),
      client,
    );
    await handleSuccessTracker(
      successInput({ tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: 'tests pass' }),
      client,
    );

    assert.equal(client.investigationRepo.getActiveChain(project, SESSION), null, 'chain must be resolved');
    const row = db.prepare('SELECT resolution FROM investigation_chains WHERE id = ?').get(chain.id) as { resolution: string | null };
    assert.ok(row.resolution);
    assert.ok(row.resolution.includes(basename(filePath)));
  });

  it('dedups repeated success patterns: no second plan note and the tool chain is preserved', async () => {
    const project = projectId(workDir);
    const { plan } = client.planRepo.create({
      project,
      name: 'ship feature',
      steps: [{ description: 'implement handler' }],
    });
    client.planRepo.updateStep(plan.id, { step_id: 1, status: 'in_progress' });

    const filePath = join(workDir, 'feature.ts');
    const round = async (): Promise<void> => {
      await handleSuccessTracker(
        successInput({ tool_name: 'Edit', tool_input: { file_path: filePath, old_string: 'a', new_string: 'b' } }),
        client,
      );
      await handleSuccessTracker(
        successInput({ tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: 'tests pass' }),
        client,
      );
    };

    await round(); // detected — note added, chain cleared
    await round(); // same pattern inside the dedup window — must be suppressed

    const active = client.planRepo.getActive(project);
    assert.ok(active);
    assert.equal(active.steps[0].notes.length, 1, 'dedup window must suppress a duplicate note');

    const tracker = cache.getTracker(SESSION);
    assert.ok(tracker);
    assert.equal(tracker.toolChain.length, 2, 'suppressed pattern must not reset the tool chain');
  });
});
