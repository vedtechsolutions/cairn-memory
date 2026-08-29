/**
 * session-start-handler orchestration tests.
 *
 * handleSessionStart is a pure function (input, client-context) → result.
 * These tests exercise the real pipeline over an in-memory DB with real
 * repositories and a real SessionCache — no mocks. input.cwd points at a
 * non-git temp dir so git/fs probes fail safe; nothing here asserts on
 * git-dependent output. Briefing-compiler internals are covered elsewhere —
 * this file only asserts the handler's observable orchestration behavior.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

import { handleSessionStart } from '../src/hooks/handlers/session-start-handler.js';
import type { SessionStartInput } from '../src/hooks/shared/hook-io.js';
import type { CachedHookContext } from '../src/hooks/shared/db-client.js';
import { openDatabase } from '../src/db/connection.js';
import { MemoryRepository } from '../src/db/memory-repository.js';
import { PlanRepository } from '../src/db/plan-repository.js';
import { ReminderRepository } from '../src/db/reminder-repository.js';
import { ContextRepository } from '../src/db/context-repository.js';
import { InvestigationRepository } from '../src/db/investigation-repository.js';
import { SessionCache } from '../src/hooks/shared/session-cache.js';
import { loadTracker } from '../src/hooks/shared/edit-tracker.js';
import { writeState } from '../src/hooks/shared/state-io.js';
import { projectId } from '../src/utils/project-id.js';
import { BRIEFING_BUDGET } from '../src/constants/index.js';

const FULL_HEADER = '[Waykeep Memory Briefing]';
const INDEX_HEADER = '[Waykeep Memory Briefing — index]';

let db: Database.Database;
let memoryRepo: MemoryRepository;
let planRepo: PlanRepository;
let reminderRepo: ReminderRepository;
let cache: SessionCache;
let client: CachedHookContext;
let cwd: string;
let project: string;
let trackerDir: string;
let savedCairnDir: string | undefined;

beforeEach(() => {
  db = openDatabase({ dbPath: ':memory:' });
  memoryRepo = new MemoryRepository(db);
  planRepo = new PlanRepository(db);
  reminderRepo = new ReminderRepository(db);
  cache = new SessionCache();
  client = {
    db,
    memoryRepo,
    planRepo,
    reminderRepo,
    contextRepo: new ContextRepository(db),
    investigationRepo: new InvestigationRepository(db),
    cache,
    close: () => db.close(),
  };

  // Non-git cwd: getGitHash/getGitWorkingState/scanProject fail safe against it.
  cwd = mkdtempSync(join(tmpdir(), 'cairn-ssh-cwd-'));
  project = projectId(cwd);

  // Trackers live under CAIRN_DIR — give each test its own directory so
  // loadTracker/saveTracker/cleanupOrphanTrackers never share state.
  savedCairnDir = process.env.CAIRN_DIR;
  trackerDir = mkdtempSync(join(tmpdir(), 'cairn-ssh-tracker-'));
  process.env.CAIRN_DIR = trackerDir;
});

afterEach(() => {
  db.close();
  if (savedCairnDir === undefined) {
    delete process.env.CAIRN_DIR;
  } else {
    process.env.CAIRN_DIR = savedCairnDir;
  }
  rmSync(cwd, { recursive: true, force: true });
  rmSync(trackerDir, { recursive: true, force: true });
});

function makeInput(sessionId: string, type?: SessionStartInput['type']): SessionStartInput {
  const base = {
    session_id: sessionId,
    transcript_path: join(cwd, 'transcript.jsonl'),
    cwd,
  };
  // The handler tolerates a missing 'type' (Claude Code omits it after
  // compaction) — model that by casting a type-less object.
  return (type ? { ...base, type } : base) as SessionStartInput;
}

function insertSnapshot(opts: {
  sessionId: string;
  capturedAt?: string;
  recentFiles?: string[];
  initialGoal?: string | null;
}): void {
  db.prepare(`
    INSERT INTO compaction_snapshots
      (id, session_id, project, captured_at, recent_files, recent_read_files,
       recent_commands, user_context, approach_notes, initial_goal)
    VALUES (?, ?, ?, ?, ?, '[]', '[]', '[]', '[]', ?)
  `).run(
    randomUUID(),
    opts.sessionId,
    project,
    opts.capturedAt ?? new Date().toISOString(),
    JSON.stringify(opts.recentFiles ?? []),
    opts.initialGoal ?? null,
  );
}

/** Build a fresh default tracker without touching disk (no file exists for a random id). */
function freshTracker() {
  return loadTracker(randomUUID());
}

describe('session typing', () => {
  it('passes through an explicit startup type and renders the full briefing header', () => {
    const result = handleSessionStart(makeInput(randomUUID(), 'startup'), client);
    assert.equal(result.sessionType, 'startup');
    assert.ok(result.output.includes(FULL_HEADER), `expected full header in: ${result.output}`);
  });

  it('passes through an explicit resume type and renders the index briefing', () => {
    const result = handleSessionStart(makeInput(randomUUID(), 'resume'), client);
    assert.equal(result.sessionType, 'resume');
    assert.ok(result.output.includes(INDEX_HEADER), `expected index header in: ${result.output}`);
  });

  it('infers compact when the tracker recorded a compaction within the last 30 seconds', () => {
    const sessionId = randomUUID();
    const tracker = freshTracker();
    tracker.lastCompactAt = Date.now() - 1_000;
    tracker.lastCompactSessionId = sessionId;
    cache.setTracker(sessionId, tracker);

    const result = handleSessionStart(makeInput(sessionId), client);
    assert.equal(result.sessionType, 'compact');
  });

  it('infers compact from a recent compaction snapshot when the tracker is cold', () => {
    const sessionId = randomUUID();
    insertSnapshot({ sessionId, recentFiles: ['src/app.ts'] });

    const result = handleSessionStart(makeInput(sessionId), client);
    assert.equal(result.sessionType, 'compact');
  });

  it('infers startup when there is no recent compaction evidence', () => {
    const result = handleSessionStart(makeInput(randomUUID()), client);
    assert.equal(result.sessionType, 'startup');
  });

  it('does not treat a stale tracker compaction timestamp as compact', () => {
    const sessionId = randomUUID();
    const tracker = freshTracker();
    tracker.lastCompactAt = Date.now() - 10 * 60_000; // well past the 30s window
    cache.setTracker(sessionId, tracker);

    const result = handleSessionStart(makeInput(sessionId), client);
    assert.equal(result.sessionType, 'startup');
  });
});

describe('interruption detection', () => {
  it('flags interruption when the active plan has an in_progress step on a fresh startup', () => {
    const { plan } = planRepo.create({
      project,
      name: 'Migrate billing pipeline',
      steps: [{ description: 'Extract invoice schema' }, { description: 'Backfill ledger rows' }],
    });
    const claimed = planRepo.updateStep(plan.id, { step_id: 1, status: 'in_progress' });
    assert.equal(claimed.ok, true, 'test setup: step claim must succeed');

    const result = handleSessionStart(makeInput(randomUUID(), 'startup'), client);
    assert.equal(result.interrupted, true);
    assert.ok(result.output.includes('Migrate billing pipeline'), 'briefing should mention the interrupted plan');
    assert.ok(result.output.includes('[interrupted]'), 'briefing should carry the interrupted marker');
  });

  it('reports a clean state when no plan step is in progress', () => {
    planRepo.create({
      project,
      name: 'Migrate billing pipeline',
      steps: [{ description: 'Extract invoice schema' }],
    });

    const result = handleSessionStart(makeInput(randomUUID(), 'startup'), client);
    assert.equal(result.interrupted, false);
    assert.ok(!result.output.includes('[interrupted]'));
  });

  it('does not flag interruption on post-compaction sessions even with an in_progress step', () => {
    const { plan } = planRepo.create({
      project,
      name: 'Migrate billing pipeline',
      steps: [{ description: 'Extract invoice schema' }],
    });
    planRepo.updateStep(plan.id, { step_id: 1, status: 'in_progress' });

    const result = handleSessionStart(makeInput(randomUUID(), 'compact'), client);
    assert.equal(result.interrupted, false);
  });
});

describe('briefing content', () => {
  it('renders governance only for governed projects with exact advisory wording', () => {
    const plain = handleSessionStart(makeInput(randomUUID(), 'startup'), client);
    assert.doesNotMatch(plain.output, /Cairn Governance/u);

    mkdirSync(join(cwd, '.cairn'));
    writeFileSync(join(cwd, '.cairn', 'gates.json'), '{}');
    const governed = handleSessionStart(makeInput(randomUUID(), 'startup'), client);
    assert.match(governed.output, /\[Waykeep Governance — advisory; not enforced\]/u);
    assert.ok(governed.tokenEstimate <= BRIEFING_BUDGET.STARTUP_MAX);
  });

  it('surfaces seeded same-project pitfalls and corrections in the startup briefing', () => {
    memoryRepo.create({
      content: 'Never call db.exec after closing the sqlite connection — reopen first',
      kind: 'pitfall',
      project,
    });
    memoryRepo.create({
      content: 'Always run the full test suite before reporting a task as done',
      kind: 'correction',
      project,
    });

    const result = handleSessionStart(makeInput(randomUUID(), 'startup'), client);
    assert.ok(
      result.output.includes('db.exec after closing the sqlite connection'),
      `pitfall missing from briefing: ${result.output}`,
    );
    assert.ok(
      result.output.includes('Always run the full test suite'),
      `correction missing from briefing: ${result.output}`,
    );
  });

  it('excludes memories that belong to a different project', () => {
    memoryRepo.create({
      content: 'Foreign pitfall about kubernetes ingress misconfiguration in staging',
      kind: 'pitfall',
      project: 'other-project-deadbeef',
    });

    const result = handleSessionStart(makeInput(randomUUID(), 'startup'), client);
    assert.ok(
      !result.output.includes('kubernetes ingress'),
      'foreign-project pitfall must not leak into the briefing',
    );
  });
});

describe('budget', () => {
  it('returns a positive token estimate within the startup budget on a seeded store', () => {
    for (let i = 0; i < 8; i++) {
      memoryRepo.create({
        content: `Pitfall ${i}: validate the ${i}th migration output before applying the next batch`,
        kind: 'pitfall',
        project,
        confidence: 0.8,
      });
    }

    const result = handleSessionStart(makeInput(randomUUID(), 'startup'), client);
    assert.ok(Number.isFinite(result.tokenEstimate), 'token estimate must be a finite number');
    assert.ok(result.tokenEstimate > 0, `expected positive estimate, got ${result.tokenEstimate}`);
    assert.ok(
      result.tokenEstimate <= BRIEFING_BUDGET.STARTUP_MAX,
      `estimate ${result.tokenEstimate} exceeds startup budget ${BRIEFING_BUDGET.STARTUP_MAX}`,
    );
    assert.ok(result.output.length > 0, 'output must not be empty');
  });

  it('renders a briefing header without throwing on an empty store', () => {
    const result = handleSessionStart(makeInput(randomUUID(), 'startup'), client);
    assert.ok(result.output.includes(FULL_HEADER));
    assert.ok(result.tokenEstimate > 0, 'even a header-only briefing has a positive estimate');
  });

  it('shrinks the briefing to the critical budget when context pressure is high', () => {
    // readState() resolves CAIRN_STATE_PATH (pinned by the hermetic preload),
    // so this never touches the real ~/.claude/cairn-state.json.
    writeState({ mode: 'critical', freeUntilCompact: 5 });
    try {
      for (let i = 0; i < 20; i++) {
        memoryRepo.create({
          content: `Pitfall ${i}: check connection pool ${i} exhaustion before scaling the worker fleet`,
          kind: 'pitfall',
          project,
          confidence: 0.8,
        });
      }

      const result = handleSessionStart(makeInput(randomUUID(), 'startup'), client);
      assert.ok(
        result.tokenEstimate <= BRIEFING_BUDGET.CRITICAL_MAX,
        `estimate ${result.tokenEstimate} exceeds critical budget ${BRIEFING_BUDGET.CRITICAL_MAX}`,
      );
    } finally {
      writeState({ mode: 'normal', freeUntilCompact: 100 });
    }
  });
});

describe('tracker seeding', () => {
  it('seeds the session tracker with rendered memory ids and the session id', () => {
    const pitA = memoryRepo.create({
      content: 'Never mutate the shared config object inside request handlers',
      kind: 'pitfall',
      project,
    });
    const pitB = memoryRepo.create({
      content: 'Always close file watchers when the debug server shuts down',
      kind: 'pitfall',
      project,
    });
    const sessionId = randomUUID();

    handleSessionStart(makeInput(sessionId, 'startup'), client);

    const tracker = cache.getTracker(sessionId);
    assert.ok(tracker, 'handler must store the tracker in the session cache');
    assert.equal(tracker.sessionId, sessionId);
    assert.ok(tracker.injectedMemoryIds.includes(pitA.id), 'first pitfall id must be marked injected');
    assert.ok(tracker.injectedMemoryIds.includes(pitB.id), 'second pitfall id must be marked injected');
  });

  it('does not duplicate memory ids already recorded in the tracker', () => {
    const pit = memoryRepo.create({
      content: 'Never mutate the shared config object inside request handlers',
      kind: 'pitfall',
      project,
    });
    const sessionId = randomUUID();
    const tracker = freshTracker();
    tracker.injectedMemoryIds.push(pit.id);
    cache.setTracker(sessionId, tracker);

    handleSessionStart(makeInput(sessionId, 'startup'), client);

    const after = cache.getTracker(sessionId);
    assert.ok(after);
    const occurrences = after.injectedMemoryIds.filter(id => id === pit.id).length;
    assert.equal(occurrences, 1, 'already-injected id must not be re-appended');
  });

  it('arms briefing-effectiveness tracking with snapshot files on compact sessions', () => {
    const sessionId = randomUUID();
    insertSnapshot({ sessionId, recentFiles: ['src/alpha.ts', 'src/beta.ts'] });

    handleSessionStart(makeInput(sessionId, 'compact'), client);

    const tracker = cache.getTracker(sessionId);
    assert.ok(tracker);
    assert.ok(tracker.briefingEffectiveness, 'compact sessions must arm effectiveness tracking');
    assert.equal(tracker.briefingEffectiveness.awaitingFirstPrompt, true);
    assert.ok(tracker.briefingEffectiveness.briefingFiles.includes('src/alpha.ts'));
    assert.ok(tracker.briefingEffectiveness.briefingAt > 0);
  });

  it('leaves briefing-effectiveness tracking unarmed on startup sessions', () => {
    const sessionId = randomUUID();
    handleSessionStart(makeInput(sessionId, 'startup'), client);

    const tracker = cache.getTracker(sessionId);
    assert.ok(tracker);
    assert.equal(tracker.briefingEffectiveness, null);
  });
});

describe('maintenance and session record', () => {
  it('runs startup maintenance on an empty database without throwing and records the session', () => {
    const sessionId = randomUUID();
    assert.doesNotThrow(() => handleSessionStart(makeInput(sessionId, 'startup'), client));

    const row = db.prepare('SELECT project FROM sessions WHERE id = ?').get(sessionId) as
      | { project: string }
      | undefined;
    assert.ok(row, 'a sessions row must be created for the new session');
    assert.equal(row.project, project);
  });

  it('appends due time-based reminders to the startup briefing', () => {
    const created = reminderRepo.create({
      trigger: 'weekly dependency audit',
      action: 'Run npm audit and review new advisories',
      project,
      trigger_type: 'time',
      trigger_config: { nextDue: new Date(Date.now() - 60_000).toISOString() },
    });
    assert.ok('id' in created, 'test setup: reminder creation must succeed');

    const result = handleSessionStart(makeInput(randomUUID(), 'startup'), client);
    assert.ok(
      result.output.includes('Reminder: Run npm audit and review new advisories'),
      `due reminder missing from briefing: ${result.output}`,
    );
  });
});
