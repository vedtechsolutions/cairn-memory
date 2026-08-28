import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { openDatabase } from '../src/db/connection.js';
import { GovernanceRuleRepository } from '../src/governance/rule-repository.js';
import { registerGovernanceTools } from '../src/mcp/tools/governance-tools.js';
import { projectId } from '../src/utils/project-id.js';

let db: Database.Database;
let server: McpServer;
let client: Client;
let root: string;
let elicitation: { action: 'accept' | 'decline' | 'cancel'; content?: Record<string, unknown> };

beforeEach(async () => {
  db = openDatabase({ dbPath: ':memory:' });
  root = mkdtempSync(join(tmpdir(), 'cairn-override-'));
  mkdirSync(join(root, '.cairn'));
  writeFileSync(join(root, '.cairn', 'gates.json'), JSON.stringify({
    version: 1,
    defaults: { level: 'warn', evaluationTimeoutMs: 1000, retention: { evidenceDays: 30 } },
    gates: { 'test-core': { argv: ['npm', 'test'], parser: 'node-test', timeoutMs: 30_000 } },
    pathRules: [{ paths: ['**'], require: ['test-core'] }],
  }));
  new GovernanceRuleRepository(db).create({
    ruleId: 'verify-core', content: 'Verify core before exit', project: projectId(root),
    phases: ['pre_exit'], level: 'warn', gateIds: ['test-core'], paths: [],
    confirmation: { userConfirmed: true },
  });
  server = new McpServer({ name: 'cairn-test', version: '0.0.0' });
  registerGovernanceTools(server, db, server.server);
  client = new Client({ name: 'cairn-test-client', version: '0.0.0' }, {
    capabilities: { elicitation: { form: {} } },
  });
  elicitation = { action: 'decline' };
  client.setRequestHandler(ElicitRequestSchema, async () => elicitation);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});

afterEach(async () => {
  await client.close();
  await server.close();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

async function call(args: Record<string, unknown>) {
  return client.callTool({ name: 'cairn_governance_override', arguments: args }) as Promise<{
    content: Array<{ type: string; text?: string }>; isError?: boolean;
  }>;
}

describe('cairn_governance_override', () => {
  it('writes nothing when the user declines interactive confirmation', async () => {
    const result = await call({ project_root: root, session_id: 'session-a' });
    assert.equal(result.isError, undefined, JSON.stringify(result));
    assert.match(result.content[0].text ?? '', /cancelled/);
    assert.equal((db.prepare(`SELECT count(*) n FROM governance_audit`).get() as { n: number }).n, 1,
      'only pre-existing rule creation audit remains');
    assert.equal((db.prepare(`SELECT count(*) n FROM memories WHERE kind = 'fact'`).get() as { n: number }).n, 0);
  });

  it('persists a linked override only from the elicited user reason', async () => {
    elicitation = { action: 'accept', content: { confirm: true, reason: 'User entered outage rationale' } };
    const result = await call({
      project_root: root, session_id: 'session-a', expires_in_minutes: 30,
      last_assistant_message: 'ASSISTANT_NEEDLE_MUST_NOT_PERSIST',
    });
    assert.equal(result.isError, true, 'strict schema rejects assistant-only extra fields');
    elicitation = { action: 'accept', content: { confirm: true, reason: 'User entered outage rationale' } };
    const accepted = await call({ project_root: root, session_id: 'session-a', expires_in_minutes: 30 });
    assert.equal(accepted.isError, undefined, JSON.stringify(accepted));
    const rows = db.prepare(`
      SELECT a.payload, a.redacted_detail, m.content, m.context
      FROM governance_audit a JOIN memories m ON m.id = a.linked_rule_memory_id
      WHERE a.event_type = 'governance_override_created'
    `).all();
    assert.equal(rows.length, 1);
    assert.match(JSON.stringify(rows), /User entered outage rationale/);
    assert.doesNotMatch(JSON.stringify(rows), /ASSISTANT_NEEDLE_MUST_NOT_PERSIST/);
  });
});
