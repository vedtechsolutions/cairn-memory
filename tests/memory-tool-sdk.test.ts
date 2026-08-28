/**
 * SDK contract layers (W4 v3.1 §9/§10) against the exact-pinned
 * @anthropic-ai/sdk: (a) every command routed through betaMemoryTool's
 * run(), success and error, with thrown messages carrying NO `Error: `
 * prefix; (b) the PUBLIC runner with a fake client — the only path that
 * proves the SDK-visible is_error tool_result: the RUNNER adds the single
 * `Error: ` prefix, never our handlers.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import Anthropic from '@anthropic-ai/sdk';
import { betaMemoryTool } from '@anthropic-ai/sdk/helpers/beta/memory';
import type Database from 'better-sqlite3';
import { openDatabase } from '../src/db/connection.js';
import { PlanRepository } from '../src/db/plan-repository.js';
import { createMemoryToolHandlers } from '../src/memory-tool/sdk-adapter.js';
import { SDK_MEMORY_TOOL_CANARY } from '../src/memory-tool/sdk-canary.js';

let db: Database.Database;
let tool: ReturnType<typeof betaMemoryTool>;

beforeEach(() => {
  db = openDatabase({ dbPath: ':memory:' });
  tool = betaMemoryTool(createMemoryToolHandlers({
    db, planRepo: new PlanRepository(db), log: () => {},
  }));
});
afterEach(() => { db.close(); });

const FACTS = '/memories/global/facts.md';
// async so the helper's SYNCHRONOUS run()/throw surfaces as a rejection.
const run = async (input: Record<string, unknown>): Promise<unknown> =>
  tool.run(input as never, {} as never);

describe('layer (a): every command through betaMemoryTool.run()', () => {
  it('compile canary is importable and true', () => {
    assert.equal(SDK_MEMORY_TOOL_CANARY, true);
  });

  it('create → view → str_replace → insert → delete round-trip', async () => {
    assert.equal(
      await run({ command: 'create', path: FACTS, file_text: '- content: "sdk layer created this fact"' }),
      `File created successfully at: ${FACTS}`,
    );
    const view = await run({ command: 'view', path: FACTS }) as string;
    assert.match(view, /^Here's the content of \/memories\/global\/facts\.md with line numbers:/);
    const block = view.split('\n')[1].replace(/^ *\d+\t/, '');
    assert.match(block, /^- \[fac:[0-9a-f]{8}@1\] content: "sdk layer created this fact"$/);

    const edited = await run({
      command: 'str_replace', path: FACTS, old_str: block,
      new_str: block.replace('@1] content: "sdk layer created this fact"', '@1] content: "sdk layer edited this fact"'),
    }) as string;
    assert.match(edited, /^The memory file has been edited\./);

    assert.equal(
      await run({ command: 'insert', path: FACTS, insert_line: 0, insert_text: '- content: "sdk layer inserted another fact"' }),
      `The file ${FACTS} has been edited.`,
    );
    assert.match(await run({ command: 'delete', path: FACTS }) as string, /^Successfully deleted/);
  });

  it('rename routes through the handler', async () => {
    db.prepare("INSERT INTO memory_files (path, content, created_at, updated_at) VALUES ('/memories/notes/a.md','x',datetime('now'),datetime('now'))").run();
    assert.equal(
      await run({ command: 'rename', old_path: '/memories/notes/a.md', new_path: '/memories/notes/b.md' }),
      'Successfully renamed /memories/notes/a.md to /memories/notes/b.md',
    );
  });

  it('errors from ALL SIX commands are thrown raw — no Error: prefix for the runner to double', async () => {
    for (const input of [
      { command: 'view', path: FACTS },
      { command: 'view', path: '/memories/notes/x.md', view_range: [1] },
      { command: 'create', path: FACTS, file_text: '- [fac:0123abcd@1] content: "tokened create"' },
      { command: 'create', path: '/memories', file_text: 'x' },
      { command: 'str_replace', path: FACTS, old_str: 'not a block', new_str: '' },
      { command: 'insert', path: FACTS, insert_line: 0, insert_text: '- [fac:0123abcd@1] content: "tokened insert"' },
      { command: 'delete', path: '/memories' },
      { command: 'delete', path: '/memories/notes/missing.md' },
      { command: 'rename', old_path: '/memories/global/facts.md', new_path: '/memories/notes/free.md' },
      { command: 'rename', old_path: '/memories', new_path: '/memories/notes/x.md' },
    ]) {
      await assert.rejects(run(input), (err: Error) => {
        assert.doesNotMatch(err.message, /^Error: /);
        return true;
      });
    }
  });

  it('view_range pages through the SDK serve one frozen rendering across re-ranking', async () => {
    for (let i = 0; i < 4; i++) {
      db.prepare(`
        INSERT INTO memories (id, content, kind, project, tags, confidence, source, created_at, recall_count, invalidated, surface_count, impact_count)
        VALUES (?, ?, 'fact', NULL, '[]', ?, 'learned', '2026-07-01T00:00:00.000Z', 0, 0, 0, 0)
      `).run(`0000000${i}-0000-4000-8000-000000000000`, `sdk paging record number ${i}`, 0.9 - i * 0.1);
    }
    const strip = (v: string): string[] => v.split('\n').slice(1).map(l => l.replace(/^ *\d+\t/, ''));
    const frozen = strip(await run({ command: 'view', path: FACTS }) as string);

    const pageOne = strip(await run({ command: 'view', path: FACTS, view_range: [1, 2] }) as string);
    // Out-of-band re-rank between SDK pages (decay-style write).
    db.prepare("UPDATE memories SET confidence = 0.99 WHERE id = '00000003-0000-4000-8000-000000000000'").run();
    const pageTwo = strip(await run({ command: 'view', path: FACTS, view_range: [3, -1] }) as string);

    assert.deepEqual([...pageOne, ...pageTwo], frozen, 'SDK pages must serve one frozen rendering');
  });

  it('view_range shape errors fire before path handling', async () => {
    await assert.rejects(
      run({ command: 'view', path: FACTS, view_range: [1, 2, 3] }),
      /Invalid `view_range` parameter: \[1,2,3\]\. It should be an array of two integers\./,
    );
  });
});

describe('layer (b): SDK-visible tool_result via the PUBLIC runner', () => {
  it('golden: success block verbatim; thrown error becomes is_error with ONE runner-added prefix', async () => {
    db.prepare(`
      INSERT INTO memories (id, content, kind, project, tags, confidence, source, created_at, recall_count, invalidated, surface_count, impact_count)
      VALUES ('feedc0de-0000-4000-8000-000000000000', 'runner golden subject fact', 'fact', NULL, '[]', 0.6, 'learned', '2026-07-01T00:00:00.000Z', 0, 0, 0, 0)
    `).run();

    const client = new Anthropic({
      apiKey: 'test-key-never-used',
      fetch: (async () => { throw new Error('network disabled in tests'); }) as never,
    });
    const runner = client.beta.messages.toolRunner({
      model: 'claude-sonnet-4-5',
      max_tokens: 256,
      messages: [
        { role: 'user', content: 'update memory' },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'tu_ok', name: 'memory', input: { command: 'view', path: FACTS } },
            {
              type: 'tool_use', id: 'tu_err', name: 'memory',
              input: { command: 'str_replace', path: FACTS, old_str: '- [fac:feedc0de@9] content: "runner golden subject fact"', new_str: '' },
            },
          ],
        },
      ],
      tools: [tool],
    });

    const response = await runner.generateToolResponse();
    assert.ok(response, 'runner produced a tool-response message');
    assert.equal(response.role, 'user');
    const [ok, err] = response.content as Array<{
      type: string; tool_use_id: string; content: string; is_error?: boolean;
    }>;

    assert.equal(ok.type, 'tool_result');
    assert.equal(ok.tool_use_id, 'tu_ok');
    assert.notEqual(ok.is_error, true);
    assert.match(ok.content, /^Here's the content of \/memories\/global\/facts\.md with line numbers:/);
    assert.match(ok.content, /runner golden subject fact/);

    assert.equal(err.type, 'tool_result');
    assert.equal(err.tool_use_id, 'tu_err');
    assert.equal(err.is_error, true);
    // The single Error: prefix comes from the RUNNER; our message follows verbatim.
    assert.equal(
      err.content,
      'Error: stale record [fac:feedc0de@9] — its current revision is 1. View /memories/global/facts.md again before editing.',
    );
    assert.doesNotMatch(err.content, /^Error: Error:/);
  });
});
