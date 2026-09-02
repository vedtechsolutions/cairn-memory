/**
 * MCP-boundary tests for src/mcp/tools/memory-tools.ts.
 *
 * Drives the REAL registration path: registerMemoryTools on an McpServer wired
 * exactly like src/mcp/server.ts (inner Server, EdgeRepository, SessionCache),
 * connected to a real Client over InMemoryTransport, backed by an in-memory
 * SQLite database. The embedding model is never warmed up, so all handlers
 * deterministically exercise their FTS fallback paths.
 *
 * Covers all eight tools registered by that file: cairn_recall, cairn_learn,
 * cairn_correct, cairn_forget, cairn_strengthen, cairn_weaken, cairn_expand,
 * cairn_cleanup — happy paths, handler-level validation errors, and
 * schema-boundary rejections (which surface as isError results through the
 * SDK client, not thrown rejections).
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type Database from 'better-sqlite3';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { openDatabase } from '../src/db/connection.js';
import { MemoryRepository } from '../src/db/memory-repository.js';
import { projectId } from '../src/utils/project-id.js';
import { EdgeRepository } from '../src/db/edge-repository.js';
import { SessionCache } from '../src/hooks/shared/session-cache.js';
import { registerMemoryTools } from '../src/mcp/tools/memory-tools.js';
import {
  BRIEFING_MODE,
  CONFIDENCE,
  LIMITS,
  TOKEN_BUDGET,
  type ContextMode,
} from '../src/constants/index.js';

// --- Harness -----------------------------------------------------------------

let db: Database.Database;
let repo: MemoryRepository;
let edgeRepo: EdgeRepository;
let sessionCache: SessionCache;
let server: McpServer;
let client: Client;
let mode: ContextMode;

beforeEach(async () => {
  mode = 'normal';
  db = openDatabase({ dbPath: ':memory:' });
  repo = new MemoryRepository(db);
  edgeRepo = new EdgeRepository(db);
  sessionCache = new SessionCache();
  server = new McpServer({ name: 'cairn-test', version: '0.0.0' });
  // Mirror the production wiring in src/mcp/server.ts
  registerMemoryTools(server, repo, () => mode, server.server, edgeRepo, sessionCache);
  client = new Client({ name: 'cairn-test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});

afterEach(async () => {
  await client.close();
  await server.close();
  sessionCache.destroy();
  db.close();
});

interface ToolReply {
  text: string;
  isError: boolean;
}

/** Call a tool through the MCP client and flatten its text content. */
async function call(name: string, args: Record<string, unknown>): Promise<ToolReply> {
  const result = await client.callTool({ name, arguments: args });
  const { content, isError } = result as { content?: unknown; isError?: boolean };
  assert.ok(Array.isArray(content), 'tool result must include a content array');
  const text = (content as Array<{ type: string; text?: string }>)
    .filter(c => c.type === 'text' && typeof c.text === 'string')
    .map(c => c.text as string)
    .join('\n');
  return { text, isError: isError === true };
}

function countRows(): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number };
  return row.n;
}

const CRITICAL_TEXT = '[cairn silent — context critical]';

// --- cairn_learn ---------------------------------------------------------------

describe('cairn_learn', () => {
  it('stores a fact retrievable from the repository and replies ok', async () => {
    const reply = await call('cairn_learn', {
      content: 'Prefer WAL journal mode for concurrent sqlite readers',
      kind: 'fact',
      tags: ['sqlite'],
      project: 'proj-a',
    });

    assert.equal(reply.isError, false);
    assert.equal(reply.text, 'ok');

    const stored = repo.exportMemories({ project: 'proj-a' });
    assert.equal(stored.length, 1);
    assert.equal(stored[0].content, 'Prefer WAL journal mode for concurrent sqlite readers');
    assert.equal(stored[0].kind, 'fact');
    assert.equal(stored[0].project, 'proj-a');
    assert.deepEqual(stored[0].tags, ['sqlite']);
    assert.equal(stored[0].confidence, CONFIDENCE.LEARNED);
  });

  it('bumps the session cache memory version on a successful learn', async () => {
    const before = sessionCache.getMemoryVersion();
    await call('cairn_learn', { content: 'Skip gates must see new memories immediately', kind: 'fact' });
    assert.ok(sessionCache.getMemoryVersion() > before, 'learn must invalidate skip-gate caches');
  });

  it('stores pitfalls through the gateway at DELIBERATE confidence (step 3 — was AUTO_DETECTED)', async () => {
    // Inverted by remediation step 3: an explicit cairn_learn pitfall was a
    // conscious act yet inherited the auto-miner prior (0.55), leaving it
    // below the 0.65 injection gate — structurally uninjectable (M7).
    await call('cairn_learn', {
      content: 'Validate webhook signatures before dispatching handlers',
      kind: 'pitfall',
      project: 'proj-a',
    });

    const stored = repo.exportMemories({ project: 'proj-a' });
    assert.equal(stored.length, 1);
    assert.equal(stored[0].kind, 'pitfall');
    assert.equal(stored[0].confidence, CONFIDENCE.DELIBERATE);
  });

  it('forces user_profile memories to global scope even when a project is given', async () => {
    await call('cairn_learn', {
      content: 'User is a senior Odoo developer preferring terse replies',
      kind: 'user_profile',
      project: 'proj-a',
    });

    const stored = repo.exportMemories({});
    assert.equal(stored.length, 1);
    assert.equal(stored[0].project, null);
  });

  it('prefixes reference tags with ref: without double-prefixing', async () => {
    await call('cairn_learn', {
      content: 'Billing epics live in the Linear workspace under team PAY',
      kind: 'reference',
      tags: ['linear', 'ref:jira'],
    });

    const stored = repo.exportMemories({});
    assert.equal(stored.length, 1);
    assert.deepEqual(stored[0].tags, ['ref:linear', 'ref:jira']);
  });

  it('stores structured why and how_to_apply context', async () => {
    await call('cairn_learn', {
      content: 'Verify HMAC signatures before resolving transactions',
      kind: 'fact',
      why: 'Prevents forged payloads',
      how_to_apply: 'Check the signature header first',
    });

    const stored = repo.exportMemories({});
    assert.equal(stored.length, 1);
    assert.deepEqual(stored[0].context, {
      why: 'Prevents forged payloads',
      how_to_apply: 'Check the signature header first',
    });
  });

  it('replies dedup, keeps one row, and boosts confidence when the same lesson recurs', async () => {
    const args = {
      content: 'Odoo settings views require a name attribute on the app element',
      kind: 'fact',
      project: 'proj-a',
    };
    const first = await call('cairn_learn', args);
    const second = await call('cairn_learn', args);

    assert.equal(first.text, 'ok');
    assert.equal(second.text, 'dedup');
    assert.equal(countRows(), 1);

    const stored = repo.exportMemories({ project: 'proj-a' });
    assert.ok(
      Math.abs(stored[0].confidence - (CONFIDENCE.LEARNED + CONFIDENCE.BOOST_INCREMENT)) < 1e-9,
      `dedup must reinforce confidence, got ${stored[0].confidence}`,
    );
  });

  it('accepts a valid future expires_at and stores it on the row', async () => {
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const reply = await call('cairn_learn', {
      content: 'Deploy freeze is active until the release ships',
      kind: 'fact',
      expires_at: future,
    });
    assert.equal(reply.text, 'ok');

    const row = db.prepare('SELECT expires_at FROM memories').get() as { expires_at: string | null };
    assert.equal(row.expires_at, future);
  });

  it('rejects a malformed expires_at with an error reply', async () => {
    const reply = await call('cairn_learn', {
      content: 'Deploy freeze is active until the release ships',
      kind: 'fact',
      expires_at: 'not-a-date',
    });
    assert.equal(reply.isError, true);
    assert.match(reply.text, /expires_at must be a valid future ISO date/);
    assert.equal(countRows(), 0);
  });

  it('rejects an expires_at in the past with an error reply', async () => {
    const reply = await call('cairn_learn', {
      content: 'Deploy freeze is active until the release ships',
      kind: 'fact',
      expires_at: '2020-01-01T00:00:00.000Z',
    });
    assert.equal(reply.isError, true);
    assert.match(reply.text, /expires_at must be a valid future ISO date/);
    assert.equal(countRows(), 0);
  });

  it('rejects whitespace-only content with an error reply instead of storing it', async () => {
    const reply = await call('cairn_learn', { content: '   ', kind: 'fact' });
    assert.equal(reply.isError, true);
    assert.match(reply.text, /Content must not be empty/);
    assert.equal(countRows(), 0);
  });

  it('rejects system-generated XML content with an error reply', async () => {
    const reply = await call('cairn_learn', {
      content: '<system-reminder>internal hook payload leaked here</system-reminder>',
      kind: 'fact',
    });
    assert.equal(reply.isError, true);
    assert.match(reply.text, /system-generated/);
    assert.equal(countRows(), 0);
  });

  it('rejects empty-string tags with an error reply instead of storing them', async () => {
    const reply = await call('cairn_learn', {
      content: 'Tags must carry retrieval signal',
      kind: 'fact',
      tags: ['valid', '  '],
    });
    assert.equal(reply.isError, true);
    assert.match(reply.text, /Tags must not be empty/);
    assert.equal(countRows(), 0);
  });

  it('warns about relative dates while still storing the memory', async () => {
    const reply = await call('cairn_learn', {
      content: 'Deploy freeze starts tomorrow for the billing cluster',
      kind: 'fact',
    });
    assert.equal(reply.isError, false);
    assert.match(reply.text, /^ok \(warn:.*relative date 'tomorrow'/);
    assert.equal(countRows(), 1);
  });

  it('appends a distill warning when content exceeds the warn threshold', async () => {
    const longContent = 'context '.repeat(
      Math.ceil((TOKEN_BUDGET.CONTENT_WARN_CHARS + 10) / 'context '.length),
    );
    assert.ok(longContent.length > TOKEN_BUDGET.CONTENT_WARN_CHARS, 'precondition: over warn threshold');
    assert.ok(longContent.length <= LIMITS.MAX_CONTENT_CHARS, 'precondition: under hard limit');

    const reply = await call('cairn_learn', { content: longContent, kind: 'fact' });
    assert.equal(reply.isError, false);
    assert.match(reply.text, /^ok \(warn:.*distill further/);
  });

  it('rejects content longer than the schema limit at the protocol boundary', async () => {
    const reply = await call('cairn_learn', {
      content: 'x'.repeat(LIMITS.MAX_CONTENT_CHARS + 1),
      kind: 'fact',
    });
    assert.equal(reply.isError, true);
    assert.match(reply.text, /Input validation error/);
    assert.equal(countRows(), 0);
  });

  it('rejects the system-managed task_state kind at the protocol boundary', async () => {
    const reply = await call('cairn_learn', {
      content: 'System kinds are not learnable via the tool',
      kind: 'task_state',
    });
    assert.equal(reply.isError, true);
    assert.match(reply.text, /Input validation error/);
    assert.equal(countRows(), 0);
  });

  it('defaults a pitfall with no project to the current project, not global', async () => {
    // The root fix for the cross-project leak: a project-specific memory stored
    // without an explicit project must NOT silently land in global scope.
    const reply = await call('cairn_learn', { content: 'Batch DB writes inside a single transaction for speed', kind: 'pitfall' });
    assert.equal(reply.isError, false);
    const rows = db.prepare('SELECT project FROM memories WHERE content LIKE ?').all('%Batch DB writes%') as Array<{ project: string | null }>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].project, projectId(process.cwd()), 'omitted project defaults to the current project');
  });

  it('keeps corrections and an explicit null scope global', async () => {
    await call('cairn_learn', { content: 'Prefer distilled one-sentence lessons over raw user text', kind: 'correction' });
    await call('cairn_learn', { content: 'A deliberately global fact for everyone', kind: 'fact', project: null });
    const correction = db.prepare("SELECT project FROM memories WHERE kind = 'correction'").get() as { project: string | null };
    const explicitGlobal = db.prepare("SELECT project FROM memories WHERE content LIKE '%deliberately global%'").get() as { project: string | null };
    assert.equal(correction.project, null, 'corrections default global');
    assert.equal(explicitGlobal.project, null, 'explicit project:null stays global');
  });
});

// --- cairn_recall --------------------------------------------------------------

describe('cairn_recall', () => {
  it('returns a stored memory relevant to the query with kind, scope, and confidence', async () => {
    repo.create({
      content: 'Validate webhook signatures before dispatching handlers',
      kind: 'pitfall',
      project: 'proj-a',
      tags: ['security'],
    });

    const reply = await call('cairn_recall', {
      query: 'webhook signature validation',
      project: 'proj-a',
    });

    assert.equal(reply.isError, false);
    assert.match(reply.text, /Validate webhook signatures before dispatching handlers/);
    assert.match(reply.text, /\[pitfall\]/);
    assert.match(reply.text, /\[proj-a\]/);
    assert.match(reply.text, /conf: /);
  });

  it('renders structured why context inline in results', async () => {
    repo.create({
      content: 'Verify HMAC signatures before resolving transactions',
      kind: 'fact',
      project: null,
      context: { why: 'Prevents forged payloads' },
    });

    const reply = await call('cairn_recall', { query: 'HMAC signatures transactions' });
    assert.match(reply.text, /\(Why: Prevents forged payloads\)/);
  });

  it('returns the no-results message when nothing matches', async () => {
    const reply = await call('cairn_recall', { query: 'quantum entanglement teapot' });
    assert.equal(reply.isError, false);
    assert.match(reply.text, /^No relevant memories found\. \[retrieval: /,
      'empty results must still disclose which retrieval path produced the emptiness');
  });

  it('excludes other projects while including global scope when a project is given', async () => {
    repo.create({ content: 'Webhook retries demand exponential backoff on failure', kind: 'fact', project: 'proj-a' });
    repo.create({ content: 'Webhook payloads exceed queue size limits sometimes', kind: 'fact', project: 'proj-b' });
    repo.create({ content: 'Webhook secrets rotate quarterly per security policy', kind: 'fact', project: null });

    const reply = await call('cairn_recall', { query: 'webhook', project: 'proj-a' });

    assert.match(reply.text, /exponential backoff/);
    assert.match(reply.text, /secrets rotate quarterly/);
    assert.doesNotMatch(reply.text, /queue size limits/);
  });

  it('surfaces a fingerprint-less global in a scoped recall (permissive — the agent asked)', async () => {
    // Active recall is deliberately permissive: a general global lesson must
    // still surface when scoped to a project (unlike the conservative passive
    // paths). The real defense against mis-scoped globals is at write time.
    repo.create({ content: 'Webhook handler config lives in the settings module', kind: 'fact', project: 'proj-a' });
    repo.create({ content: 'Webhook secrets rotate quarterly per security policy', kind: 'fact', project: null });

    const reply = await call('cairn_recall', { query: 'webhook settings', project: 'proj-a' });
    assert.match(reply.text, /handler config lives in the settings/, 'same-project memory surfaces');
    assert.match(reply.text, /secrets rotate quarterly/, 'general global still surfaces (not over-blocked)');
  });

  it('bare recall returns globals and never OTHER projects\' rows (session default scoping)', async () => {
    // RETITLED at remediation step 2: this previously claimed "only global
    // memories when no project is given" and passed only because proj-a is
    // not the session project. Bare recall now targets the SESSION project
    // plus globals; other projects stay excluded — which is what the
    // assertions below actually pin.
    repo.create({ content: 'Webhook retries demand exponential backoff on failure', kind: 'fact', project: 'proj-a' });
    repo.create({ content: 'Webhook secrets rotate quarterly per security policy', kind: 'fact', project: null });

    const reply = await call('cairn_recall', { query: 'webhook' });

    assert.match(reply.text, /secrets rotate quarterly/);
    assert.doesNotMatch(reply.text, /exponential backoff/);
  });

  it('appends 1-hop graph neighbors to results in normal mode', async () => {
    const hit = repo.create({ content: 'Validate webhook signatures before dispatching handlers', kind: 'pitfall', project: null });
    const neighbor = repo.create({ content: 'Rotate signing secrets quarterly in the vault', kind: 'fact', project: null });
    edgeRepo.createEdge(hit.id, neighbor.id, 'informs', 0.9);

    const reply = await call('cairn_recall', { query: 'webhook signatures dispatching' });

    assert.match(reply.text, /Validate webhook signatures/);
    assert.match(reply.text, /Rotate signing secrets quarterly/, 'graph neighbor must be appended');
  });

  it('honors max_results when it is below the mode cap', async () => {
    repo.create({ content: 'Deployment alpha requires rollback rehearsal first', kind: 'fact', project: null });
    repo.create({ content: 'Deployment beta rides canary stages exclusively', kind: 'fact', project: null });

    const reply = await call('cairn_recall', { query: 'deployment', max_results: 1 });
    // Count RESULT lines: the output also carries a retrieval-path header line.
    assert.equal(reply.text.split('\n').filter(l => l.startsWith('•')).length, 1);
  });

  it('caps result count at the compact-mode limit even when more is requested', async () => {
    mode = 'compact';
    repo.create({ content: 'Deployment alpha requires rollback rehearsal first', kind: 'fact', project: null });
    repo.create({ content: 'Deployment beta rides canary stages exclusively', kind: 'fact', project: null });
    repo.create({ content: 'Deployment gamma demands approval gates upstream', kind: 'fact', project: null });
    repo.create({ content: 'Deployment delta locks schema migrations early', kind: 'fact', project: null });
    repo.create({ content: 'Deployment epsilon pins container digests always', kind: 'fact', project: null });

    const reply = await call('cairn_recall', { query: 'deployment', max_results: 10 });
    assert.equal(reply.text.split('\n').filter(l => l.startsWith('•')).length, LIMITS.RECALL_COMPACT);
  });

  it('omits kind, scope, and confidence metadata in minimal mode', async () => {
    mode = 'minimal';
    repo.create({ content: 'Deployment alpha requires rollback rehearsal first', kind: 'fact', project: null });

    const reply = await call('cairn_recall', { query: 'deployment rollback' });
    // Minimal mode carries a compact degraded-path marker (tests run without
    // the embedding model, so the FTS-only marker is expected here) but no
    // per-row metadata — that is the property under test.
    assert.equal(reply.text, '[FTS-only]\n• Deployment alpha requires rollback rehearsal first');
  });

  it('goes silent in critical context mode without touching recall stats', async () => {
    mode = 'critical';
    const created = repo.create({ content: 'Deployment alpha requires rollback rehearsal first', kind: 'fact', project: null });

    const reply = await call('cairn_recall', { query: 'deployment rollback' });
    assert.equal(reply.text, CRITICAL_TEXT);

    const mem = repo.findById(created.id);
    assert.ok(mem);
    assert.equal(mem.recall_count, 0, 'silent mode must not record a recall');
  });

  it('rejects an over-long query at the protocol boundary', async () => {
    const reply = await call('cairn_recall', {
      query: 'x'.repeat(LIMITS.MAX_STRING_PARAM + 1),
    });
    assert.equal(reply.isError, true);
    assert.match(reply.text, /Input validation error/);
  });
});

// --- cairn_strengthen ------------------------------------------------------------

describe('cairn_strengthen', () => {
  it('raises confidence by the strengthen increment and bumps the cache version', async () => {
    const created = repo.create({ content: 'Pin container digests in production deploys', kind: 'fact', confidence: 0.5 });
    const versionBefore = sessionCache.getMemoryVersion();

    const reply = await call('cairn_strengthen', { id: created.id });
    assert.equal(reply.text, 'ok');

    const mem = repo.findById(created.id);
    assert.ok(mem);
    assert.ok(
      Math.abs(mem.confidence - (0.5 + CONFIDENCE.STRENGTHEN_INCREMENT)) < 1e-9,
      `expected 0.5 + increment, got ${mem.confidence}`,
    );
    assert.ok(sessionCache.getMemoryVersion() > versionBefore);
  });

  it('clamps confidence at 1.0', async () => {
    const created = repo.create({ content: 'Pin container digests in production deploys', kind: 'fact', confidence: 0.98 });

    await call('cairn_strengthen', { id: created.id });

    const mem = repo.findById(created.id);
    assert.ok(mem);
    assert.equal(mem.confidence, 1.0);
  });

  it('replies not found for an unknown id without bumping the cache version', async () => {
    const versionBefore = sessionCache.getMemoryVersion();
    const reply = await call('cairn_strengthen', { id: 'no-such-id' });
    assert.equal(reply.text, 'not found');
    assert.equal(sessionCache.getMemoryVersion(), versionBefore);
  });

  it('replies not found for an invalidated memory and leaves it unchanged', async () => {
    const created = repo.create({ content: 'Pin container digests in production deploys', kind: 'fact', confidence: 0.5 });
    repo.invalidate(created.id);

    const reply = await call('cairn_strengthen', { id: created.id });
    assert.equal(reply.text, 'not found');

    const mem = repo.findById(created.id);
    assert.ok(mem);
    assert.equal(mem.confidence, 0.5);
  });
});

// --- cairn_weaken ----------------------------------------------------------------

describe('cairn_weaken', () => {
  it('lowers confidence by the weaken factor without invalidating', async () => {
    const created = repo.create({ content: 'Cache invalidation happens on every write path', kind: 'fact', confidence: 0.8 });

    const reply = await call('cairn_weaken', { id: created.id });
    assert.equal(reply.text, 'ok');

    const mem = repo.findById(created.id);
    assert.ok(mem);
    assert.ok(
      Math.abs(mem.confidence - 0.8 * CONFIDENCE.WEAKEN_FACTOR) < 1e-9,
      `expected 0.8 * weaken factor, got ${mem.confidence}`,
    );
    assert.equal(mem.invalidated, 0);
  });

  it('auto-invalidates when confidence falls below the delete threshold', async () => {
    const startConfidence = CONFIDENCE.DELETE_THRESHOLD * 1.1;
    assert.ok(
      startConfidence * CONFIDENCE.WEAKEN_FACTOR < CONFIDENCE.DELETE_THRESHOLD,
      'precondition: one weaken must cross the delete threshold',
    );
    const created = repo.create({ content: 'Cache invalidation happens on every write path', kind: 'fact', confidence: startConfidence });

    const reply = await call('cairn_weaken', { id: created.id });
    assert.equal(reply.text, 'invalidated');

    const mem = repo.findById(created.id);
    assert.ok(mem);
    assert.equal(mem.invalidated, 1);
  });

  it('replies not found for an unknown id', async () => {
    const reply = await call('cairn_weaken', { id: 'no-such-id' });
    assert.equal(reply.text, 'not found');
  });
});

// --- cairn_correct ---------------------------------------------------------------

describe('cairn_correct', () => {
  it('update rewrites content and marks the memory corrected', async () => {
    const created = repo.create({ content: 'Original lesson about connection pooling limits', kind: 'fact' });

    const reply = await call('cairn_correct', {
      id: created.id,
      action: 'update',
      new_content: 'Corrected lesson about connection pooling limits',
    });
    assert.equal(reply.text, 'ok');

    const mem = repo.findById(created.id);
    assert.ok(mem);
    assert.equal(mem.content, 'Corrected lesson about connection pooling limits');
    assert.equal(mem.source, 'corrected');
    assert.equal(mem.confidence, CONFIDENCE.CORRECTION);
  });

  it('update without new_content replies with an error', async () => {
    const created = repo.create({ content: 'Original lesson about connection pooling limits', kind: 'fact' });

    const reply = await call('cairn_correct', { id: created.id, action: 'update' });
    assert.equal(reply.isError, true);
    assert.match(reply.text, /new_content required/);

    const mem = repo.findById(created.id);
    assert.ok(mem);
    assert.equal(mem.content, 'Original lesson about connection pooling limits');
  });

  it('update replies not found for an unknown id', async () => {
    const reply = await call('cairn_correct', {
      id: 'no-such-id',
      action: 'update',
      new_content: 'Replacement text that has nowhere to go',
    });
    assert.equal(reply.text, 'not found');
  });

  it('invalidate soft-deletes the memory and hides it from export', async () => {
    const created = repo.create({ content: 'Original lesson about connection pooling limits', kind: 'fact' });

    const reply = await call('cairn_correct', { id: created.id, action: 'invalidate' });
    assert.equal(reply.text, 'ok');

    const mem = repo.findById(created.id);
    assert.ok(mem);
    assert.equal(mem.invalidated, 1);
    assert.equal(repo.exportMemories({}).length, 0);
  });

  it('invalidate replies not found for an unknown id', async () => {
    const reply = await call('cairn_correct', { id: 'no-such-id', action: 'invalidate' });
    assert.equal(reply.text, 'not found');
  });

  it('rejects an unknown action at the protocol boundary', async () => {
    const reply = await call('cairn_correct', { id: 'whatever', action: 'delete' });
    assert.equal(reply.isError, true);
    assert.match(reply.text, /Input validation error/);
  });
});

// --- cairn_forget ----------------------------------------------------------------

describe('cairn_forget', () => {
  it('permanently deletes the memory', async () => {
    const created = repo.create({ content: 'Ephemeral note destined for deletion today', kind: 'fact' });

    const reply = await call('cairn_forget', { id: created.id });
    assert.equal(reply.text, 'ok');
    assert.equal(repo.findById(created.id), null);
    assert.equal(countRows(), 0);
  });

  it('replies not found for an unknown id', async () => {
    const reply = await call('cairn_forget', { id: 'no-such-id' });
    assert.equal(reply.text, 'not found');
  });
});

// --- cairn_expand ----------------------------------------------------------------

describe('cairn_expand', () => {
  /** Force a memory's id to a known value so short-id prefixes are predictable. */
  function setId(oldId: string, newId: string): void {
    db.prepare('UPDATE memories SET id = ? WHERE id = ?').run(newId, oldId);
  }

  it('expands a type-coded short id into full detail lines', async () => {
    const created = repo.create({
      content: 'Validate webhook signatures before dispatching handlers',
      kind: 'pitfall',
      project: 'proj-a',
      tags: ['security'],
      confidence: 0.8,
    });
    const short = created.id.slice(0, 8);

    const reply = await call('cairn_expand', { ids: [`pit:${short}`] });

    assert.equal(reply.isError, false);
    assert.match(reply.text, new RegExp(`\\[pitfall:${short}\\] Validate webhook signatures`));
    assert.match(reply.text, /conf=0\.80 surface=0 impact=0 project=proj-a \[security\]/);
  });

  it('includes why and how lines when structured context is present', async () => {
    const created = repo.create({
      content: 'Verify HMAC signatures before resolving transactions',
      kind: 'decision',
      project: null,
      context: { why: 'Prevents forged payloads', how_to_apply: 'Check the signature header first' },
    });

    const reply = await call('cairn_expand', { ids: [`dec:${created.id.slice(0, 8)}`] });

    assert.match(reply.text, /^ {2}why: Prevents forged payloads$/m);
    assert.match(reply.text, /^ {2}how: Check the signature header first$/m);
  });

  it('emits a skip line for a malformed id and keeps expanding the rest', async () => {
    const created = repo.create({ content: 'Valid entry that still expands fine', kind: 'fact', project: null });

    const reply = await call('cairn_expand', { ids: ['bogus-format', `fact:${created.id.slice(0, 8)}`] });

    assert.match(reply.text, /\[skip\] "bogus-format": expected format <kind>:<short-id>/);
    assert.match(reply.text, /Valid entry that still expands fine/);
  });

  it('replies not found for an unknown short id', async () => {
    const reply = await call('cairn_expand', { ids: ['pit:deadbeef'] });
    assert.equal(reply.text, '[not found] pit:deadbeef');
  });

  it('replies not found when a short-id prefix is ambiguous', async () => {
    // Contents must stay lexically disjoint — token overlap >= 0.5 would dedup-merge them
    const a = repo.create({ content: 'Alpha rollback rehearsal precedes canary launches', kind: 'fact', project: null });
    const b = repo.create({ content: 'Quarterly vault rotation guards signing material', kind: 'fact', project: null });
    setId(a.id, 'aaaabbbb-0000-4000-8000-000000000001');
    setId(b.id, 'aaaabbbb-0000-4000-8000-000000000002');

    const reply = await call('cairn_expand', { ids: ['fact:aaaabbbb'] });
    assert.equal(reply.text, '[not found] fact:aaaabbbb');
  });

  it('replies not found for an invalidated memory', async () => {
    const created = repo.create({ content: 'Soft deleted entries must stay hidden here', kind: 'fact', project: null });
    repo.invalidate(created.id);

    const reply = await call('cairn_expand', { ids: [`fact:${created.id.slice(0, 8)}`] });
    assert.equal(reply.text, `[not found] fact:${created.id.slice(0, 8)}`);
  });

  it('goes silent in critical context mode', async () => {
    mode = 'critical';
    const reply = await call('cairn_expand', { ids: ['pit:deadbeef'] });
    assert.equal(reply.text, CRITICAL_TEXT);
  });

  it('rejects an empty ids array at the protocol boundary', async () => {
    const reply = await call('cairn_expand', { ids: [] });
    assert.equal(reply.isError, true);
    assert.match(reply.text, /Input validation error/);
  });

  it('rejects more ids than the expand cap at the protocol boundary', async () => {
    const ids = Array.from({ length: BRIEFING_MODE.EXPAND_MAX_IDS + 1 }, (_, i) => `pit:prefix${i}`);
    const reply = await call('cairn_expand', { ids });
    assert.equal(reply.isError, true);
    assert.match(reply.text, /Input validation error/);
  });
});

// --- cairn_cleanup ---------------------------------------------------------------

describe('cairn_cleanup', () => {
  it('preview lists matching memories without deleting anything', async () => {
    repo.create({ content: 'Stale note about the deprecated payment flow', kind: 'fact', project: 'proj-a', confidence: 0.3 });
    repo.create({ content: 'Another stale note about legacy cron wiring', kind: 'fact', project: 'proj-a', confidence: 0.2 });

    const reply = await call('cairn_cleanup', { action: 'preview', filter: { project: 'proj-a' } });

    assert.equal(reply.isError, false);
    assert.match(reply.text, new RegExp(`^Would delete 2 memories \\(max ${LIMITS.CLEANUP_MAX_DELETE}\\)\\.`));
    assert.match(reply.text, /deprecated payment flow/);
    assert.equal(countRows(), 2, 'preview must not delete');
  });

  it('preview replies with a no-match message for an empty filter result', async () => {
    const reply = await call('cairn_cleanup', { action: 'preview', filter: { project: 'ghost-project' } });
    assert.equal(reply.text, 'No memories match this filter.');
  });

  it('execute deletes matching memories when the client lacks elicitation support', async () => {
    repo.create({ content: 'Stale note about the deprecated payment flow', kind: 'fact', project: 'proj-a' });
    repo.create({ content: 'Another stale note about legacy cron wiring', kind: 'fact', project: 'proj-a' });
    const versionBefore = sessionCache.getMemoryVersion();

    const reply = await call('cairn_cleanup', { action: 'execute', filter: { project: 'proj-a' } });

    assert.equal(reply.text, 'deleted 2');
    assert.equal(countRows(), 0);
    assert.ok(sessionCache.getMemoryVersion() > versionBefore, 'bulk delete must bump the cache version');
  });

  it('execute honors the max_confidence filter and keeps trusted memories', async () => {
    // Contents must stay lexically disjoint — token overlap >= 0.5 would dedup-merge them
    repo.create({ content: 'Speculative guess regarding eviction timing windows', kind: 'fact', project: 'proj-a', confidence: 0.3 });
    const keep = repo.create({ content: 'Billing indexes require weekly rebuild after imports', kind: 'fact', project: 'proj-a', confidence: 0.9 });

    const reply = await call('cairn_cleanup', {
      action: 'execute',
      filter: { project: 'proj-a', max_confidence: 0.5 },
    });

    assert.equal(reply.text, 'deleted 1');
    assert.ok(repo.findById(keep.id), 'high-confidence memory must survive');
  });

  it('execute replies with a no-match message instead of deleting zero rows', async () => {
    const reply = await call('cairn_cleanup', { action: 'execute', filter: { project: 'ghost-project' } });
    assert.equal(reply.text, 'No memories match this filter.');
  });

  it('goes silent in critical context mode', async () => {
    mode = 'critical';
    const reply = await call('cairn_cleanup', { action: 'execute', filter: { project: 'proj-a' } });
    assert.equal(reply.text, CRITICAL_TEXT);
  });

  it('rejects an unknown action at the protocol boundary', async () => {
    const reply = await call('cairn_cleanup', { action: 'purge', filter: {} });
    assert.equal(reply.isError, true);
    assert.match(reply.text, /Input validation error/);
  });
});
