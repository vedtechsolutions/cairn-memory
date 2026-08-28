/**
 * GAP B — handlePostCompact must mutate the in-memory cached tracker when
 * a CachedHookContext is provided, so that concurrent mid-session hook
 * mutations (injectedMemoryIds, surfacedPitfalls) are not clobbered by
 * out-of-band file writes, and subsequent socket-routed hooks see
 * lastCompactAt correctly.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { handlePostCompact } from '../src/hooks/handlers/postcompact-handler.js';
import { SessionCache } from '../src/hooks/shared/session-cache.js';
import type { CachedHookContext } from '../src/hooks/shared/db-client.js';
import type { EditTracker } from '../src/hooks/shared/edit-tracker.js';

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

function makeClient(cache: SessionCache): CachedHookContext {
  // Minimal CachedHookContext stub — handler only reads client.cache here.
  return {
    cache,
  } as unknown as CachedHookContext;
}

describe('GAP B — postcompact handler cache coherence', () => {
  it('mutates the in-memory tracker instead of loading/saving via file', () => {
    const cache = new SessionCache();
    const sessionId = 'session-test-1';

    // Seed the cache with a tracker that has existing injectedMemoryIds and
    // a surfacedPitfalls entry — simulating prior mid-session state.
    const prior = freshTracker();
    prior.sessionId = sessionId;
    prior.injectedMemoryIds = ['mem:a', 'mem:b'];
    prior.surfacedPitfalls = { 'src/foo.ts': ['pit:x'] };
    cache.setTracker(sessionId, prior);

    handlePostCompact(
      { session_id: sessionId, transcript_path: '/tmp/t.jsonl', cwd: '/tmp', trigger: 'auto', tokens_saved: 1234 },
      makeClient(cache),
    );

    const after = cache.getTracker(sessionId);
    assert.ok(after, 'tracker still in cache');
    assert.ok(after!.lastCompactAt > 0, 'lastCompactAt was set');
    assert.equal(after!.lastCompactSessionId, sessionId);
    assert.equal(after!.lastCompactTokensSaved, 1234);
    // Prior state preserved — no clobber
    assert.deepEqual(after!.injectedMemoryIds, ['mem:a', 'mem:b']);
    assert.deepEqual(after!.surfacedPitfalls, { 'src/foo.ts': ['pit:x'] });
  });

  it('returns tokensSaved regardless of client path', () => {
    const cache = new SessionCache();
    const result = handlePostCompact(
      { session_id: 's2', transcript_path: '/tmp/t', cwd: '/tmp', trigger: 'auto', tokens_saved: 42 },
      makeClient(cache),
    );
    assert.equal(result.tokensSaved, 42);
  });
});
