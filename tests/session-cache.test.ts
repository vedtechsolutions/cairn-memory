import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SessionCache } from '../src/hooks/shared/session-cache.js';

describe('SessionCache skip-gate', () => {
  it('memoryVersion starts at 0 and bump increments it', () => {
    const cache = new SessionCache();
    assert.equal(cache.getMemoryVersion(), 0);
    cache.bumpMemoryVersion();
    assert.equal(cache.getMemoryVersion(), 1);
    cache.bumpMemoryVersion();
    assert.equal(cache.getMemoryVersion(), 2);
  });

  it('getSkipGate returns null for an unknown key', () => {
    const cache = new SessionCache();
    assert.equal(cache.getSkipGate('nope'), null);
  });

  it('setSkipGate/getSkipGate roundtrip on same version', () => {
    const cache = new SessionCache();
    const key = SessionCache.skipGateKey({
      hookName: 'pitfall-check',
      toolName: 'Edit',
      filePath: '/tmp/foo.ts',
      contextMode: 'normal',
      sessionStateHash: 'abc',
    });
    cache.setSkipGate(key, 'cached-output');
    const entry = cache.getSkipGate(key);
    assert.ok(entry);
    assert.equal(entry.output, 'cached-output');
    assert.equal(entry.memoryVersion, 0);
  });

  it('bumpMemoryVersion invalidates all existing skip-gate entries', () => {
    const cache = new SessionCache();
    const key = SessionCache.skipGateKey({
      hookName: 'pitfall-check',
      toolName: 'Edit',
      filePath: '/tmp/foo.ts',
      contextMode: 'normal',
      sessionStateHash: 'abc',
    });
    cache.setSkipGate(key, 'cached-output');
    assert.ok(cache.getSkipGate(key));
    cache.bumpMemoryVersion();
    assert.equal(cache.getSkipGate(key), null, 'cache must miss after version bump');
  });

  it('setSkipGate after bump captures the new version', () => {
    const cache = new SessionCache();
    cache.bumpMemoryVersion();
    cache.bumpMemoryVersion();
    const key = SessionCache.skipGateKey({
      hookName: 'prompt-check',
      contextMode: 'normal',
      sessionStateHash: 'x',
    });
    cache.setSkipGate(key, null);
    const entry = cache.getSkipGate(key);
    assert.ok(entry);
    assert.equal(entry.memoryVersion, 2);
    assert.equal(entry.output, null);
  });

  it('skipGateKey produces different keys for different tool names', () => {
    const base = {
      hookName: 'pitfall-check',
      filePath: '/tmp/foo.ts',
      contextMode: 'normal',
      sessionStateHash: 'abc',
    };
    const k1 = SessionCache.skipGateKey({ ...base, toolName: 'Edit' });
    const k2 = SessionCache.skipGateKey({ ...base, toolName: 'Write' });
    assert.notEqual(k1, k2);
  });

  it('skipGateKey produces different keys for different file paths', () => {
    const base = {
      hookName: 'pitfall-check',
      toolName: 'Edit',
      contextMode: 'normal',
      sessionStateHash: 'abc',
    };
    const k1 = SessionCache.skipGateKey({ ...base, filePath: '/tmp/foo.ts' });
    const k2 = SessionCache.skipGateKey({ ...base, filePath: '/tmp/bar.ts' });
    assert.notEqual(k1, k2);
  });

  it('skipGateKey produces different keys for different session state hashes', () => {
    const base = {
      hookName: 'pitfall-check',
      toolName: 'Edit',
      filePath: '/tmp/foo.ts',
      contextMode: 'normal',
    };
    const k1 = SessionCache.skipGateKey({ ...base, sessionStateHash: 'state-1' });
    const k2 = SessionCache.skipGateKey({ ...base, sessionStateHash: 'state-2' });
    assert.notEqual(k1, k2);
  });

  it('setSkipGate enforces MAX_SKIP_GATE_ENTRIES via FIFO eviction', () => {
    const cache = new SessionCache();
    // Write 250 distinct entries — cap is 200
    for (let i = 0; i < 250; i++) {
      const key = SessionCache.skipGateKey({
        hookName: 'pitfall-check',
        toolName: 'Edit',
        filePath: `/tmp/file-${i}.ts`,
        contextMode: 'normal',
        sessionStateHash: 'abc',
      });
      cache.setSkipGate(key, `output-${i}`);
    }
    // First entry should have been evicted, last should still be present
    const firstKey = SessionCache.skipGateKey({
      hookName: 'pitfall-check',
      toolName: 'Edit',
      filePath: '/tmp/file-0.ts',
      contextMode: 'normal',
      sessionStateHash: 'abc',
    });
    const lastKey = SessionCache.skipGateKey({
      hookName: 'pitfall-check',
      toolName: 'Edit',
      filePath: '/tmp/file-249.ts',
      contextMode: 'normal',
      sessionStateHash: 'abc',
    });
    assert.equal(cache.getSkipGate(firstKey), null, 'oldest entry should be evicted');
    assert.ok(cache.getSkipGate(lastKey), 'newest entry should still be present');
  });
});
