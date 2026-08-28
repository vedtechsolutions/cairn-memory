/**
 * GAP J — plan-bridge-handler must prefer the in-memory cached tracker
 * over the file-loaded tracker when a CachedHookContext is provided.
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
import { handlePlanBridge } from '../src/hooks/handlers/plan-bridge-handler.js';
import type { CachedHookContext } from '../src/hooks/shared/db-client.js';
import type { EditTracker } from '../src/hooks/shared/edit-tracker.js';
import type { PostToolUseInput } from '../src/hooks/shared/hook-io.js';

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

let db: Database.Database;
let client: CachedHookContext;

beforeEach(() => {
  db = openDatabase({ dbPath: ':memory:' });
  client = {
    db,
    memoryRepo: new MemoryRepository(db),
    planRepo: new PlanRepository(db),
    reminderRepo: new ReminderRepository(db),
    contextRepo: new ContextRepository(db),
    investigationRepo: new InvestigationRepository(db),
    cache: new SessionCache(),
    close: () => db.close(),
  };
});

afterEach(() => db.close());

describe('GAP J — plan-bridge-handler reads from cache', () => {
  it('returns no-plan-found when cached tracker has no recent writes and tool_response is empty', () => {
    const tracker = freshTracker();
    tracker.sessionId = 's-plan-bridge';
    // Empty toolChain — no recent writes at all.
    client.cache!.setTracker('s-plan-bridge', tracker);

    const input: PostToolUseInput = {
      session_id: 's-plan-bridge',
      transcript_path: '/tmp/t',
      cwd: '/tmp',
      tool_name: 'ExitPlanMode',
      tool_input: {},
      tool_response: '',
    } as unknown as PostToolUseInput;

    const result = handlePlanBridge(input, client);
    assert.equal(result.action, 'no-plan-found');
    assert.equal(result.output, null);
  });

  it('skips non-ExitPlanMode tools', () => {
    const input: PostToolUseInput = {
      session_id: 's',
      transcript_path: '/tmp/t',
      cwd: '/tmp',
      tool_name: 'Write',
      tool_input: { file_path: '/tmp/x' },
      tool_response: '',
    } as unknown as PostToolUseInput;
    const result = handlePlanBridge(input, client);
    assert.equal(result.action, 'skip');
  });
});
