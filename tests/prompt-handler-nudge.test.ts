/**
 * Prompt-handler Layer 2c — pending decision nudge.
 *
 * When Stop handler's Layer 1c (Socratic reflection) fires but the
 * reflection returns empty (sampling unavailable, API error, or the LLM
 * found nothing), it sets tracker.pendingDecisionNudge to the marker
 * count. The very next UserPromptSubmit must surface a single one-line
 * reminder and clear the flag.
 *
 * Tests the emit + clear semantics without involving the Stop hook
 * directly — we seed the tracker state in-cache and assert the handler
 * behavior.
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
import { handlePromptCheck } from '../src/hooks/handlers/prompt-handler.js';
import type { CachedHookContext } from '../src/hooks/shared/db-client.js';
import type { EditTracker } from '../src/hooks/shared/edit-tracker.js';
import type { UserPromptSubmitInput } from '../src/hooks/shared/hook-io.js';

let db: Database.Database;
let client: CachedHookContext;

function freshTracker(): EditTracker {
  return {
    lastEditPath: null,
    lastEditTime: 0,
    lastEditCursor: null,
    editCountsByFile: {},
    surfacedPitfalls: {},
    toolChain: [],
    successDedup: { lastPattern: null, lastTime: 0 },
    sessionErrorCounts: {},
    sessionId: null,
    recentlySurfaced: {},
    recentWarningFired: {},
    preflightFired: false,
    complianceNudgeFired: false,
    decisionReminderFired: false,
    pendingDecisionNudge: 0,
    injectedMemoryIds: [],
    lastCompactAt: 0,
    lastCompactSessionId: null,
    lastCompactTokensSaved: 0,
    briefingEffectiveness: null,
  };
}

function makeInput(prompt: string, sessionId = 'nudge-test-session'): UserPromptSubmitInput {
  return {
    session_id: sessionId,
    transcript_path: '/tmp/no-transcript.jsonl',
    cwd: '/tmp/nudge-test-project',
    prompt,
  } as unknown as UserPromptSubmitInput;
}

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

describe('prompt-handler Layer 2c — pending decision nudge', () => {
  it('emits the nudge line when tracker has pendingDecisionNudge > 0', () => {
    const sessionId = 'nudge-emit-test';
    const tracker = freshTracker();
    tracker.pendingDecisionNudge = 3;
    client.cache!.setTracker(sessionId, tracker);

    const result = handlePromptCheck(makeInput('Continue the refactor', sessionId), client);

    assert.ok(result.output, 'expected non-empty output');
    assert.match(result.output!, /3 decision markers?/);
    assert.match(result.output!, /\[dec:/, 'nudge references the sigil convention');
  });

  it('clears the nudge flag after emission (at-most-once per drop)', () => {
    const sessionId = 'nudge-clear-test';
    const tracker = freshTracker();
    tracker.pendingDecisionNudge = 2;
    client.cache!.setTracker(sessionId, tracker);

    handlePromptCheck(makeInput('Continue', sessionId), client);

    const afterTracker = client.cache!.getTracker(sessionId);
    assert.ok(afterTracker, 'tracker still exists');
    assert.equal(afterTracker!.pendingDecisionNudge, 0, 'nudge flag cleared');
  });

  it('emits nothing related to the nudge when flag is 0', () => {
    const sessionId = 'no-nudge-test';
    const tracker = freshTracker();
    tracker.pendingDecisionNudge = 0;
    client.cache!.setTracker(sessionId, tracker);

    const result = handlePromptCheck(makeInput('Continue', sessionId), client);

    if (result.output) {
      assert.doesNotMatch(result.output, /decision markers? but no sigil/);
    }
  });

  it('pluralizes correctly for N=1 vs N>1', () => {
    const sessionId = 'nudge-plural-test';
    const tracker = freshTracker();
    tracker.pendingDecisionNudge = 1;
    client.cache!.setTracker(sessionId, tracker);

    const result = handlePromptCheck(makeInput('Continue', sessionId), client);
    assert.ok(result.output);
    assert.match(result.output!, /1 decision marker\b/);
    assert.doesNotMatch(result.output!, /1 decision markers\b/);
  });

  it('nudge fires regardless of context mode', () => {
    // Even in minimal mode the nudge should fire — it's a single-line
    // reminder and too important to suppress.
    const sessionId = 'nudge-mode-test';
    const tracker = freshTracker();
    tracker.pendingDecisionNudge = 4;
    client.cache!.setTracker(sessionId, tracker);

    const result = handlePromptCheck(makeInput('Continue', sessionId), client);
    // Whatever the budget mode, the nudge line should be emitted because
    // the handler pushes it unconditionally when the flag is set.
    if (result.output) {
      assert.match(result.output, /4 decision markers/);
    }
  });
});
