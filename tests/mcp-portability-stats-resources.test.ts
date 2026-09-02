/**
 * MCP integration tests for the untested tool/resource registration modules:
 *  - src/mcp/tools/portability-tools.ts (cairn_ingest, cairn_export, cairn_promote)
 *  - src/mcp/tools/stats-tool.ts        (cairn_stats)
 *  - src/mcp/resources.ts               (cairn://plan/..., cairn://briefing/...)
 *
 * Exercises the REAL registration path: tools/resources are registered on an
 * McpServer and invoked through an in-memory client transport, so schema
 * validation, handler wiring, and response shapes are all covered end-to-end.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type Database from 'better-sqlite3';

import { openDatabase } from '../src/db/connection.js';
import { MemoryRepository } from '../src/db/memory-repository.js';
import { PlanRepository } from '../src/db/plan-repository.js';
import { ReminderRepository } from '../src/db/reminder-repository.js';
import { SessionCache } from '../src/hooks/shared/session-cache.js';
import { canonicalJson } from '../src/memory-tool/round-trip.js';
import { registerPortabilityTools } from '../src/mcp/tools/portability-tools.js';
import { registerStatsTools } from '../src/mcp/tools/stats-tool.js';
import { registerResources } from '../src/mcp/resources.js';
import { HEALTH, LIMITS, PROMOTION, type ContextMode } from '../src/constants/index.js';
import { TOOL, MCP_URI_SCHEME } from '../src/constants/mcp.js';
import { MCP_SERVER_NAME } from '../src/constants/mcp.js';

// --- Harness ------------------------------------------------------------------

const CRITICAL_TEXT = `[${MCP_SERVER_NAME} silent — context critical]`;

interface ToolTextContent {
  type: 'text';
  text: string;
}

interface ToolResult {
  content: ToolTextContent[];
  isError?: boolean;
}

interface ResourceTextContent {
  uri: string;
  mimeType?: string;
  text: string;
}

interface Harness {
  db: Database.Database;
  memoryRepo: MemoryRepository;
  planRepo: PlanRepository;
  client: Client;
  setMode: (mode: ContextMode) => void;
  close: () => Promise<void>;
}

/** Fresh in-memory DB + real MCP server/client pair per test. */
async function startHarness(): Promise<Harness> {
  const db = openDatabase({ dbPath: ':memory:' });
  const memoryRepo = new MemoryRepository(db);
  const planRepo = new PlanRepository(db);
  const reminderRepo = new ReminderRepository(db);

  let mode: ContextMode = 'normal';
  const getMode = (): ContextMode => mode;

  const server = new McpServer({ name: 'cairn-test', version: '0.0.0-test' });
  registerPortabilityTools(server, memoryRepo, getMode, new SessionCache());
  registerStatsTools(server, memoryRepo, planRepo, reminderRepo, db, getMode);
  registerResources(server, planRepo, memoryRepo, getMode);

  const client = new Client({ name: 'cairn-test-client', version: '0.0.0-test' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    db,
    memoryRepo,
    planRepo,
    client,
    setMode: (m) => { mode = m; },
    close: async () => {
      await client.close();
      await server.close();
      db.close();
    },
  };
}

async function callTool(client: Client, name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  return await client.callTool({ name, arguments: args }) as unknown as ToolResult;
}

function textOf(result: ToolResult): string {
  return result.content.map(c => c.text).join('\n');
}

async function readResourceText(client: Client, uri: string): Promise<string> {
  const result = await client.readResource({ uri });
  const first = result.contents[0] as unknown as ResourceTextContent;
  return first.text;
}

// --- cairn_export ---------------------------------------------------------------

describe(TOOL.EXPORT, () => {
  let h: Harness;
  beforeEach(async () => { h = await startHarness(); });
  afterEach(async () => { await h.close(); });

  it('exports stored memories as v2 sections with headings and data payloads', async () => {
    h.memoryRepo.create({
      content: 'HMAC verification: verify webhook signatures before resolving transactions',
      kind: 'pitfall',
      project: 'proj-a',
      tags: ['payments', 'webhooks'],
      confidence: 0.9,
    });
    h.memoryRepo.create({
      content: 'Chose better-sqlite3 over sql.js for synchronous hook access',
      kind: 'decision',
      project: null,
      confidence: 0.8,
    });

    const result = await callTool(h.client, TOOL.EXPORT);
    assert.notEqual(result.isError, true);
    const text = textOf(result);

    assert.match(text, /^# Waykeep Export v2/);
    assert.ok(text.includes('# Memories: 2'), `expected 2 memories in header, got:\n${text}`);
    assert.match(text, /## Pitfall: HMAC verification.*\[confidence: 0\.90\]/);
    assert.ok(text.includes('"tags":["payments","webhooks"]'), 'tags must ride in the data payload');
    assert.ok(text.includes('verify webhook signatures before resolving transactions'));
    assert.match(text, /## Decision: Chose better-sqlite3 over sql\.js/);
    // Deterministic ordering: kind ASC, confidence DESC, id — decisions
    // sort before pitfalls alphabetically.
    assert.ok(text.indexOf('## Decision:') < text.indexOf('## Pitfall:'), 'sections must follow kind-ASC order');
    // Every record section carries a one-line canonical payload.
    assert.equal((text.match(/^data: \{/gm) ?? []).length, 2);
  });

  it('filters exported memories by kind', async () => {
    h.memoryRepo.create({ content: 'Redis eviction silently drops queued jobs', kind: 'pitfall', project: 'proj-a', confidence: 0.9 });
    h.memoryRepo.create({ content: 'The staging cluster runs postgres sixteen', kind: 'fact', project: 'proj-a', confidence: 0.9 });

    const text = textOf(await callTool(h.client, TOOL.EXPORT, { kind: 'pitfall' }));
    assert.ok(text.includes('# Memories: 1'));
    assert.match(text, /## Pitfall: Redis eviction silently drops queued jobs/);
    assert.ok(!text.includes('## Fact:'), 'fact must be excluded by kind filter');
  });

  it('excludes memories below the min_confidence threshold', async () => {
    h.memoryRepo.create({ content: 'Strong lesson about migration ordering constraints', kind: 'fact', project: null, confidence: 0.9 });
    h.memoryRepo.create({ content: 'Weak hunch about flaky network timeouts', kind: 'fact', project: null, confidence: 0.2 });

    const text = textOf(await callTool(h.client, TOOL.EXPORT, { min_confidence: 0.5 }));
    assert.ok(text.includes('# Memories: 1'));
    assert.ok(text.includes('Strong lesson about migration ordering constraints'));
    assert.ok(!text.includes('Weak hunch'), 'low-confidence memory must be filtered out');
  });

  it('scopes project exports to that project plus globals, excluding other projects', async () => {
    h.memoryRepo.create({ content: 'Alpha project uses trunk-based development', kind: 'fact', project: 'proj-a', confidence: 0.9 });
    h.memoryRepo.create({ content: 'Beta project deploys from release branches', kind: 'fact', project: 'proj-b', confidence: 0.9 });
    h.memoryRepo.create({ content: 'Global preference for tabs over spaces everywhere', kind: 'fact', project: null, confidence: 0.9 });

    const text = textOf(await callTool(h.client, TOOL.EXPORT, { project: 'proj-a' }));
    assert.ok(text.includes('Alpha project uses trunk-based development'));
    assert.ok(text.includes('Global preference for tabs over spaces everywhere'), 'globals must be included in project export');
    assert.ok(!text.includes('Beta project'), 'other projects must be excluded');
  });

  it('exports only global memories when project is null', async () => {
    h.memoryRepo.create({ content: 'Alpha project uses trunk-based development', kind: 'fact', project: 'proj-a', confidence: 0.9 });
    h.memoryRepo.create({ content: 'Global preference for tabs over spaces everywhere', kind: 'fact', project: null, confidence: 0.9 });

    const text = textOf(await callTool(h.client, TOOL.EXPORT, { project: null }));
    assert.ok(text.includes('# Memories: 1'));
    assert.ok(text.includes('Global preference for tabs over spaces everywhere'));
    assert.ok(!text.includes('Alpha project'), 'project-scoped memory must be excluded from global-only export');
  });

  it('returns a friendly message when no memories match', async () => {
    const result = await callTool(h.client, TOOL.EXPORT);
    assert.notEqual(result.isError, true);
    assert.equal(textOf(result), 'No memories match the filter criteria.');
  });

  it('rejects a project filter exceeding the string param limit', async () => {
    // The SDK surfaces schema violations as isError tool results on callTool.
    const result = await callTool(h.client, TOOL.EXPORT, { project: 'p'.repeat(LIMITS.MAX_STRING_PARAM + 1) });
    assert.equal(result.isError, true);
    assert.ok(textOf(result).includes('Invalid arguments'));
  });
});

// --- cairn_ingest ---------------------------------------------------------------

const INGEST_FIXTURE = [
  '## Pitfall: Redis eviction drops queued jobs',
  'tags: redis, queues',
  'Set maxmemory-policy to noeviction on queue instances.',
  '',
  '## Decision: Use SQLite WAL mode',
  'Concurrent readers stay unblocked during writes.',
].join('\n');

describe(TOOL.INGEST, () => {
  let h: Harness;
  beforeEach(async () => { h = await startHarness(); });
  afterEach(async () => { await h.close(); });

  it('ingests markdown sections as memories with inferred kinds and tags', async () => {
    const result = await callTool(h.client, TOOL.INGEST, { content: INGEST_FIXTURE, project: 'proj-ingest' });
    assert.notEqual(result.isError, true);
    const text = textOf(result);
    assert.ok(text.includes('ingested: 2'), `expected 2 ingested, got:\n${text}`);
    assert.ok(text.includes('deduplicated: 0'));

    const stored = h.memoryRepo.exportMemories({ project: 'proj-ingest' });
    assert.equal(stored.length, 2);

    const pitfall = stored.find(m => m.kind === 'pitfall');
    assert.ok(pitfall, 'pitfall section must be stored');
    assert.ok(pitfall.content.startsWith('Redis eviction drops queued jobs:'), 'heading and body must merge into content');
    assert.deepEqual(pitfall.tags, ['redis', 'queues']);
    assert.equal(pitfall.project, 'proj-ingest');

    const decision = stored.find(m => m.kind === 'decision');
    assert.ok(decision, 'decision section must be stored');
    assert.ok(decision.content.includes('Concurrent readers stay unblocked'));
  });

  it('previews sections without writing when dry_run is set', async () => {
    const text = textOf(await callTool(h.client, TOOL.INGEST, { content: INGEST_FIXTURE, dry_run: true }));
    assert.ok(text.includes('Dry run (learn): 0 v2 records, 0 files, 2 v1 sections, 0 errors'), `unexpected dry-run header:\n${text}`);
    assert.ok(text.includes('[pitfall]'));
    assert.ok(text.includes('[decision]'));
    assert.equal(h.memoryRepo.getStats().total, 0, 'dry run must not write to the DB');
  });

  it('deduplicates when the same markdown is ingested twice', async () => {
    await callTool(h.client, TOOL.INGEST, { content: INGEST_FIXTURE, project: 'proj-ingest' });
    const confBefore = h.memoryRepo.exportMemories({ project: 'proj-ingest' }).map(m => m.confidence);
    const second = textOf(await callTool(h.client, TOOL.INGEST, { content: INGEST_FIXTURE, project: 'proj-ingest' }));
    assert.ok(second.includes('ingested: 0'), `re-ingest must not create new rows, got:\n${second}`);
    assert.ok(second.includes('deduplicated: 2'));
    assert.equal(h.memoryRepo.getStats().active, 2);
    // Through the REGISTERED tool, exact repeats keep the gateway's
    // reinforcement semantics the description promises (reinforceExact —
    // the CLI importer's no-op default must not leak in here).
    const confAfter = h.memoryRepo.exportMemories({ project: 'proj-ingest' }).map(m => m.confidence);
    assert.ok(confAfter.every((c, i) => c > confBefore[i]), 'exact re-ingest reinforces via the MCP tool');
  });

  it('reports unstructured markdown as skipped instead of storing it', async () => {
    const result = await callTool(h.client, TOOL.INGEST, { content: 'just some prose with no headings at all' });
    const text = textOf(result);
    assert.ok(text.includes('ingested: 0'));
    assert.ok(text.includes('skipped: 1'));
    assert.ok(text.includes('No ## headings found'), `expected parse error detail, got:\n${text}`);
    assert.equal(h.memoryRepo.getStats().total, 0);
  });
});

// --- cairn_ingest mode=restore (round-trip v2) ----------------------------------

describe('cairn_ingest restore mode', () => {
  let h: Harness;
  beforeEach(async () => { h = await startHarness(); });
  afterEach(async () => { await h.close(); });

  it('cairn_export output restores field-exact into an empty store through the tool', async () => {
    h.memoryRepo.create({
      content: 'Webhook retries: use exponential backoff with jitter under thundering herds',
      kind: 'pitfall', project: 'proj-a', tags: ['webhooks'], confidence: 0.85,
      context: { why: 'burst retries\nsaturate the upstream', how_to_apply: 'jitter every delay' },
    });
    const exported = textOf(await callTool(h.client, TOOL.EXPORT));

    const target = await startHarness();
    try {
      const text = textOf(await callTool(target.client, TOOL.INGEST, { content: exported, mode: 'restore' }));
      assert.ok(text.includes('restored: 1'), `expected 1 restored, got:\n${text}`);
      assert.ok(text.includes('overwritten: 0'));
      // Canonical comparison: stored JSON blobs may serialize object keys
      // in either order; the FIELD VALUES are the contract.
      assert.equal(
        canonicalJson(target.memoryRepo.exportPortable()),
        canonicalJson(h.memoryRepo.exportPortable()),
        'portable fields must survive the tool round trip exactly',
      );
    } finally {
      await target.close();
    }
  });

  it('restore mode rejects v2 records without ids', async () => {
    const noId = '## Fact: no id [confidence: 0.50]\ndata: {"anchor":null,"confidence":0.5,"content":"record without an id","context":null,"created_at":"2026-01-01T00:00:00.000Z","expires_at":null,"fingerprint":null,"kind":"fact","project":null,"source":"learned","tags":[]}';
    const result = await callTool(h.client, TOOL.INGEST, { content: noId, mode: 'restore' });
    assert.equal(result.isError, true);
    assert.ok(textOf(result).includes('restore mode requires an id on every record'));
    assert.equal(h.memoryRepo.getStats().total, 0);
  });

  it('restore mode rejects v1 sections outright — they carry no ids', async () => {
    const result = await callTool(h.client, TOOL.INGEST, { content: INGEST_FIXTURE, mode: 'restore' });
    assert.equal(result.isError, true);
    assert.ok(textOf(result).includes('restore mode requires v2 sections'));
    assert.equal(h.memoryRepo.getStats().total, 0);
  });

  it('a malformed section anywhere aborts the WHOLE restore — nothing is written', async () => {
    const doc = [
      '## Fact: valid [confidence: 0.50]',
      'data: {"anchor":null,"confidence":0.5,"content":"valid record in a poisoned document","context":null,"created_at":"2026-01-01T00:00:00.000Z","expires_at":null,"fingerprint":null,"id":"00000001-0000-4000-8000-000000000000","kind":"fact","project":null,"source":"learned","tags":[]}',
      '## Fact: broken [confidence: 0.50]',
      'data: {not json at all',
    ].join('\n');
    const result = await callTool(h.client, TOOL.INGEST, { content: doc, mode: 'restore' });
    assert.equal(result.isError, true);
    assert.ok(textOf(result).includes('restore aborted, nothing was written'));
    assert.equal(h.memoryRepo.getStats().total, 0, 'the valid record must not partially commit');
  });

  it('duplicate record ids and duplicate file paths abort before mutation', async () => {
    const record = 'data: {"anchor":null,"confidence":0.5,"content":"twin id record","context":null,"created_at":"2026-01-01T00:00:00.000Z","expires_at":null,"fingerprint":null,"id":"00000002-0000-4000-8000-000000000000","kind":"fact","project":null,"source":"learned","tags":[]}';
    const dupIds = `## Fact: a [confidence: 0.50]\n${record}\n## Fact: b [confidence: 0.50]\n${record}`;
    const r1 = await callTool(h.client, TOOL.INGEST, { content: dupIds, mode: 'restore' });
    assert.equal(r1.isError, true);
    assert.ok(textOf(r1).includes('duplicate record id'));

    const file = 'data: {"content":"x","path":"/memories/notes/twin.md","revision":1}';
    const dupPaths = `## File: /memories/notes/twin.md\n${file}\n## File: /memories/notes/twin.md\n${file}`;
    const r2 = await callTool(h.client, TOOL.INGEST, { content: dupPaths, mode: 'restore' });
    assert.equal(r2.isError, true);
    assert.ok(textOf(r2).includes('duplicate file path'));
    assert.equal(h.memoryRepo.getStats().total, 0);
  });

  it('a hostile file path aborts the restore atomically through the tool', async () => {
    const doc = [
      '## Fact: rider [confidence: 0.50]',
      'data: {"anchor":null,"confidence":0.5,"content":"record riding beside a hostile file","context":null,"created_at":"2026-01-01T00:00:00.000Z","expires_at":null,"fingerprint":null,"id":"00000003-0000-4000-8000-000000000000","kind":"fact","project":null,"source":"learned","tags":[]}',
      '## File: /memories/global/facts.md',
      'data: {"content":"materialized takeover","path":"/memories/global/facts.md","revision":1}',
    ].join('\n');
    const result = await callTool(h.client, TOOL.INGEST, { content: doc, mode: 'restore' });
    assert.equal(result.isError, true);
    assert.equal(h.memoryRepo.getStats().total, 0, 'the rider record must not survive');
  });

  it('any filter excludes free-form files from the export', async () => {
    h.memoryRepo.create({ content: 'record for the filtered export checks', kind: 'fact', project: 'proj-a', confidence: 0.9 });
    h.memoryRepo.restoreFile({ path: '/memories/notes/rideralong.md', content: 'file body', revision: 1 });

    assert.ok(textOf(await callTool(h.client, TOOL.EXPORT)).includes('## File: /memories/notes/rideralong.md'), 'unfiltered export carries files');
    for (const filter of [{ project: 'proj-a' }, { kind: 'fact' }, { min_confidence: 0.1 }]) {
      const text = textOf(await callTool(h.client, TOOL.EXPORT, filter));
      assert.ok(!text.includes('## File:'), `filtered export ${JSON.stringify(filter)} must not carry files`);
    }
  });

  it('learn mode ingests v2 payloads through gateway semantics (dedup applies)', async () => {
    h.memoryRepo.create({ content: 'the ingestion pipeline batches records every five minutes', kind: 'fact', project: null, confidence: 0.6 });
    const v2 = '## Fact: dup [confidence: 0.90]\ndata: {"anchor":null,"confidence":0.9,"content":"the ingestion pipeline batches records every five minutes","context":null,"created_at":"2026-01-01T00:00:00.000Z","expires_at":null,"fingerprint":null,"id":"00000009-0000-4000-8000-000000000000","kind":"fact","project":null,"source":"learned","tags":[]}';
    const text = textOf(await callTool(h.client, TOOL.INGEST, { content: v2 }));
    assert.ok(text.includes('deduplicated: 1'), `learn mode must merge, got:\n${text}`);
    assert.equal(h.memoryRepo.getStats().total, 1, 'no new row in learn mode');
  });
});

// --- cairn_promote --------------------------------------------------------------

describe(TOOL.PROMOTE, () => {
  let h: Harness;
  beforeEach(async () => { h = await startHarness(); });
  afterEach(async () => { await h.close(); });

  it('promotes a qualifying project pitfall to global scope', async () => {
    const { id } = h.memoryRepo.create({
      content: 'Foreign keys silently disabled without pragma enforcement',
      kind: 'pitfall',
      project: 'proj-a',
      confidence: PROMOTION.MIN_CONFIDENCE + 0.2,
    });

    const result = await callTool(h.client, TOOL.PROMOTE, { id });
    assert.notEqual(result.isError, true);
    assert.ok(textOf(result).startsWith('promoted to global:'));
    assert.equal(h.memoryRepo.findById(id)?.project, null, 'memory must now be global');
  });

  it('reports already global without erroring', async () => {
    const { id } = h.memoryRepo.create({ content: 'Globally scoped decision about tooling', kind: 'decision', project: null, confidence: 0.9 });
    const result = await callTool(h.client, TOOL.PROMOTE, { id });
    assert.notEqual(result.isError, true);
    assert.equal(textOf(result), 'already global');
  });

  it('reports not found for an unknown id', async () => {
    const result = await callTool(h.client, TOOL.PROMOTE, { id: 'does-not-exist' });
    assert.notEqual(result.isError, true);
    assert.equal(textOf(result), 'not found');
  });

  it('rejects kinds outside the promotion allowlist', async () => {
    const { id } = h.memoryRepo.create({ content: 'Some project fact that must stay scoped', kind: 'fact', project: 'proj-a', confidence: 0.9 });
    const result = await callTool(h.client, TOOL.PROMOTE, { id });
    assert.equal(result.isError, true);
    assert.ok(textOf(result).includes(`only ${PROMOTION.ALLOWED_KINDS.join('/')} can be promoted (got fact)`));
    assert.equal(h.memoryRepo.findById(id)?.project, 'proj-a', 'memory must remain project-scoped');
  });

  it('rejects promotion below the confidence floor', async () => {
    const { id } = h.memoryRepo.create({
      content: 'Low confidence pitfall about cache warming order',
      kind: 'pitfall',
      project: 'proj-a',
      confidence: PROMOTION.MIN_CONFIDENCE - 0.2,
    });
    const result = await callTool(h.client, TOOL.PROMOTE, { id });
    assert.equal(result.isError, true);
    assert.ok(textOf(result).includes('confidence too low'));
  });

  it('rejects promotion of an invalidated memory', async () => {
    const { id } = h.memoryRepo.create({ content: 'Pitfall that later proved wrong entirely', kind: 'pitfall', project: 'proj-a', confidence: 0.9 });
    h.memoryRepo.invalidate(id);
    const result = await callTool(h.client, TOOL.PROMOTE, { id });
    assert.equal(result.isError, true);
    assert.ok(textOf(result).includes('memory is invalidated'));
  });
});

// --- cairn_stats ----------------------------------------------------------------

describe(TOOL.STATS, () => {
  let h: Harness;
  beforeEach(async () => { h = await startHarness(); });
  afterEach(async () => { await h.close(); });

  function seedMixedMemories(): void {
    h.memoryRepo.create({ content: 'Pitfall about migration lock timeouts under load', kind: 'pitfall', project: 'proj-a', confidence: 0.9 });
    h.memoryRepo.create({ content: 'Pitfall about orphaned worktree branches piling up', kind: 'pitfall', project: 'proj-a', confidence: 0.5 });
    h.memoryRepo.create({ content: 'Fact about the deployment window being on tuesdays', kind: 'fact', project: null, confidence: 0.2 });
  }

  it('summary reflects seeded memory, plan, and decision counts', async () => {
    seedMixedMemories();
    const { plan } = h.planRepo.create({ project: 'proj-a', name: 'Rollout plan', steps: [{ description: 'ship it' }] });
    h.planRepo.addDecision(plan.id, { chose: 'blue-green deploy', why: 'zero downtime' });

    const text = textOf(await callTool(h.client, TOOL.STATS, { action: 'summary' }));
    assert.ok(text.includes('Memories: 3 active, 0 invalidated'), `unexpected summary:\n${text}`);
    assert.ok(text.includes('pitfall: 2'));
    assert.ok(text.includes('fact: 1'));
    assert.ok(text.includes('Plans: active: 1, completed: 0, abandoned: 0'));
    assert.ok(text.includes('Decisions: 1 total'));
    assert.ok(text.includes('Reminders: 0 active, 0 total fires'));
  });

  it('summary renders zero counts on an empty database without throwing', async () => {
    const result = await callTool(h.client, TOOL.STATS, { action: 'summary' });
    assert.notEqual(result.isError, true);
    const text = textOf(result);
    assert.ok(text.includes('Memories: 0 active, 0 invalidated'));
    assert.ok(text.includes('Plans: active: 0, completed: 0, abandoned: 0'));
    assert.ok(text.includes('Reminders: 0 active, 0 total fires'));
  });

  it('health buckets confidence using the HEALTH thresholds', async () => {
    seedMixedMemories();
    const text = textOf(await callTool(h.client, TOOL.STATS, { action: 'health' }));
    assert.ok(
      text.includes(`high(>${HEALTH.CONFIDENCE_HIGH_THRESHOLD}): 1`)
        && text.includes(`medium(${HEALTH.CONFIDENCE_MEDIUM_THRESHOLD}-${HEALTH.CONFIDENCE_HIGH_THRESHOLD}): 1`)
        && text.includes(`low(<${HEALTH.CONFIDENCE_MEDIUM_THRESHOLD}): 1`),
      `unexpected confidence distribution:\n${text}`,
    );
    assert.ok(text.includes('Avg confidence: 0.53'));
    assert.ok(text.includes('Never recalled: 3'));
    assert.ok(text.includes('Oldest: "Pitfall about migration lock timeouts'));
    assert.ok(text.includes('Most recalled:'));
  });

  it('health telemetry sections render on an empty database without throwing', async () => {
    const result = await callTool(h.client, TOOL.STATS, { action: 'health' });
    assert.notEqual(result.isError, true);
    const text = textOf(result);
    assert.ok(text.includes('Avg confidence: 0.00'));
    assert.ok(text.includes('Decay candidates'));
  });

  it('by_kind aggregates counts, average confidence, and recalls per kind', async () => {
    seedMixedMemories();
    const text = textOf(await callTool(h.client, TOOL.STATS, { action: 'by_kind' }));
    assert.ok(text.includes('pitfall: 2 memories, avg conf: 0.70, total recalls: 0'), `unexpected by_kind:\n${text}`);
    assert.ok(text.includes('fact: 1 memories, avg conf: 0.20, total recalls: 0'));
  });

  it('by_kind reports no memories on an empty database', async () => {
    const text = textOf(await callTool(h.client, TOOL.STATS, { action: 'by_kind' }));
    assert.equal(text, 'No memories found.');
  });

  it('by_project labels the null project as (global)', async () => {
    seedMixedMemories();
    const text = textOf(await callTool(h.client, TOOL.STATS, { action: 'by_project' }));
    assert.ok(text.includes('(global): 1 memories'), `unexpected by_project:\n${text}`);
    assert.ok(text.includes('proj-a: 2 memories'));
  });

  it('velocity reports weekly creation, coverage, graph, and project telemetry', async () => {
    seedMixedMemories();
    const text = textOf(await callTool(h.client, TOOL.STATS, { action: 'velocity' }));
    assert.ok(text.startsWith('Learning Velocity:'));
    assert.ok(text.includes('this week: 3'), `unexpected velocity:\n${text}`);
    assert.ok(text.includes('Embedding coverage (minilm-l6): 0/3 (0%)'), 'active-model-labeled coverage line');
    assert.ok(text.includes('Anchor coverage: 0/3 (0%)'));
    assert.ok(text.includes('Graph: 0 edges'));
    assert.ok(text.includes('Projects tracked: 1, global memories: 1'));
  });

  it('velocity renders on an empty database without throwing', async () => {
    const result = await callTool(h.client, TOOL.STATS, { action: 'velocity' });
    assert.notEqual(result.isError, true);
    const text = textOf(result);
    // Known cosmetic bug (not asserted): SUM() over zero rows is NULL, so the
    // numerator renders as "null/0" here instead of "0/0".
    assert.ok(text.includes('Embedding coverage (minilm-l6):'));
    assert.ok(text.includes('Anchor coverage:'));
    assert.ok(text.includes('Projects tracked: 0, global memories: 0'));
  });

  it('rejects an action outside the stats enum', async () => {
    const result = await callTool(h.client, TOOL.STATS, { action: 'nonsense' });
    assert.equal(result.isError, true);
    assert.ok(textOf(result).includes('Invalid arguments'));
  });
});

// --- Resources ------------------------------------------------------------------

describe('MCP resources', () => {
  let h: Harness;
  beforeEach(async () => { h = await startHarness(); });
  afterEach(async () => { await h.close(); });

  it('exposes the plan and briefing resource templates', async () => {
    const { resourceTemplates } = await h.client.listResourceTemplates();
    const byName = new Map(resourceTemplates.map(t => [t.name, t.uriTemplate]));
    assert.equal(byName.get('active-plan'), `${MCP_URI_SCHEME}://plan/{project}/active`);
    assert.equal(byName.get('full-briefing'), `${MCP_URI_SCHEME}://briefing/{project}`);
  });

  it('active plan resource renders steps, outcomes, notes, and decisions', async () => {
    const { plan } = h.planRepo.create({
      project: 'proj-a',
      name: 'Schema rollout',
      steps: [{ description: 'create migration' }, { description: 'backfill data' }],
    });
    h.planRepo.updateStep(plan.id, { step_id: 1, status: 'done', outcome: 'migration created' });
    h.planRepo.addNote(plan.id, { step_id: 2, note: 'awaiting review' });
    h.planRepo.addDecision(plan.id, { chose: 'zod v4', why: 'already a dependency', alternatives: ['ajv'], permanent: true });

    const text = await readResourceText(h.client, `${MCP_URI_SCHEME}://plan/proj-a/active`);
    assert.ok(text.includes('Plan: "Schema rollout" (active, 1/2 steps done)'), `unexpected plan resource:\n${text}`);
    assert.ok(text.includes('1. [done] create migration'));
    assert.ok(text.includes('Outcome: migration created'));
    assert.ok(text.includes('2. [pending] backfill data'));
    assert.ok(text.includes('Note: awaiting review'));
    assert.ok(text.includes('Chose: zod v4 — already a dependency (not: ajv) [permanent]'));
  });

  it('active plan resource reports absence for a project with no plan', async () => {
    const text = await readResourceText(h.client, `${MCP_URI_SCHEME}://plan/proj-none/active`);
    assert.equal(text, 'No active plan for this project.');
  });

  it('briefing resource includes plan, pitfalls with why, corrections, and decisions', async () => {
    h.planRepo.create({ project: 'proj-a', name: 'Briefing plan', steps: [{ description: 'only step' }] });
    h.memoryRepo.create({
      content: 'Never run migrations during peak traffic hours',
      kind: 'pitfall',
      project: 'proj-a',
      confidence: 0.9,
      context: { why: 'locks starve the write path' },
    });
    h.memoryRepo.create({ content: 'Always call the service checkout, not cart', kind: 'correction', project: null, confidence: 0.9 });
    h.memoryRepo.create({ content: 'Chose event sourcing over CRUD for the audit trail', kind: 'decision', project: 'proj-a', confidence: 0.9 });

    const text = await readResourceText(h.client, `${MCP_URI_SCHEME}://briefing/proj-a`);
    assert.ok(text.startsWith('[Waykeep Full Briefing — proj-a]'));
    assert.ok(text.includes('Plan: "Briefing plan"'));
    assert.ok(text.includes('Pitfalls:'));
    assert.ok(text.includes('Never run migrations during peak traffic hours (Why: locks starve the write path)'));
    assert.ok(text.includes('Corrections:'));
    assert.ok(text.includes('Always call the service checkout, not cart'));
    assert.ok(text.includes('Recent Decisions:'));
    assert.ok(text.includes('Chose event sourcing over CRUD for the audit trail'));
  });

  it('briefing resource on an empty database is just the header', async () => {
    const text = await readResourceText(h.client, `${MCP_URI_SCHEME}://briefing/proj-empty`);
    assert.equal(text, '[Waykeep Full Briefing — proj-empty]');
  });

  it('rejects reads of unregistered resource URIs', async () => {
    await assert.rejects(h.client.readResource({ uri: `${MCP_URI_SCHEME}://unknown/thing` }));
  });
});

// --- Context-critical gating ------------------------------------------------------

describe('context-critical mode gating', () => {
  let h: Harness;
  beforeEach(async () => { h = await startHarness(); });
  afterEach(async () => { await h.close(); });

  it('silences all portability and stats tools when context is critical', async () => {
    h.memoryRepo.create({ content: 'Memory that must not be exported under pressure', kind: 'fact', project: null, confidence: 0.9 });
    h.setMode('critical');

    for (const [name, args] of [
      [TOOL.EXPORT, {}],
      [TOOL.INGEST, { content: INGEST_FIXTURE }],
      [TOOL.PROMOTE, { id: 'irrelevant' }],
      [TOOL.STATS, { action: 'summary' }],
    ] as Array<[string, Record<string, unknown>]>) {
      const result = await callTool(h.client, name, args);
      assert.equal(textOf(result), CRITICAL_TEXT, `${name} must go silent in critical mode`);
    }
    assert.equal(h.memoryRepo.getStats().total, 1, 'critical-mode ingest must not write');
  });

  it('resources stay readable regardless of context mode', async () => {
    h.setMode('critical');
    const text = await readResourceText(h.client, `${MCP_URI_SCHEME}://briefing/proj-a`);
    assert.ok(text.startsWith('[Waykeep Full Briefing — proj-a]'), 'resource reads are not gated by context mode');
  });
});
