/**
 * cairn_recall rerank path at the MCP level (W2 slice 4 review) — real
 * registration + in-memory client transport, fake reranker via the
 * injectable seam. Proves: successful reorder, honest rrf_score labeling,
 * visible fallback labeling, and recall side effects ONLY for the
 * returned top-k (never for pool candidates or graph neighbors).
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type Database from 'better-sqlite3';

import { openDatabase } from '../src/db/connection.js';
import { MemoryRepository } from '../src/db/memory-repository.js';
import { EdgeRepository } from '../src/db/edge-repository.js';
import { registerMemoryTools, type RerankerImpl } from '../src/mcp/tools/memory-tools.js';

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

let db: Database.Database;
let repo: MemoryRepository;
let client: Client;
let server: McpServer;

async function startWith(rerankerImpl: RerankerImpl): Promise<void> {
  db = openDatabase({ dbPath: ':memory:' });
  repo = new MemoryRepository(db);
  server = new McpServer({ name: 'cairn-rerank-test', version: '0.0.0-test' });
  registerMemoryTools(server, repo, () => 'normal', undefined, undefined, undefined, rerankerImpl);
  client = new Client({ name: 'test-client', version: '0.0.0-test' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
}

afterEach(async () => {
  await client.close();
  await server.close();
  db.close();
});

/** Three memories in a deterministic RRF order for the query
 *  "crimson harbor beacon": m1 (3 token matches) > m2 (2) > m3 (1). */
function seed(): { m1: string; m2: string; m3: string } {
  const m1 = repo.create({ content: 'crimson harbor beacon guides the night ferries', kind: 'fact', skipDedup: true }).id;
  const m2 = repo.create({ content: 'crimson harbor holds the winter regatta', kind: 'fact', skipDedup: true }).id;
  const m3 = repo.create({ content: 'crimson banners lined the parade route', kind: 'fact', skipDedup: true }).id;
  return { m1, m2, m3 };
}

const recallCount = (id: string): number =>
  (db.prepare('SELECT recall_count AS n FROM memories WHERE id = ?').get(id) as { n: number }).n;

async function callRecall(): Promise<string> {
  const result = await client.callTool({
    name: 'cairn_recall',
    arguments: { query: 'crimson harbor beacon', max_results: 2 },
  }) as unknown as ToolResult;
  return result.content.map(c => c.text).join('\n');
}

describe('cairn_recall — rerank path (MCP level, fake reranker)', () => {
  beforeEach(async () => {
    await startWith({
      isEnabled: () => true,
      rerank: async (_query, candidates) => [...candidates].reverse(),
    });
  });

  it('reorders results, labels the score as rrf_score, and marks NOTHING (read-only recall)', async () => {
    const { m1, m2, m3 } = seed();
    const text = await callRecall();

    // Reversed pool [m3, m2, m1] → top-2 is [m3, m2]
    const lines = text.split('\n').filter(l => l.startsWith('•'));
    assert.equal(lines.length, 2);
    assert.match(lines[0], /crimson banners lined the parade route/, 'reranker order wins');
    assert.match(lines[1], /winter regatta/);
    assert.ok(!text.includes('night ferries'), 'RRF favorite pushed out by the reranker');
    assert.match(text, /rrf_score:/, 'score labeled as the RRF fusion score, not a reranker score');
    assert.ok(!text.includes('[rerank unavailable'), 'no fallback label on success');

    // Step 7 (M5): cairn_recall is read-only in fact — no recall-stat
    // writes for ANY candidate, returned or not.
    assert.equal(recallCount(m3), 0, 'returned id must NOT be marked — diagnostic recall is inert');
    assert.equal(recallCount(m2), 0, 'returned id must NOT be marked — diagnostic recall is inert');
    assert.equal(recallCount(m1), 0, 'pool candidate outside top-k must NOT be marked');
  });

  it('graph neighbors surface unmarked and never carry the rrf_score label', async () => {
    const { m3 } = seed();
    // Connected but off-query: only reachable through the graph edge.
    const neighbor = repo.create({ content: 'quiet meadow observatory stargazing notes', kind: 'fact', skipDedup: true }).id;
    new EdgeRepository(db).createEdge(m3, neighbor, 'informs', 0.9);

    const text = await callRecall();
    const neighborLine = text.split('\n').find(l => l.includes('quiet meadow observatory'));
    assert.ok(neighborLine, 'graph neighbor surfaces via enrichment');
    assert.match(neighborLine!, /graph_score:/, 'neighbor labeled with its synthetic graph score');
    assert.ok(!neighborLine!.includes('rrf_score:'), 'neighbor never claims an RRF fusion score');
    assert.equal(recallCount(neighbor), 0, 'supplemental neighbor gets NO recall side effects');
  });
});

describe('cairn_recall — rerank fallback (MCP level)', () => {
  beforeEach(async () => {
    await startWith({
      isEnabled: () => true,
      rerank: async () => null,
    });
  });

  it('labels the fallback visibly, keeps RRF order, and still marks nothing (read-only recall)', async () => {
    const { m1, m2, m3 } = seed();
    const text = await callRecall();

    assert.match(text, /\[rerank unavailable — results in RRF order\]/, 'fallback must be visible');
    const lines = text.split('\n').filter(l => l.startsWith('•'));
    assert.match(lines[0], /night ferries/, 'RRF order preserved on fallback');
    assert.match(text, / score: /, 'fallback shows the honest plain score label');
    assert.ok(!text.includes('rrf_score:'), 'no rerank-mode label when rerank did not run');

    // Step 7 (M5): the fallback path is read-only too.
    assert.equal(recallCount(m1), 0);
    assert.equal(recallCount(m2), 0);
    assert.equal(recallCount(m3), 0);
  });
});
