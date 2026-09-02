/**
 * Embedding lifecycle — typed degraded status (remediation plan, step 5).
 *
 * The choice of record: cairn_recall NEVER waits on model readiness
 * (zero-wait; the bounded-barrier alternative was rejected — model load is
 * multi-second, a barrier taxes every cold call). Instead the retrieval
 * path is a TYPED contract: every normal-mode response names its path from
 * RETRIEVAL_PATHS, cold-start calls are explicitly labeled degraded, and
 * the strings have one source so the label cannot drift into silence.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { openDatabase } from '../src/db/connection.js';
import { MemoryRepository } from '../src/db/memory-repository.js';
import { registerMemoryTools } from '../src/mcp/tools/memory-tools.js';
import { setSessionProjectForTests } from '../src/utils/session-project.js';
import { setEmbeddingTestHooks, embeddingToBuffer } from '../src/utils/embeddings.js';
import { RETRIEVAL_PATHS } from '../src/constants/index.js';
import { TOOL } from '../src/constants/mcp.js';

const SESSION_PROJECT = 'proj-embedding-lifecycle';
const DIM = 384;

/** Deterministic unit vector so hybrid cosine ranking is reproducible. */
const unitVec = (seed: number): Float32Array => {
  const v = new Float32Array(DIM);
  for (let i = 0; i < DIM; i++) v[i] = Math.sin(seed * 31 + i);
  const norm = Math.hypot(...v);
  for (let i = 0; i < DIM; i++) v[i] /= norm;
  return v;
};

let db: Database.Database;
let repo: MemoryRepository;
let client: Client;

beforeEach(async () => {
  db = openDatabase({ dbPath: ':memory:' });
  repo = new MemoryRepository(db);
  setSessionProjectForTests(SESSION_PROJECT);
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerMemoryTools(server, repo, () => 'normal');
  client = new Client({ name: 'test-client', version: '0.0.0' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(ct), server.connect(st)]);
});

afterEach(async () => {
  setEmbeddingTestHooks(undefined);
  setSessionProjectForTests(undefined);
  await client.close();
  db.close();
});

const recall = async (query: string) => {
  const res = await client.callTool({ name: TOOL.RECALL, arguments: { query } }) as {
    content: Array<{ type: string; text?: string }>; isError?: boolean;
  };
  return { text: res.content[0]?.text ?? '', isError: res.isError === true };
};

describe('embedding lifecycle — typed degraded status (step 5)', () => {
  it('the typed contract itself: exactly two paths, degraded carries a compact marker', () => {
    assert.deepEqual(Object.keys(RETRIEVAL_PATHS).sort(), ['fts_degraded', 'hybrid']);
    assert.ok(RETRIEVAL_PATHS.hybrid.header.length > 0);
    assert.ok(RETRIEVAL_PATHS.fts_degraded.header.includes('FTS-only'),
      'the degraded header must say what actually ran');
    assert.equal(RETRIEVAL_PATHS.hybrid.compactMarker, null);
    assert.ok(RETRIEVAL_PATHS.fts_degraded.compactMarker,
      'degradation must stay visible even in minimal mode');
    assert.notEqual(RETRIEVAL_PATHS.hybrid.header, RETRIEVAL_PATHS.fts_degraded.header);
  });

  it('GATE: cold-start recall is explicitly labeled degraded — zero wait, no silence', async () => {
    repo.create({ content: 'lifecycle probe row about connection pooling', kind: 'fact', project: SESSION_PROJECT, confidence: 0.8 });
    const t0 = Date.now();
    const result = await recall('connection pooling');
    const elapsed = Date.now() - t0;
    assert.ok(result.text.includes(`[retrieval: ${RETRIEVAL_PATHS.fts_degraded.header}]`),
      `cold-start must carry the typed degraded header, got: ${result.text.split('\n')[0]}`);
    assert.ok(result.text.includes('lifecycle probe row'), 'FTS results still served');
    assert.ok(elapsed < 500, `zero-wait contract: no readiness barrier of ANY size (took ${elapsed}ms)`);
  });

  it('GATE: cold-start recall is stable — repeated calls give identical output', async () => {
    repo.create({ content: 'stability row one about migration order', kind: 'fact', project: SESSION_PROJECT, confidence: 0.8 });
    repo.create({ content: 'stability row two about migration order', kind: 'fact', project: SESSION_PROJECT, confidence: 0.6 });
    const first = await recall('migration order');
    for (let i = 0; i < 3; i++) {
      const again = await recall('migration order');
      assert.equal(again.text, first.text, 'cold-start ranking must not drift call-to-call');
    }
  });

  it('GATE: the warm path labels hybrid — the header tracks what actually ran', async () => {
    const docVec = unitVec(7);
    repo.create({
      content: 'warm hybrid probe row about index rebuilds',
      kind: 'fact', project: SESSION_PROJECT, confidence: 0.8,
      embedding: embeddingToBuffer(docVec),
    });
    setEmbeddingTestHooks({ isReady: () => true, embedQuery: async () => unitVec(7) });
    const result = await recall('index rebuilds');
    assert.ok(result.text.includes(`[retrieval: ${RETRIEVAL_PATHS.hybrid.header}]`),
      `warm recall must carry the typed hybrid header, got: ${result.text.split('\n')[0]}`);
    assert.ok(result.text.includes('warm hybrid probe row'));
  });

  it('GATE: no silent path — every normal-mode response carries exactly one typed header', async () => {
    // Zero-result path, cold:
    const empty = await recall('zzz nothing matches this query zzz');
    assert.ok(empty.text.includes(`[retrieval: ${RETRIEVAL_PATHS.fts_degraded.header}]`),
      'even the zero-result path names its retrieval path');
    // Result path, cold — header appears exactly once and is one of the two types:
    repo.create({ content: 'header exactly once probe row', kind: 'fact', project: SESSION_PROJECT, confidence: 0.8 });
    const res = await recall('header exactly once probe');
    const headers = res.text.split('\n').filter(l => l.startsWith('[retrieval: '));
    assert.equal(headers.length, 1, `exactly one header, got: ${headers.length}`);
    const known = Object.values(RETRIEVAL_PATHS).map(p => `[retrieval: ${p.header}]`);
    assert.ok(known.includes(headers[0]), `header must be one of the typed strings, got: ${headers[0]}`);
  });

  it('a ready model whose embedQuery THROWS degrades to the labeled FTS path', async () => {
    // isEmbeddingReady true but the embed call fails (OOM, model corruption):
    // the handler's catch falls back to FTS — and the label must say so,
    // because no query embedding was produced.
    repo.create({ content: 'throwing query probe row about retry budgets', kind: 'fact', project: SESSION_PROJECT, confidence: 0.8 });
    setEmbeddingTestHooks({ isReady: () => true, embedQuery: async () => { throw new Error('boom'); } });
    const result = await recall('retry budgets');
    assert.ok(result.text.includes(`[retrieval: ${RETRIEVAL_PATHS.fts_degraded.header}]`),
      'a failed query embed is a degraded call and must be labeled as one');
    assert.ok(result.text.includes('throwing query probe row'));
  });

  it('minimal mode: zero-result cold response still carries the compact degraded marker', async () => {
    // A separate server registered in minimal mode — the degraded marker
    // must survive even the emptiest, most compressed response.
    const mdb = openDatabase({ dbPath: ':memory:' });
    const mrepo = new MemoryRepository(mdb);
    const mserver = new McpServer({ name: 'test-min', version: '0.0.0' });
    registerMemoryTools(mserver, mrepo, () => 'minimal');
    const mclient = new Client({ name: 'test-min-client', version: '0.0.0' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([mclient.connect(ct), mserver.connect(st)]);
    try {
      const res = await mclient.callTool({ name: TOOL.RECALL, arguments: { query: 'zzz nothing at all zzz' } }) as {
        content: Array<{ type: string; text?: string }>;
      };
      const text = res.content[0]?.text ?? '';
      assert.ok(text.includes(RETRIEVAL_PATHS.fts_degraded.compactMarker as string),
        `minimal-mode zero-result must keep the compact marker, got: ${text}`);
    } finally {
      await mclient.close();
      mdb.close();
    }
  });

  it('learn under a total warm seam embeds with the provided hook — never the real pipeline', async () => {
    setEmbeddingTestHooks({ isReady: () => true, embedQuery: async () => unitVec(3), embed: async () => unitVec(3) });
    const res = await client.callTool({ name: TOOL.LEARN, arguments: {
      kind: 'fact', content: 'warm learn probe row with hooked embedding',
    } }) as { content: Array<{ type: string; text?: string }>; isError?: boolean };
    assert.notEqual(res.isError, true);
    const row = db.prepare("SELECT embedding FROM memories WHERE content LIKE 'warm learn probe%'").get() as { embedding: Buffer | null };
    assert.ok(row.embedding, 'the hooked embed() supplies the vector');
  });

  it('learn under a PARTIAL warm seam degrades to embedding-less — the seam is total, no real load', async () => {
    // isReady lies true but embed() is not provided: the seam throws, the
    // learn handler catches, the row lands without an embedding — and no
    // real pipeline load can ever start inside a hooked test.
    setEmbeddingTestHooks({ isReady: () => true, embedQuery: async () => unitVec(3) });
    const res = await client.callTool({ name: TOOL.LEARN, arguments: {
      kind: 'fact', content: 'partial seam probe row without embed hook',
    } }) as { content: Array<{ type: string; text?: string }>; isError?: boolean };
    assert.notEqual(res.isError, true);
    const row = db.prepare("SELECT embedding FROM memories WHERE content LIKE 'partial seam probe%'").get() as { embedding: Buffer | null };
    assert.equal(row.embedding, null);
  });

  it('learn while cold stores the row without an embedding (backfill owns catch-up)', async () => {
    const res = await client.callTool({ name: TOOL.LEARN, arguments: {
      kind: 'fact', content: 'cold learn probe row about deferred embeddings',
    } }) as { content: Array<{ type: string; text?: string }>; isError?: boolean };
    assert.notEqual(res.isError, true);
    const row = db.prepare("SELECT embedding FROM memories WHERE content LIKE 'cold learn probe%'").get() as { embedding: Buffer | null };
    assert.equal(row.embedding, null, 'no blocking embed at learn time — the backfill worker owns it');
  });
});
