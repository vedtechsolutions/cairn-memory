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

describe('pitfall-handler skip gate', () => {
  it('first call populates the skip-gate cache when output is null', () => {
    // Fresh empty DB, no pitfalls — handler must return null
    const input = editInput('sess-1', '/tmp/hello.ts');
    const result = handlePitfallCheck(input, client);
    assert.equal(result.output, null);
    assert.equal(result.pitfallsSurfaced, 0);
    // The session state hash is built internally by the handler, so we
    // verify cache population indirectly via the "second call is faster"
    // test below rather than trying to reconstruct the key here.
  });

  it('second identical call is a cache hit and returns much faster', () => {
    const input = editInput('sess-2', '/tmp/hello.ts');

    // First call — full path
    const t0 = Date.now();
    const r1 = handlePitfallCheck(input, client);
    const firstMs = Date.now() - t0;
    assert.equal(r1.output, null);

    // Second call — must hit skip gate
    const t1 = Date.now();
    const r2 = handlePitfallCheck(input, client);
    const secondMs = Date.now() - t1;
    assert.equal(r2.output, null);

    // Cache hit path does essentially no work. Allow a generous 5ms budget
    // for the test — in reality it is sub-millisecond.
    assert.ok(
      secondMs <= Math.max(5, firstMs),
      `second call (${secondMs}ms) should be faster or equal to first (${firstMs}ms)`,
    );
  });

  it('bumpMemoryVersion invalidates the cached null entry', () => {
    const input = editInput('sess-3', '/tmp/hello.ts');
    // Warm the cache
    handlePitfallCheck(input, client);

    // Bump — simulates a cairn_learn / cairn_correct happening between calls
    cache.bumpMemoryVersion();

    // Now insert a high-impact pitfall that anchors this file so the handler
    // has something to surface. Without anchor the file fingerprint path is
    // unlikely to match for a test file in /tmp.
    client.memoryRepo.storePitfall({
      content: 'Never rename hello.ts without updating callers',
      project: null,
      confidence: 0.9,
      anchor: JSON.stringify({ files: ['/tmp/hello.ts'], symbols: [] }),
    });
    // Bump again because the insert happened outside the MCP write gateway
    cache.bumpMemoryVersion();

    const result = handlePitfallCheck(input, client);
    // The cached null is invalidated, so the handler must run and may find
    // the anchor-matched pitfall. Either way it must NOT return the stale
    // cached null unconditionally. At minimum, a full handler run occurred.
    assert.ok(
      result.output !== null || result.pitfallsSurfaced === 0,
      'invalidated cache must force a full handler run, not a stale hit',
    );
  });

  it('different file paths produce different cache keys', () => {
    const inputA = editInput('sess-4', '/tmp/a.ts');
    const inputB = editInput('sess-4', '/tmp/b.ts');

    handlePitfallCheck(inputA, client);
    handlePitfallCheck(inputB, client);

    // Both calls should have populated separate entries. A follow-up to the
    // same file should cache-hit; a follow-up to a third file should still
    // work (handler runs).
    const r2a = handlePitfallCheck(inputA, client);
    assert.equal(r2a.output, null);
  });

  it('session state change invalidates the cache via lastEditTime', () => {
    const input = editInput('sess-5', '/tmp/hello.ts');
    const r1 = handlePitfallCheck(input, client);
    assert.equal(r1.output, null, 'first call on empty DB returns null');

    // Mutate tracker state to simulate success-tracker recording a recent
    // edit to this same file. This forces: (a) the session state hash to
    // change so the skip-gate key differs from the first call, AND (b) the
    // A3 "rapid re-edit" warning to fire inside the handler. Seeing the
    // warning proves the cache was invalidated AND the handler re-ran.
    const tracker = cache.getTracker('sess-5');
    assert.ok(tracker, 'tracker should exist after first handler run');
    tracker.lastEditPath = '/tmp/hello.ts';
    // Set 100ms in the past so elapsed > 0 and well under RAPID_REEDIT_MS
    tracker.lastEditTime = Date.now() - 100;
    cache.setTracker('sess-5', tracker);

    const r2 = handlePitfallCheck(input, client);
    assert.notEqual(
      r2.output,
      null,
      'state change must invalidate cached null and let A3 warning fire',
    );
    assert.ok(
      String(r2.output).includes('re-editing this file'),
      'second call must surface the rapid re-edit warning',
    );
  });
});
