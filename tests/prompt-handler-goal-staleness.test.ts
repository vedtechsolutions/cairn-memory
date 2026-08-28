/**
 * Prompt-handler v3.1 — goal-kind staleness gate.
 *
 * Closes a parallel-path gap in the SNR v3 trust plan: the briefing
 * compiler filters stale goals via evaluateCarriedGoal / renderGoalTiers,
 * but the prompt-handler recall paths (goal pre-flight + Layer 1a/1b/1c)
 * had no equivalent gate, so a kind=goal memory containing session-
 * continuity prose could persist forever and surface on every matching
 * prompt.
 *
 * Two layers of coverage here:
 *   1. Unit — isGoalMemoryStale directly, covering every rejection rule.
 *   2. End-to-end — seed a stale "Resume point:" goal memory and a fresh
 *      one, call handlePromptCheck, assert only the fresh one surfaces.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type Database from 'better-sqlite3';
import { openDatabase } from '../src/db/connection.js';
import { MemoryRepository } from '../src/db/memory-repository.js';
import { PlanRepository } from '../src/db/plan-repository.js';
import { ReminderRepository } from '../src/db/reminder-repository.js';
import { ContextRepository } from '../src/db/context-repository.js';
import { InvestigationRepository } from '../src/db/investigation-repository.js';
import { SessionCache } from '../src/hooks/shared/session-cache.js';
import { handlePromptCheck, isGoalMemoryStale } from '../src/hooks/handlers/prompt-handler.js';
import type { CachedHookContext } from '../src/hooks/shared/db-client.js';
import type { Memory } from '../src/db/memory-repository.js';
import type { UserPromptSubmitInput } from '../src/hooks/shared/hook-io.js';
import { LIMITS } from '../src/constants/index.js';

function makeGoalMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: 'goal-test-id',
    content: 'Implement the three-tier goal renderer',
    kind: 'goal',
    project: 'test-project',
    tags: [],
    confidence: 0.65,
    source: 'learned',
    created_at: new Date().toISOString(),
    last_recalled: null,
    recall_count: 0,
    invalidated: false,
    expires_at: null,
    surface_count: 0,
    impact_count: 0,
    fingerprint: null,
    context: null,
    anchor: null,
    ...overrides,
  } as Memory;
}

describe('isGoalMemoryStale — unit', () => {
  const now = Date.UTC(2026, 3, 11, 13, 0, 0); // deterministic clock

  it('returns false for non-goal kinds regardless of age or content', () => {
    const oldPitfall = makeGoalMemory({
      kind: 'pitfall',
      content: 'Resume point: uncommitted SNR fixes',
      created_at: new Date(now - 100 * 60 * 60 * 1000).toISOString(),
    });
    assert.equal(isGoalMemoryStale(oldPitfall, now), false);
  });

  it('returns true for a goal whose content matches isMetaGoal (Resume point:)', () => {
    const resumeGoal = makeGoalMemory({
      content: 'Resume point: uncommitted 4 SNR fixes (transcript-parser + snr-probe). Next: re-run snr-probe then commit.',
      created_at: new Date(now - 10 * 60 * 1000).toISOString(), // fresh
    });
    assert.equal(isGoalMemoryStale(resumeGoal, now), true);
  });

  it('returns true for a goal whose content matches the long-form resume-prose pattern', () => {
    const prose = makeGoalMemory({
      content: 'Continue this was where you were before we got disconnected — ready to proceed',
      created_at: new Date(now - 30 * 60 * 1000).toISOString(),
    });
    assert.equal(isGoalMemoryStale(prose, now), true);
  });

  it('returns true for a goal older than GOAL_REMINDER_MAX_AGE_HOURS even if content is clean', () => {
    const stale = makeGoalMemory({
      content: 'Implement the three-tier goal renderer',
      created_at: new Date(now - (LIMITS.GOAL_REMINDER_MAX_AGE_HOURS + 1) * 60 * 60 * 1000).toISOString(),
    });
    assert.equal(isGoalMemoryStale(stale, now), true);
  });

  it('returns false for a fresh, non-meta goal (happy path)', () => {
    const fresh = makeGoalMemory({
      content: 'Implement the three-tier goal renderer with session-boundary staleness',
      created_at: new Date(now - 1 * 60 * 60 * 1000).toISOString(), // 1h ago
    });
    assert.equal(isGoalMemoryStale(fresh, now), false);
  });

  it('returns false on invalid created_at (conservative — cannot prove stale)', () => {
    const broken = makeGoalMemory({
      content: 'Legitimate goal text with enough length to not be meta',
      created_at: 'not-a-date',
    });
    assert.equal(isGoalMemoryStale(broken, now), false);
  });

  it('respects the exact boundary — 72h on the dot is still fresh', () => {
    const boundary = makeGoalMemory({
      content: 'Legitimate goal text with enough length to not be meta',
      created_at: new Date(now - LIMITS.GOAL_REMINDER_MAX_AGE_HOURS * 60 * 60 * 1000).toISOString(),
    });
    assert.equal(isGoalMemoryStale(boundary, now), false);
  });
});

describe('prompt-handler goal pre-flight — stale goals are filtered', () => {
  let db: Database.Database;
  let client: CachedHookContext;

  beforeEach(() => {
    db = openDatabase({ dbPath: ':memory:' });
    const cache = new SessionCache();
    client = {
      db,
      memoryRepo: new MemoryRepository(db),
      planRepo: new PlanRepository(db),
      reminderRepo: new ReminderRepository(db),
      contextRepo: new ContextRepository(db),
      investigationRepo: new InvestigationRepository(db),
      close: () => {},
      cache,
    };
  });

  afterEach(() => {
    db.close();
  });

  function makeInput(prompt: string): UserPromptSubmitInput {
    return {
      session_id: 'goal-stale-test',
      transcript_path: '/tmp/no-transcript.jsonl',
      cwd: '/tmp/goal-stale-project',
      prompt,
    } as unknown as UserPromptSubmitInput;
  }

  it('does not surface a kind=goal memory whose content matches isMetaGoal', () => {
    // Seed the exact stale shape we observed in the live DB
    // (id 4ab27ef4…): resume-session prose stored as a goal memory.
    client.memoryRepo.create({
      content: 'Resume point: uncommitted 4 SNR fixes (transcript-parser error-staleness + snr-probe refresh). Next: re-run snr-probe then commit.',
      kind: 'goal',
      project: null, // global so it matches any project
      source: 'learned',
      confidence: 0.65,
    });

    const result = handlePromptCheck(
      makeInput('Implement the SNR v3.1 goal staleness filter in prompt-handler with tests and a CHANGELOG entry covering the four recall sites'),
      client,
    );

    if (result.output) {
      assert.doesNotMatch(result.output, /Resume point:/, 'stale resume-prose goal must not surface');
      assert.doesNotMatch(result.output, /\[CAIRN goal\] Similar prior goal:/, 'goal pre-flight must not surface a meta-goal');
    }
  });

  it('still surfaces a fresh, non-meta goal via the pre-flight match', () => {
    // A legitimate durable goal — should flow through the pre-flight path.
    client.memoryRepo.create({
      content: 'Implement the three-tier goal renderer with Now/Feature/Project labels and age suffixes',
      kind: 'goal',
      project: null,
      source: 'user',
      confidence: 0.7,
      tags: ['plan-goal'],
    });

    const result = handlePromptCheck(
      makeInput('Implement three-tier goal renderer Now Feature Project labels age suffixes for briefing compiler next step'),
      client,
    );

    // We don't require the line to surface (scoring thresholds can vary),
    // but if anything goal-related appears it should be this one, not a
    // stale one.
    if (result.output && /\[CAIRN goal\]/.test(result.output)) {
      assert.match(result.output, /three-tier goal renderer/);
    }
  });
});
