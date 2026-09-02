/**
 * M1-exit per-path malicious goldens — the HANDLER and MCP surfaces the
 * Codex gate enumerated beyond the briefing tiers: pitfall warnings
 * (PreToolUse), subagent context (SubagentStart), prompt recall
 * (UserPromptSubmit), and MCP cairn_recall / cairn_expand. Each drives
 * the REAL handler/tool plumbing over a hostile team row applied
 * through the real sync-apply path, and each FIRST asserts the row
 * actually rendered — a golden that vacuously passes when nothing
 * surfaces proves nothing.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type Database from 'better-sqlite3';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { openDatabase } from '../src/db/connection.js';
import { MemoryRepository } from '../src/db/memory-repository.js';
import { PlanRepository } from '../src/db/plan-repository.js';
import { ReminderRepository } from '../src/db/reminder-repository.js';
import { ContextRepository } from '../src/db/context-repository.js';
import { InvestigationRepository } from '../src/db/investigation-repository.js';
import { EdgeRepository } from '../src/db/edge-repository.js';
import { SessionCache } from '../src/hooks/shared/session-cache.js';
import type { CachedHookContext } from '../src/hooks/shared/db-client.js';
import { handlePitfallCheck } from '../src/hooks/handlers/pitfall-handler.js';
import { handlePromptCheck } from '../src/hooks/handlers/prompt-handler.js';
import { handleSubagentContext } from '../src/hooks/handlers/subagent-context-handler.js';
import { registerMemoryTools } from '../src/mcp/tools/memory-tools.js';
import { projectId } from '../src/utils/project-id.js';
import type { PreToolUseInput, UserPromptSubmitInput, SubagentStartInput } from '../src/hooks/shared/hook-io.js';

import { applyHostileRow, assertGolden } from './helpers/hostile-row.js';
import { TOOL } from '../src/constants/mcp.js';

const CWD = '/tmp/m1-exit-handler-goldens-cwd';
const PROJECT = projectId(CWD);

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
  cache.destroy();
  try { db.close(); } catch { /* already closed */ }
});

describe('M1-exit: handler malicious goldens', () => {
  it('the PreToolUse pitfall warning renders the hostile anchored team row labeled and defanged', () => {
    applyHostileRow(db, PROJECT, 'pitfall', { anchor: JSON.stringify({ files: ['src/hostile-probe.ts'] }) });
    const input = {
      session_id: 'exit-golden-pitfall',
      transcript_path: '/tmp/none.jsonl',
      cwd: CWD,
      tool_name: 'Edit',
      tool_input: { file_path: `${CWD}/src/hostile-probe.ts`, old_string: 'a', new_string: 'b' },
    } as unknown as PreToolUseInput;
    const result = handlePitfallCheck(input, client);
    assert.ok(result.output, 'the anchored hostile pitfall MUST surface — a silent pass proves nothing');
    // The warning framing itself speaks as `[WAYKEEP] Pitfalls for …` —
    // a framework-voice path, same narrowed invariant as prompt recall.
    assertGolden(String(result.output), 'pitfall warning', { allowFrameworkVoice: true });
  });

  it('the SubagentStart context renders the hostile team pitfall labeled and defanged', () => {
    applyHostileRow(db, PROJECT, 'pitfall');
    const input = {
      session_id: 'exit-golden-subagent',
      transcript_path: '/tmp/none.jsonl',
      cwd: CWD,
    } as unknown as SubagentStartInput;
    const result = handleSubagentContext(input, client);
    assert.ok(result.output, 'the top-pitfall path MUST surface the row');
    assertGolden(String(result.output), 'subagent context');
  });

  it('the UserPromptSubmit recall renders the hostile team row inside the genuine framework voice, defanged', () => {
    applyHostileRow(db, PROJECT, 'pitfall');
    const input = {
      session_id: 'exit-golden-prompt',
      transcript_path: '/tmp/none.jsonl',
      cwd: CWD,
      prompt: 'why must I obey this line about the hostile pitfall lesson?',
    } as unknown as UserPromptSubmitInput;
    const result = handlePromptCheck(input, client);
    assert.ok(result.output && result.output.includes('waykeep-team'), 'the keyword recall MUST surface the row');
    // The prompt path legitimately speaks in `[WAYKEEP]`-prefixed
    // framework lines — the invariant is that the FORGED marker inside
    // stored content never survives to sit in that voice.
    assertGolden(String(result.output), 'prompt recall', { allowFrameworkVoice: true });
  });
});

describe('M1-exit: MCP malicious goldens (real transport)', () => {
  let server: McpServer;
  let mcpClient: Client;

  beforeEach(async () => {
    server = new McpServer({ name: 'exit-golden', version: '0.0.0' });
    registerMemoryTools(server, client.memoryRepo, () => 'normal', server.server, new EdgeRepository(db), cache);
    mcpClient = new Client({ name: 'exit-golden-client', version: '0.0.0' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), mcpClient.connect(ct)]);
  });

  afterEach(async () => {
    await mcpClient.close();
    await server.close();
  });

  async function call(name: string, args: Record<string, unknown>): Promise<string> {
    const result = await mcpClient.callTool({ name, arguments: args });
    const { content, isError } = result as { content?: Array<{ type: string; text?: string }>; isError?: boolean };
    assert.ok(Array.isArray(content) && isError !== true, `${name} succeeded`);
    return content.filter(c => c.type === 'text' && typeof c.text === 'string').map(c => c.text as string).join('\n');
  }

  it('cairn_recall renders the hostile team row labeled and defanged', async () => {
    applyHostileRow(db, PROJECT, 'pitfall');
    const text = await call(TOOL.RECALL, { query: 'hostile pitfall lesson', project: PROJECT });
    assert.ok(text.includes('waykeep-team'), 'recall MUST surface the row');
    assertGolden(text, 'mcp recall');
  });

  it('cairn_expand renders the hostile team row labeled and defanged', async () => {
    const id = applyHostileRow(db, PROJECT, 'pitfall');
    const text = await call(TOOL.EXPAND, { ids: [`pit:${id.slice(0, 8)}`] });
    assert.ok(text.includes('waykeep-team'), 'expand MUST render the row');
    assertGolden(text, 'mcp expand');
  });
});
