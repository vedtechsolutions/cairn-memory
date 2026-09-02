/**
 * learn/recall scope symmetry (remediation plan, step 2).
 *
 * The defect (M6/R6): `cairn_learn` defaults a pitfall to the CURRENT
 * project, while `cairn_recall` with no `project` argument searched
 * global-only. A lesson stored by the very session that learned it was
 * therefore invisible to that session's next bare recall — during the
 * incident, a freshly stored pitfall could not be retrieved seconds later
 * by near-identical query text.
 *
 * The gate: learn without an explicit project, then recall without an
 * explicit project in the SAME session — the sentinel must come back.
 * Globals must still surface, explicit arguments stay respected, and the
 * private-project non-leak suite must stay green (scope-controls.test.ts).
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
import { EdgeRepository } from '../src/db/edge-repository.js';
import { setSessionProjectForTests } from '../src/utils/session-project.js';

const SESSION_PROJECT = 'proj-symmetry';

let db: Database.Database;
let repo: MemoryRepository;
let client: Client;
let edgeRepo: EdgeRepository;

beforeEach(async () => {
  db = openDatabase({ dbPath: ':memory:' });
  repo = new MemoryRepository(db);
  setSessionProjectForTests(SESSION_PROJECT);

  const server = new McpServer({ name: 'test', version: '0.0.0' });
  edgeRepo = new EdgeRepository(db);
  registerMemoryTools(server, repo, () => 'normal', undefined, edgeRepo);
  client = new Client({ name: 'test-client', version: '0.0.0' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(ct), server.connect(st)]);
});

afterEach(async () => {
  setSessionProjectForTests(undefined);
  await client.close();
  db.close();
});

const call = async (name: string, args: Record<string, unknown>) => {
  const res = await client.callTool({ name, arguments: args }) as {
    content: Array<{ type: string; text?: string }>; isError?: boolean;
  };
  return { text: res.content[0]?.text ?? '', isError: res.isError === true };
};

describe('learn/recall scope symmetry', () => {
  it('GATE: learn without project, bare recall same session — the sentinel returns', async () => {
    const learned = await call('cairn_learn', {
      kind: 'pitfall',
      content: 'sentinel: validate the sqlite backup api against a live writer before trusting it',
    });
    assert.equal(learned.isError, false, learned.text);

    const recalled = await call('cairn_recall', { query: 'validate sqlite backup api live writer' });
    assert.equal(recalled.isError, false);
    assert.match(recalled.text, /sentinel: validate the sqlite backup api/,
      'a lesson learned by this session must be visible to this session\'s next bare recall');
  });

  it('learn without project actually stored under the session project (not global)', async () => {
    await call('cairn_learn', { kind: 'pitfall', content: 'sentinel: scoped storage check for symmetry' });
    const row = db.prepare("SELECT project FROM memories WHERE content LIKE 'sentinel: scoped storage%'").get() as { project: string | null };
    assert.equal(row.project, SESSION_PROJECT);
  });

  it('bare recall still returns fingerprint-less globals alongside session rows', async () => {
    repo.create({ content: 'global wisdom about sqlite backup api verification', kind: 'fact', project: null, confidence: 0.8 });
    await call('cairn_learn', { kind: 'pitfall', content: 'sentinel: project row about sqlite backup api' });
    const recalled = await call('cairn_recall', { query: 'sqlite backup api' });
    assert.match(recalled.text, /global wisdom/);
    assert.match(recalled.text, /sentinel: project row/);
  });

  it('an explicit project argument is still respected verbatim', async () => {
    repo.create({ content: 'other-project row about backup api', kind: 'fact', project: 'proj-other', confidence: 0.8 });
    const recalled = await call('cairn_recall', { query: 'backup api', project: 'proj-other' });
    assert.match(recalled.text, /other-project row/);
  });

  it("scope:'global' returns only globals — the documented explicit global mode", async () => {
    repo.create({ content: 'globalonly row about backup api', kind: 'fact', project: null, confidence: 0.8 });
    await call('cairn_learn', { kind: 'pitfall', content: 'sentinel: session row backup api again' });
    const recalled = await call('cairn_recall', { query: 'backup api', scope: 'global' });
    assert.match(recalled.text, /globalonly row/);
    assert.ok(!/sentinel: session row/.test(recalled.text), 'session rows excluded under scope:global');
  });

  it('a graph edge cannot smuggle ANOTHER project\'s row into bare recall', async () => {
    // Session rows are now graph entry points; an edge to a foreign-project
    // row must not ride enrichment past the scope filter (review block 3 —
    // latent today with zero cross-project edges live, pinned here).
    const mine = repo.create({ content: 'session entry row about edge smuggling probes', kind: 'fact', project: SESSION_PROJECT, confidence: 0.8 });
    const foreign = repo.create({ content: 'foreign project payload behind an edge', kind: 'fact', project: 'proj-other', confidence: 0.9 });
    edgeRepo.createEdge(mine.id, foreign.id, 'co_occurred', 1.0);
    const recalled = await call('cairn_recall', { query: 'edge smuggling probes' });
    assert.match(recalled.text, /session entry row/);
    assert.ok(!/foreign project payload/.test(recalled.text),
      'graph enrichment must scope neighbors to target-project-or-global');
  });

  it("scope:'global' still returns globals when session rows crowd the window", async () => {
    // Review blocker: implemented as a post-filter, scope:'global' returned
    // ZERO globals once the session project filled the candidate window
    // (live store: 256 session rows). Global-only must retrieve global
    // candidates, not filter a session-scoped window.
    for (let i = 0; i < 40; i++) {
      repo.create({ content: `session filler row number ${i} about the backup api window`, kind: 'fact', project: SESSION_PROJECT, confidence: 0.9 });
    }
    repo.create({ content: 'globalcrowd row about the backup api window', kind: 'fact', project: null, confidence: 0.5 });
    const recalled = await call('cairn_recall', { query: 'backup api window', scope: 'global' });
    assert.match(recalled.text, /globalcrowd row/,
      'the global must surface no matter how many session rows outrank it');
    assert.ok(!/session filler/.test(recalled.text));
  });

  it('learn with NO derivable session project errors instead of silently storing global', async () => {
    setSessionProjectForTests(null);
    try {
      const learned = await call('cairn_learn', { kind: 'pitfall', content: 'sentinel: null session scope decision' });
      assert.equal(learned.isError, true, learned.text);
      assert.match(learned.text, /pass `project` explicitly/);
      const explicitGlobal = await call('cairn_learn', { kind: 'pitfall', content: 'sentinel: chosen global row', project: null });
      assert.equal(explicitGlobal.isError, false, explicitGlobal.text);
      const row = db.prepare("SELECT project FROM memories WHERE content LIKE 'sentinel: chosen global%'").get() as { project: string | null };
      assert.equal(row.project, null);
    } finally {
      setSessionProjectForTests(SESSION_PROJECT);
    }
  });

  it('bare recall does NOT leak other projects\' rows', async () => {
    repo.create({ content: 'unrelated project secret about backup api', kind: 'fact', project: 'proj-other', confidence: 0.9 });
    const recalled = await call('cairn_recall', { query: 'backup api' });
    assert.ok(!/unrelated project secret/.test(recalled.text),
      'session-default scoping must not widen into OTHER projects');
  });
});
