/**
 * Retrieval exposure decoupled from decay stability (remediation plan, step 7).
 *
 * The defect (M5): `cairn_recall` declares `readOnlyHint: true` yet bumped
 * `recall_count`/`last_recalled` and wrote co-recall rows — and decay
 * stability multiplied by (1 + 0.3 × recall_count), so every retrieval made
 * a row more durable. Popularity became durability (rich-get-richer), and
 * the incident investigation's own diagnostic recalls reinforced the noise
 * rows it was investigating.
 *
 * The gates: decay half-life is invariant across recall_count 0/1/127; an
 * MCP recall writes NOTHING (stats, co-recall, ranks all unchanged); hook
 * retrieval is read-only and the prompt-handler stamps exactly the ids
 * whose budgetPush succeeded (markRecalled at the injection boundary) —
 * the system's own accepted injection is exposure the user actually saw,
 * and that is the boundary. Session-start briefing and subagent context
 * remain unstamped render surfaces (pre-existing; owned by step 6's
 * rebalance — stamping briefing renders while briefing RANKS by
 * recall_count would recreate the popularity loop this step removes).
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
import { applyConfidenceDecay } from '../src/db/decay.js';
import { DECAY } from '../src/constants/index.js';

const SESSION_PROJECT = 'proj-decoupling';
const MS_PER_DAY = 86_400_000;

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

/** Full mutable-state snapshot of everything an inert recall must not touch. */
const stateSnapshot = () => JSON.stringify({
  memories: db.prepare('SELECT id, recall_count, last_recalled, confidence FROM memories ORDER BY id').all(),
  sessions: db.prepare('SELECT COUNT(*) AS n FROM session_memories').get(),
  corecall: db.prepare('SELECT COUNT(*) AS n FROM memory_corecall').get(),
});

// One fixed clock for seeding AND decay: millisecond jitter between rows
// otherwise shows up as ~1e-10 confidence differences and masks the real
// comparison (exact equality is the point of the invariance gate).
const FIXED_NOW = Date.parse('2026-09-02T00:00:00.000Z');

const seedAged = (id: string, kind: string, recallCount: number, ageDays: number) => {
  const createdAt = new Date(FIXED_NOW - ageDays * MS_PER_DAY).toISOString();
  db.prepare(`
    INSERT INTO memories (id, content, kind, project, tags, confidence, source,
      created_at, last_recalled, last_decayed_at, recall_count, invalidated)
    VALUES (?, ?, ?, ?, '[]', 0.8, 'learned', ?, NULL, NULL, ?, 0)
  `).run(id, `aged row ${id} about decay invariance`, kind, SESSION_PROJECT, createdAt, recallCount);
};

describe('retrieval exposure decoupled from decay stability (step 7)', () => {
  it('GATE: decay half-life is invariant across recall_count 0 / 1 / 127', () => {
    // Identical rows except recall_count. Under the popularity loop, 127
    // recalls multiplied stability ~39× — the row barely decayed. Stability
    // must be a function of kind and source only.
    seedAged('inv-0', 'fact', 0, 40);
    seedAged('inv-1', 'fact', 1, 40);
    seedAged('inv-127', 'fact', 127, 40);

    applyConfidenceDecay(db, FIXED_NOW);

    const conf = (id: string) =>
      (db.prepare('SELECT confidence FROM memories WHERE id = ?').get(id) as { confidence: number }).confidence;
    const c0 = conf('inv-0');
    assert.ok(c0 < 0.8, 'the rows must actually have decayed (aged past grace)');
    assert.equal(conf('inv-1'), c0, 'recall_count 1 must decay exactly like 0');
    assert.equal(conf('inv-127'), c0, 'recall_count 127 must decay exactly like 0');
  });

  it('GATE: an MCP cairn_recall writes nothing — stats, co-recall, confidence all unchanged', async () => {
    repo.create({ content: 'inert probe row one about socket timeouts', kind: 'fact', project: SESSION_PROJECT, confidence: 0.8 });
    repo.create({ content: 'inert probe row two about socket timeouts', kind: 'fact', project: SESSION_PROJECT, confidence: 0.7 });

    const before = stateSnapshot();
    const result = await recall('socket timeouts');
    assert.ok(/inert probe row/.test(result.text), 'the recall must actually return the rows');
    assert.equal(stateSnapshot(), before,
      'readOnlyHint: true must be true in fact — no recall_count, last_recalled, session_memories, or memory_corecall writes');
  });

  it('GATE: a diagnostic recall changes no subsequent rank', async () => {
    repo.create({ content: 'rank stability row alpha about migration order', kind: 'fact', project: SESSION_PROJECT, confidence: 0.8 });
    repo.create({ content: 'rank stability row beta about migration order', kind: 'fact', project: SESSION_PROJECT, confidence: 0.6 });

    const first = await recall('migration order');
    for (let i = 0; i < 5; i++) await recall('migration order');
    const after = await recall('migration order');
    assert.equal(after.text, first.text,
      'repeated diagnostic recalls must not perturb ranking (no self-reinforcement)');
  });

  it('BOUNDARY: markRecalled is the sanctioned exposure stamp (moves the spaced-repetition reference)', () => {
    // Exposure is stamped ONLY at injection boundaries, via markRecalled —
    // retrieval never stamps (all production retrieval passes readOnly).
    const created = repo.create({ content: 'hook boundary row about spaced repetition', kind: 'fact', project: SESSION_PROJECT, confidence: 0.8 });
    const results = repo.recall('spaced repetition boundary', { project: SESSION_PROJECT, readOnly: true });
    assert.ok(results.some(r => r.memory.id === created.id), 'the row must be found');
    let row = db.prepare('SELECT recall_count FROM memories WHERE id = ?').get(created.id) as { recall_count: number };
    assert.equal(row.recall_count, 0, 'read-only retrieval must not stamp');
    repo.markRecalled([created.id]);
    const stamped = db.prepare('SELECT recall_count, last_recalled FROM memories WHERE id = ?').get(created.id) as { recall_count: number; last_recalled: string | null };
    assert.equal(stamped.recall_count, 1, 'the injection boundary records exposure');
    assert.ok(stamped.last_recalled, 'last_recalled moves — spaced repetition stays for real injection');
  });

  it('BOUNDARY: hybrid retrieval honors readOnly too (the recall-layers path)', () => {
    // recall-layers calls recallHybrid readOnly — the vector-path stamp at
    // vector-search.ts must stay behind the same flag.
    const created = repo.create({ content: 'hybrid boundary row about vector stamping', kind: 'fact', project: SESSION_PROJECT, confidence: 0.8 });
    const fakeEmbedding = Buffer.alloc(384 * 4); // zero vector: FTS side still finds the row
    const results = repo.recallHybrid('hybrid boundary vector stamping', fakeEmbedding, { project: SESSION_PROJECT, readOnly: true });
    assert.ok(results.some(r => r.memory.id === created.id), 'the row must be found via the hybrid path');
    const row = db.prepare('SELECT recall_count FROM memories WHERE id = ?').get(created.id) as { recall_count: number };
    assert.equal(row.recall_count, 0, 'hybrid readOnly retrieval must not stamp');
  });

  it('the RECALL_STABILITY_FACTOR constant is gone — the loop cannot quietly return', () => {
    assert.ok(!('RECALL_STABILITY_FACTOR' in DECAY),
      'the popularity multiplier must be removed, not left dormant');
  });
});

/**
 * Codex step-7 block 2: the exposure gate must drive the REAL hook path.
 * A candidate the retrieval layer finds but the hook then drops (here: a
 * RESOLVED pitfall failing isMemoryEligibleForInjection) must gain no
 * recall stats; the candidate actually injected into context must gain
 * exactly one stamp. This is what "recall_count = genuine exposure" means.
 */
import { PlanRepository } from '../src/db/plan-repository.js';
import { ReminderRepository } from '../src/db/reminder-repository.js';
import { ContextRepository } from '../src/db/context-repository.js';
import { InvestigationRepository } from '../src/db/investigation-repository.js';
import type { CachedHookContext } from '../src/hooks/shared/db-client.js';
import type { UserPromptSubmitInput } from '../src/hooks/shared/hook-io.js';
import { handlePromptCheck } from '../src/hooks/handlers/prompt-handler.js';
import { projectId } from '../src/utils/project-id.js';
import { TOOL } from '../src/constants/mcp.js';

describe('exposure gate on the real hook path (step 7, fold round)', () => {
  let hdb: Database.Database;
  let hclient: CachedHookContext;
  const CWD = '/tmp/decoupling-hook-cwd';

  beforeEach(() => {
    hdb = openDatabase({ dbPath: ':memory:' });
    hclient = {
      db: hdb,
      memoryRepo: new MemoryRepository(hdb),
      planRepo: new PlanRepository(hdb),
      reminderRepo: new ReminderRepository(hdb),
      contextRepo: new ContextRepository(hdb),
      investigationRepo: new InvestigationRepository(hdb),
      close: () => hdb.close(),
    };
  });

  afterEach(() => hdb.close());

  const promptInput = (prompt: string, session = 'decoupling-hook-session'): UserPromptSubmitInput => ({
    session_id: session,
    transcript_path: '/tmp/no-transcript.jsonl',
    cwd: CWD,
    prompt,
  } as unknown as UserPromptSubmitInput);

  it('GATE: injected candidates are stamped, dropped candidates are not', () => {
    // Same-project rows: the cross-project guard is not what this gate
    // probes (null-fp globals are ITS drop case, pinned in GAP K tests).
    const injected = hclient.memoryRepo.storePitfall({
      content: 'pitfall handler file change detection path needs the tracker flushed first',
      project: projectId(CWD), confidence: 0.9, source: 'user',
    });
    // Same retrieval surface, but ineligible for injection: RESOLVED marker.
    const dropped = hclient.memoryRepo.storePitfall({
      content: 'RESOLVED: pitfall handler file change detection path tracker issue was fixed',
      project: projectId(CWD), confidence: 0.9, source: 'user',
    });

    const result = handlePromptCheck(
      promptInput('I need to add a new pitfall handler for the file change detection path, please implement it'),
      hclient,
    );
    assert.ok(result.output?.includes('tracker flushed first'), `the eligible pitfall must inject, got: ${String(result.output)}`);

    const count = (id: string) =>
      (hdb.prepare('SELECT recall_count FROM memories WHERE id = ?').get(id) as { recall_count: number }).recall_count;
    assert.equal(count(injected.id), 1, 'the injected candidate gains exactly one exposure stamp');
    assert.equal(count(dropped.id), 0,
      'a retrieved-but-dropped candidate must gain NOTHING — retrieval is not exposure');
  });

  it('GATE: a budget-refused candidate is never stamped (codex fold block 1)', () => {
    // Two eligible, strongly-relevant pitfalls that BOTH clear the 0.45
    // score gate (so the budget seam, not the score filter, decides).
    // Sizing: the per-turn budget is 100 tokens and the compliance nudge
    // may spend up to ~30 first. The first line costs ~60 tokens (always
    // fits); the second ~55 (never fits in what remains). The repeat blob
    // is ONE Jaccard token, so relevance stays driven by the shared stem.
    const big = hclient.memoryRepo.storePitfall({
      content: 'pitfall handler file change detection path needs the tracker flushed first ' + 'x'.repeat(150),
      project: projectId(CWD), confidence: 0.95, source: 'user',
    });
    // confidence 0.95 keeps this row ABOVE the 0.45 score gate (score
    // ≈0.48 at its overlap) so the BUDGET, not the score filter, is what
    // refuses it — while the first row's higher overlap (score ≈0.55)
    // keeps rank 1 deterministic.
    const refused = hclient.memoryRepo.storePitfall({
      content: 'when rewriting entries inside the pitfall handler remember file change detection invalidates caches ' + 'y'.repeat(140),
      project: projectId(CWD), confidence: 0.95, source: 'user',
    });
    assert.notEqual(refused.id, big.id,
      'fixture premise: two distinct rows (no dedup merge between them)');

    const result = handlePromptCheck(
      promptInput('I need to add a new pitfall handler for the file change detection path, please implement it'),
      hclient,
    );
    const count = (id: string) =>
      (hdb.prepare('SELECT recall_count FROM memories WHERE id = ?').get(id) as { recall_count: number }).recall_count;
    // The big one entered context (stamped); the refused one did not.
    assert.ok(result.output?.includes('tracker flushed first'), 'the first pitfall must inject');
    assert.equal(count(big.id), 1, 'the accepted push is stamped once');
    assert.ok(!result.output?.includes('rewriting entries'), 'the second push must be budget-refused');
    assert.equal(count(refused.id), 0,
      'a budget-refused candidate was never shown — it must not be stamped (codex fold block 1)');
  });

  it('GATE: co-recall is re-sourced from genuine injection under the REAL session id (step 8)', () => {
    // Two eligible pitfalls injected in one turn → a co-recall pair and
    // session_memories rows keyed by the actual session — not 'mcp-recall',
    // the dead literal the diagnostic feeder used.
    const p1 = hclient.memoryRepo.storePitfall({
      content: 'pitfall handler file change detection path needs the tracker flushed first',
      project: projectId(CWD), confidence: 0.9, source: 'user',
    });
    const p2 = hclient.memoryRepo.storePitfall({
      content: 'adding a new pitfall handler to the file change detection path requires cache invalidation',
      project: projectId(CWD), confidence: 0.88, source: 'user',
    });
    assert.notEqual(p1.id, p2.id, 'fixture premise: no dedup merge');
    const result = handlePromptCheck(
      promptInput('I need to add a new pitfall handler for the file change detection path, please implement it', 'corecall-resource-session'),
      hclient,
    );
    assert.ok(result.output?.includes('tracker flushed first') && result.output?.includes('requires cache invalidation'),
      `both pitfalls must inject, got: ${String(result.output)}`);
    const sess = hdb.prepare('SELECT DISTINCT session_id FROM session_memories').all() as Array<{ session_id: string }>;
    assert.deepEqual(sess.map(r => r.session_id), ['corecall-resource-session'],
      'session_memories carries the REAL session id');
    const pair = hdb.prepare('SELECT COUNT(*) AS n FROM memory_corecall WHERE (memory_a = ? AND memory_b = ?) OR (memory_a = ? AND memory_b = ?)')
      .get(p1.id, p2.id, p2.id, p1.id) as { n: number };
    assert.equal(pair.n, 1, 'the genuinely co-injected pair is recorded');
  });

  it('GATE: a SINGLE-memory injection still feeds session_memories — one row, zero pairs (codex fold)', () => {
    hclient.memoryRepo.storePitfall({
      content: 'pitfall handler file change detection path needs the tracker flushed first',
      project: projectId(CWD), confidence: 0.9, source: 'user',
    });
    const result = handlePromptCheck(
      promptInput('I need to add a new pitfall handler for the file change detection path, please implement it', 'single-inject-session'),
      hclient,
    );
    assert.ok(result.output?.includes('tracker flushed first'), 'the pitfall must inject');
    const rows = hdb.prepare("SELECT COUNT(*) AS n FROM session_memories WHERE session_id = 'single-inject-session'").get() as { n: number };
    assert.equal(rows.n, 1, 'a lone injection must still reach the precision loop');
    const pairs = hdb.prepare('SELECT COUNT(*) AS n FROM memory_corecall').get() as { n: number };
    assert.equal(pairs.n, 0, 'no pair can exist for a single id');
  });

  it('GATE: a turn that injects nothing stamps nothing — including retrieved-but-below-score rows', () => {
    // Weak overlap with the prompt: FTS retrieves it as a candidate, the
    // 0.45 score gate then drops it — it must stay unstamped (review HOLD:
    // a never-retrieved bystander alone cannot discriminate).
    const belowScore = hclient.memoryRepo.storePitfall({
      content: 'billing rounding pitfall from the legacy fiscal ledger import days',
      project: projectId(CWD), confidence: 0.7,
    });
    const bystander = hclient.memoryRepo.create({
      content: 'completely unrelated row about kubernetes ingress annotations',
      kind: 'fact', project: null, confidence: 0.9,
    });
    const result = handlePromptCheck(promptInput('please refactor the billing reconciliation exporter module now'), hclient);
    assert.ok(!result.output?.includes('rounding pitfall'), 'premise: the weak row must not inject');
    const count = (id: string) =>
      (hdb.prepare('SELECT recall_count FROM memories WHERE id = ?').get(id) as { recall_count: number }).recall_count;
    assert.equal(count(belowScore.id), 0, 'retrieved-but-below-score gains nothing');
    assert.equal(count(bystander.id), 0);
  });
});
