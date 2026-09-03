/**
 * Integration tests for the Stop handler's three-layer capture pipeline:
 *   Layer 1a: sigils      -> authoritative, skips remaining layers
 *   Layer 1b: prose regex  -> safety net for short unformatted turns
 *   Layer 1c: LLM reflect  -> extracts decisions via sampling when markers
 *                             present AND no sigils AND no prose hit
 *
 * Verifies the layer precedence rules, confidence values, and the
 * tier-3 nudge flag on the session tracker when reflection is
 * unavailable or returns empty.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { unlinkSync, existsSync } from 'node:fs';
import type Database from 'better-sqlite3';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { openDatabase } from '../src/db/connection.js';
import { MemoryRepository } from '../src/db/memory-repository.js';
import { PlanRepository } from '../src/db/plan-repository.js';
import { ReminderRepository } from '../src/db/reminder-repository.js';
import { ContextRepository } from '../src/db/context-repository.js';
import { InvestigationRepository } from '../src/db/investigation-repository.js';
import { handleStop } from '../src/hooks/handlers/stop-handler.js';
import { loadTracker, getTrackerPath } from '../src/hooks/shared/edit-tracker.js';
import type { CachedHookContext } from '../src/hooks/shared/db-client.js';
import type { StopInput } from '../src/hooks/shared/hook-io.js';

let db: Database.Database;
let client: CachedHookContext;
const TEST_SESSION = 'test-stop-reflection-session';
const TEST_CWD = '/tmp/cairn-stop-reflection-test';

function makeClient(innerServer?: Server): CachedHookContext {
  return {
    db,
    memoryRepo: new MemoryRepository(db),
    planRepo: new PlanRepository(db),
    reminderRepo: new ReminderRepository(db),
    contextRepo: new ContextRepository(db),
    investigationRepo: new InvestigationRepository(db),
    close: () => {},
    innerServer,
  };
}

function mockInnerServer(opts: {
  samplingCapable: boolean;
  responseText?: string;
}): Server {
  return {
    getClientCapabilities: () => opts.samplingCapable ? { sampling: {} } : {},
    createMessage: async () => ({
      content: [{ type: 'text', text: opts.responseText ?? '{"decisions":[]}' }],
    }),
  } as unknown as Server;
}

function makeInput(message: string): StopInput {
  return {
    session_id: TEST_SESSION,
    transcript_path: '/tmp/transcript.jsonl',
    cwd: TEST_CWD,
    stop_hook_active: true,
    last_assistant_message: message,
  };
}

function cleanupTracker() {
  const path = getTrackerPath(TEST_SESSION);
  if (existsSync(path)) {
    try { unlinkSync(path); } catch { /* ignore */ }
  }
}

beforeEach(() => {
  db = openDatabase({ dbPath: ':memory:' });
  client = makeClient();
  cleanupTracker();
});

afterEach(() => {
  db.close();
  cleanupTracker();
});

describe('Stop handler — layer precedence', () => {
  it('runs shadow evaluation first and isolates its failure from decision mining', async () => {
    const message = "I'll use parameterized queries because they prevent injection and remain portable.";
    let received: Record<string, unknown> = {};
    const result = await handleStop(makeInput(message), client, {
      evaluateShadow: async (_db, input) => {
        received = input as unknown as Record<string, unknown>;
        throw new Error('injected evaluator failure');
      },
    });
    assert.ok(result.action === 'decision-mined' || result.action === 'decision-deduped');
    assert.equal(received.stop_hook_active, true);
    assert.equal(Object.hasOwn(received, 'last_assistant_message'), false);
  });

  it('evaluates even when the assistant message is too short to mine', async () => {
    let calls = 0;
    const result = await handleStop(makeInput('Too short.'), client, {
      evaluateShadow: async () => { calls += 1; },
    });
    assert.equal(result.action, 'no-decision');
    assert.equal(calls, 1);
  });

  it('Layer 1a (sigils) wins over 1b and 1c', async () => {
    // Turn has sigils AND prose-extractable content AND markers — sigils
    // must take precedence and the other layers must not fire.
    const server = mockInnerServer({
      samplingCapable: true,
      responseText: '{"decisions":[{"chose":"should not be stored","why":"X"}]}',
    });
    client = makeClient(server);

    const message = "I'll use PostgreSQL because it supports JSON. [dec: chose sigil path because it is explicit]";
    const result = await handleStop(makeInput(message), client);

    assert.equal(result.action, 'sigil-mined');
    assert.equal(result.sigilCount, 1);
    assert.equal(result.reflectionCount, undefined, 'reflection must not fire when sigils present');

    // Verify only the sigil was stored, not the reflection mock response
    const decisions = client.memoryRepo.findByFilter({ kind: 'decision' }, 10);
    assert.ok(decisions.some(d => d.content.includes('sigil path')), 'sigil stored');
    assert.ok(!decisions.some(d => d.content.includes('should not be stored')), 'reflection did not fire');
  });

  it('Layer 1b (prose regex) fires when no sigils, skips 1c', async () => {
    const server = mockInnerServer({
      samplingCapable: true,
      responseText: '{"decisions":[{"chose":"reflection","why":"should not fire"}]}',
    });
    client = makeClient(server);

    // Short unformatted text the legacy extractor can actually parse
    const message = "I'll use parameterized queries because they prevent SQL injection and are the standard approach.";
    const result = await handleStop(makeInput(message), client);

    assert.ok(result.action === 'decision-mined' || result.action === 'decision-deduped');
    assert.equal(result.reflectionCount, undefined, 'reflection must not fire when prose extractor hits');

    const decisions = client.memoryRepo.findByFilter({ kind: 'decision' }, 10);
    assert.ok(decisions.some(d => d.content.includes('parameterized')), 'prose decision stored');
    assert.ok(!decisions.some(d => d.content.includes('reflection')), 'reflection did not fire');
  });

  it('Layer 1c fires when no sigils, no prose hit, markers present, sampling available', async () => {
    const server = mockInnerServer({
      samplingCapable: true,
      responseText: '{"decisions":[{"chose":"Socratic reflection path","why":"regex cannot parse markdown-heavy responses"}]}',
    });
    client = makeClient(server);

    // Markdown-heavy turn with multiple decision markers — legacy extractor
    // will reject on length/bold-marker gates, opening the door for Layer 1c.
    const message = [
      '## Analysis',
      '',
      'After weighing the tradeoffs, **my recommendation** is the lazy extraction path ' +
      'instead of the persistent graph. **The cost is** minimal and **the payoff** is ' +
      'reliable capture across markdown-heavy assistant output. I would push back on ' +
      'building a full graph because the maintenance tax dominates the benefit at our scale.',
    ].join('\n');

    const result = await handleStop(makeInput(message), client);

    assert.equal(result.action, 'reflection-mined');
    assert.equal(result.reflectionCount, 1);

    const decisions = client.memoryRepo.findByFilter({ kind: 'decision' }, 10);
    assert.ok(decisions.some(d => d.content.includes('Socratic reflection path')));
  });

  it('Layer 1c sets nudge flag when reflection returns empty', async () => {
    const server = mockInnerServer({
      samplingCapable: true,
      responseText: '{"decisions":[]}',
    });
    client = makeClient(server);

    const message = [
      '## Status',
      '',
      'After weighing the tradeoffs, **my recommendation** would be to push back on ' +
      'building a full graph. The approach is to layer a cheap detector on top of ' +
      'the existing Stop hook instead. The cost is minimal and the payoff is reliable.',
    ].join('\n');

    const result = await handleStop(makeInput(message), client);

    assert.equal(result.action, 'reflection-empty');
    assert.ok((result.pendingNudge ?? 0) >= 2, `expected pendingNudge >= 2, got ${result.pendingNudge}`);

    // Verify the tracker flag was persisted for the next UserPromptSubmit
    const tracker = loadTracker(TEST_SESSION);
    assert.ok(tracker.pendingDecisionNudge >= 2, 'nudge flag persisted on tracker');
  });

  it('Layer 1c sets nudge flag when sampling unavailable (no innerServer)', async () => {
    // No innerServer at all — simulates hooks running standalone, not via socket
    client = makeClient(undefined);

    const message = [
      'After weighing the tradeoffs, **my recommendation** is the lazy path. ',
      '**The cost is** minimal. **The payoff** is reliable capture. ',
      'I would push back on the heavier option since the maintenance tax dominates.',
    ].join('');

    const result = await handleStop(makeInput(message), client);

    assert.equal(result.action, 'reflection-empty');
    assert.ok((result.pendingNudge ?? 0) >= 2);

    const tracker = loadTracker(TEST_SESSION);
    assert.ok(tracker.pendingDecisionNudge >= 2);
  });

  it('Layer 1c does NOT fire when markers below threshold', async () => {
    const server = mockInnerServer({ samplingCapable: true });
    client = makeClient(server);

    // Single marker — below REFLECTION.MIN_MARKERS (2). Reflection skipped.
    const message = '## Header\n\nJust a status update with one **recommendation** mentioned offhand, no real decision.';
    const result = await handleStop(makeInput(message), client);

    assert.equal(result.action, 'no-decision');
    assert.equal(result.pendingNudge, undefined);

    const tracker = loadTracker(TEST_SESSION);
    assert.equal(tracker.pendingDecisionNudge, 0);
  });

  it('returns no-decision for messages under 50 chars', async () => {
    const result = await handleStop(makeInput('Too short.'), client);
    assert.equal(result.action, 'no-decision');
  });

  it('Layer 1a stores sigils at LEARNED confidence (0.65), not AUTO_DETECTED (0.55)', async () => {
    const message = 'Some analysis. [dec: chose the explicit authorship path because regex extraction fails on markdown]';
    await handleStop(makeInput(message), client);

    const decisions = client.memoryRepo.findByFilter({ kind: 'decision' }, 10);
    const sigilMem = decisions.find(d => d.content.includes('explicit authorship'));
    assert.ok(sigilMem, 'sigil stored');
    assert.ok(sigilMem!.confidence >= 0.6, `expected confidence >= 0.6, got ${sigilMem!.confidence}`);
  });
});
