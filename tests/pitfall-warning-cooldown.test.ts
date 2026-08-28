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
import type { CachedHookContext } from '../src/hooks/shared/db-client.js';
import { handlePitfallCheck } from '../src/hooks/handlers/pitfall-handler.js';
import type { PreToolUseInput } from '../src/hooks/shared/hook-io.js';
import { PROACTIVE } from '../src/constants/index.js';

let db: Database.Database;
let cache: SessionCache;
let client: CachedHookContext;

beforeEach(() => {
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
});

function editInput(sessionId: string, filePath: string): PreToolUseInput {
  return {
    session_id: sessionId,
    transcript_path: '/tmp/x.jsonl',
    cwd: '/tmp',
    tool_name: 'Edit',
    tool_input: {
      file_path: filePath,
      old_string: 'foo',
      new_string: 'bar',
    },
  } as unknown as PreToolUseInput;
}

describe('A3 rapid-re-edit cooldown', () => {
  it('fires on the first rapid re-edit', () => {
    const input = editInput('sess-a3-1', '/tmp/hello.ts');
    handlePitfallCheck(input, client); // priming call (no lastEditPath match)

    // Simulate success-tracker setting lastEdit state
    const tracker = cache.getTracker('sess-a3-1')!;
    tracker.lastEditPath = '/tmp/hello.ts';
    tracker.lastEditTime = Date.now() - 200; // within RAPID_REEDIT_MS
    cache.setTracker('sess-a3-1', tracker);

    const r = handlePitfallCheck(input, client);
    assert.notEqual(r.output, null, 'A3 should fire on first rapid re-edit');
    assert.ok(String(r.output).includes('re-editing this file quickly'));
  });

  it('does NOT fire a second time within WARNING_COOLDOWN_MS', () => {
    const input = editInput('sess-a3-2', '/tmp/hello.ts');
    handlePitfallCheck(input, client);

    const tracker = cache.getTracker('sess-a3-2')!;
    tracker.lastEditPath = '/tmp/hello.ts';
    tracker.lastEditTime = Date.now() - 200;
    cache.setTracker('sess-a3-2', tracker);

    const r1 = handlePitfallCheck(input, client);
    assert.ok(String(r1.output ?? '').includes('re-editing this file quickly'), 'first fire expected');

    // Refresh lastEditTime so the RAPID_REEDIT_MS condition is still met,
    // and force the skip-gate cache to miss by mutating lastEditTime again.
    const t2 = cache.getTracker('sess-a3-2')!;
    t2.lastEditPath = '/tmp/hello.ts';
    t2.lastEditTime = Date.now() - 50;
    cache.setTracker('sess-a3-2', t2);

    const r2 = handlePitfallCheck(input, client);
    const text = String(r2.output ?? '');
    assert.ok(
      !text.includes('re-editing this file quickly'),
      'second fire within cooldown window should be suppressed',
    );
  });

  it('fires again after WARNING_COOLDOWN_MS has elapsed', () => {
    const input = editInput('sess-a3-3', '/tmp/hello.ts');
    handlePitfallCheck(input, client);

    const tracker = cache.getTracker('sess-a3-3')!;
    tracker.lastEditPath = '/tmp/hello.ts';
    tracker.lastEditTime = Date.now() - 200;
    cache.setTracker('sess-a3-3', tracker);

    handlePitfallCheck(input, client); // first fire

    // Manually backdate the cooldown entry past the window to simulate elapsed time.
    const t2 = cache.getTracker('sess-a3-3')!;
    t2.recentWarningFired = t2.recentWarningFired ?? {};
    t2.recentWarningFired['A3:/tmp/hello.ts'] = Date.now() - PROACTIVE.WARNING_COOLDOWN_MS - 1000;
    t2.lastEditPath = '/tmp/hello.ts';
    t2.lastEditTime = Date.now() - 50;
    cache.setTracker('sess-a3-3', t2);

    const r2 = handlePitfallCheck(input, client);
    assert.ok(
      String(r2.output ?? '').includes('re-editing this file quickly'),
      'A3 should re-fire after cooldown elapses',
    );
  });

  it('cooldown is per-file — different file re-edits are not suppressed', () => {
    const inputA = editInput('sess-a3-4', '/tmp/a.ts');
    const inputB = editInput('sess-a3-4', '/tmp/b.ts');
    handlePitfallCheck(inputA, client);

    let tracker = cache.getTracker('sess-a3-4')!;
    tracker.lastEditPath = '/tmp/a.ts';
    tracker.lastEditTime = Date.now() - 200;
    cache.setTracker('sess-a3-4', tracker);

    const rA = handlePitfallCheck(inputA, client);
    assert.ok(String(rA.output ?? '').includes('re-editing this file quickly'), 'file A fires');

    tracker = cache.getTracker('sess-a3-4')!;
    tracker.lastEditPath = '/tmp/b.ts';
    tracker.lastEditTime = Date.now() - 200;
    cache.setTracker('sess-a3-4', tracker);

    const rB = handlePitfallCheck(inputB, client);
    assert.ok(
      String(rB.output ?? '').includes('re-editing this file quickly'),
      'file B fires independently — cooldown is per-file',
    );
  });
});

describe('A1 recent-failure cooldown', () => {
  it('fires on the first recent failure then suppresses within cooldown', () => {
    const input = editInput('sess-a1-1', '/tmp/broken.ts');
    handlePitfallCheck(input, client); // priming

    const tracker = cache.getTracker('sess-a1-1')!;
    tracker.toolChain = [{
      tool: 'Bash',
      file: '/tmp/broken.ts',
      success: false,
      output: 'TypeError: foo',
      timestamp: Date.now() - 1000,
    }];
    cache.setTracker('sess-a1-1', tracker);

    const r1 = handlePitfallCheck(input, client);
    assert.ok(String(r1.output ?? '').includes('error(s) this session'), 'A1 fires');

    // Force a skip-gate miss with a new lastEditTime but keep the tracker's
    // cooldown entry intact.
    const t2 = cache.getTracker('sess-a1-1')!;
    t2.lastEditTime = Date.now();
    cache.setTracker('sess-a1-1', t2);

    const r2 = handlePitfallCheck(input, client);
    assert.ok(
      !String(r2.output ?? '').includes('error(s) this session'),
      'A1 suppressed within cooldown',
    );
  });
});

describe('cooldown map pruning', () => {
  it('prunes entries older than 2× WARNING_COOLDOWN_MS on every call', () => {
    const input = editInput('sess-prune', '/tmp/hello.ts');
    handlePitfallCheck(input, client);

    const tracker = cache.getTracker('sess-prune')!;
    tracker.recentWarningFired = {
      'A3:/tmp/stale.ts': Date.now() - PROACTIVE.WARNING_COOLDOWN_MS * 3,
      'A1:/tmp/current.ts': Date.now() - 10_000,
    };
    cache.setTracker('sess-prune', tracker);

    // Force a cache miss so the handler runs and prunes.
    const t2 = cache.getTracker('sess-prune')!;
    t2.lastEditTime = Date.now();
    cache.setTracker('sess-prune', t2);

    handlePitfallCheck(input, client);

    const after = cache.getTracker('sess-prune')!;
    assert.equal(
      after.recentWarningFired['A3:/tmp/stale.ts'],
      undefined,
      'stale entry should be pruned',
    );
    assert.ok(
      after.recentWarningFired['A1:/tmp/current.ts'] !== undefined,
      'fresh entry should be retained',
    );
  });
});
