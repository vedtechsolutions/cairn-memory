/**
 * MCP tool-surface tests for cairn_plan (plan-tool.ts) and the reminder tools
 * (reminder-tools.ts: cairn_remind, cairn_reminder_list, cairn_reminder_delete).
 *
 * Drives the REAL registration path: registerPlanTool/registerReminderTools on
 * an McpServer wired to a Client over InMemoryTransport, backed by an in-memory
 * SQLite database and real repositories. No handler logic is mocked — only the
 * context-mode getter is a controllable stub.
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
import { SessionCache } from '../src/hooks/shared/session-cache.js';
import { registerPlanTool } from '../src/mcp/tools/plan-tool.js';
import { registerReminderTools } from '../src/mcp/tools/reminder-tools.js';
import { REMINDERS, TOKEN_BUDGET, type ContextMode } from '../src/constants/index.js';

// --- Harness ------------------------------------------------------------------

const PROJECT = 'proj-mcp-tools';
const OTHER_PROJECT = 'proj-other';
const CRITICAL_SILENCE = '[cairn silent — context critical]';

interface Harness {
  db: Database.Database;
  client: Client;
  planRepo: PlanRepository;
  memoryRepo: MemoryRepository;
  reminderRepo: ReminderRepository;
  sessionCache: SessionCache;
  setMode(mode: ContextMode): void;
  close(): Promise<void>;
}

interface ToolReply {
  text: string;
  isError: boolean;
}

async function createHarness(): Promise<Harness> {
  const db = openDatabase({ dbPath: ':memory:' });
  const memoryRepo = new MemoryRepository(db);
  const planRepo = new PlanRepository(db);
  const reminderRepo = new ReminderRepository(db);
  const sessionCache = new SessionCache();
  let mode: ContextMode = 'normal';

  const server = new McpServer({ name: 'cairn-test', version: '0.0.0' });
  registerPlanTool(server, planRepo, memoryRepo, () => mode, sessionCache);
  registerReminderTools(server, reminderRepo, () => mode, sessionCache);

  const client = new Client({ name: 'cairn-test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return {
    db,
    client,
    planRepo,
    memoryRepo,
    reminderRepo,
    sessionCache,
    setMode: (m: ContextMode) => { mode = m; },
    close: async () => {
      await client.close();
      db.close();
    },
  };
}

async function call(h: Harness, name: string, args: Record<string, unknown>): Promise<ToolReply> {
  const result = await h.client.callTool({ name, arguments: args });
  const shaped = result as unknown as {
    content?: Array<{ type?: string; text?: string }>;
    isError?: boolean;
  };
  const text = (shaped.content ?? [])
    .filter(block => block.type === 'text')
    .map(block => block.text ?? '')
    .join('\n');
  return { text, isError: shaped.isError === true };
}

function plan(h: Harness, args: Record<string, unknown>): Promise<ToolReply> {
  return call(h, 'cairn_plan', args);
}

/** Create a standard three-step plan (step 2 depends on step 1). */
async function createTestPlan(h: Harness, name = 'Ship reminder coverage'): Promise<ToolReply> {
  return plan(h, {
    action: 'create',
    name,
    project: PROJECT,
    steps: [
      { description: 'Design harness schema' },
      { description: 'Implement repositories', depends_on: [1] },
      { description: 'Wire transport pair' },
    ],
  });
}

function countMemories(db: Database.Database, kind: string): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM memories WHERE kind = ?').get(kind) as { n: number };
  return row.n;
}

function reminderRow(db: Database.Database, id: string): { active: number } | undefined {
  return db.prepare('SELECT active FROM reminders WHERE id = ?').get(id) as { active: number } | undefined;
}

// --- cairn_plan: create -------------------------------------------------------

describe('cairn_plan create', () => {
  let h: Harness;
  beforeEach(async () => { h = await createHarness(); });
  afterEach(async () => { await h.close(); });

  it('creates a plan whose steps carry dependency metadata', async () => {
    const reply = await createTestPlan(h);
    assert.equal(reply.isError, false);
    assert.match(reply.text, /^ok — plan "Ship reminder coverage" created with 3 steps/);

    const active = h.planRepo.getActive(PROJECT);
    assert.ok(active, 'plan must be active after create');
    assert.equal(active.steps.length, 3);
    assert.deepEqual(active.steps[1].depends_on, [1]);
    assert.equal(active.steps[0].status, 'pending');
  });

  it('stores the plan name as a goal memory tagged plan-goal', async () => {
    await createTestPlan(h);
    const rows = h.db.prepare("SELECT content, tags, project FROM memories WHERE kind = 'goal'")
      .all() as Array<{ content: string; tags: string; project: string }>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].content, 'Ship reminder coverage');
    assert.equal(rows[0].project, PROJECT);
    assert.ok((JSON.parse(rows[0].tags) as string[]).includes('plan-goal'));
  });

  it('does not duplicate the goal memory when recreating a same-name plan', async () => {
    await createTestPlan(h);
    await createTestPlan(h);
    assert.equal(countMemories(h.db, 'goal'), 1);
  });

  it('archives the previous active plan when a new one is created', async () => {
    await createTestPlan(h, 'First plan');
    await createTestPlan(h, 'Second plan');

    const active = h.planRepo.getActive(PROJECT);
    assert.equal(active?.name, 'Second plan');

    const listing = await plan(h, { action: 'list', project: PROJECT });
    assert.ok(listing.text.includes('[active] "Second plan"'));
    assert.ok(listing.text.includes('[abandoned] "First plan"'));
  });

  it('bumps the session cache memory version so briefings refresh', async () => {
    const before = h.sessionCache.getMemoryVersion();
    await createTestPlan(h);
    assert.ok(h.sessionCache.getMemoryVersion() > before);
  });

  it('errors when project is missing', async () => {
    const reply = await plan(h, {
      action: 'create',
      name: 'No project',
      steps: [{ description: 'orphan step' }],
    });
    assert.equal(reply.isError, true);
    assert.equal(reply.text, 'error: project required for create');
  });

  it('errors when name is missing', async () => {
    const reply = await plan(h, {
      action: 'create',
      project: PROJECT,
      steps: [{ description: 'nameless step' }],
    });
    assert.equal(reply.isError, true);
    assert.equal(reply.text, 'error: name required for create');
  });

  it('errors when steps are empty', async () => {
    const reply = await plan(h, { action: 'create', name: 'Stepless', project: PROJECT, steps: [] });
    assert.equal(reply.isError, true);
    assert.equal(reply.text, 'error: steps required for create');
  });
});

// --- cairn_plan: get ----------------------------------------------------------

describe('cairn_plan get', () => {
  let h: Harness;
  beforeEach(async () => { h = await createHarness(); });
  afterEach(async () => { await h.close(); });

  it('renders the active plan with steps, decisions, and rejected alternatives', async () => {
    await createTestPlan(h);
    await plan(h, {
      action: 'decide',
      project: PROJECT,
      chose: 'better-sqlite3',
      why: 'synchronous API fits hooks',
      alternatives: ['postgres', 'lowdb'],
      permanent: true,
    });

    const reply = await plan(h, { action: 'get', project: PROJECT, filter: 'full' });
    assert.equal(reply.isError, false);
    assert.ok(reply.text.includes('Plan: "Ship reminder coverage" [active]'));
    assert.ok(reply.text.includes('[ ] 1. Design harness schema'));
    assert.ok(reply.text.includes('(depends: 1)'));
    assert.ok(reply.text.includes(
      'plan-level: chose "better-sqlite3" because synchronous API fits hooks [permanent] (rejected: postgres, lowdb)',
    ));
    assert.ok(!reply.text.includes('(filtered:'), 'full filter must not announce filtering');
  });

  it('reports no active plan when none exists', async () => {
    const reply = await plan(h, { action: 'get', project: PROJECT });
    assert.equal(reply.text, 'No active plan.');
  });

  it('hides done steps by default under compact context pressure', async () => {
    await createTestPlan(h);
    await plan(h, { action: 'step', project: PROJECT, step_id: 1, status: 'done' });

    h.setMode('compact');
    const reply = await plan(h, { action: 'get', project: PROJECT });
    assert.ok(reply.text.includes('(filtered: active)'));
    assert.ok(!reply.text.includes('Design harness schema'), 'done step must be filtered out');
    assert.ok(reply.text.includes('Implement repositories'));
  });

  it('shows only the current and next steps under minimal pressure', async () => {
    await createTestPlan(h);
    await plan(h, { action: 'step', project: PROJECT, step_id: 1, status: 'in_progress' });

    h.setMode('minimal');
    const reply = await plan(h, { action: 'get', project: PROJECT });
    assert.ok(reply.text.includes('(filtered: current)'));
    assert.ok(reply.text.includes('[>] 1. Design harness schema'));
    assert.ok(reply.text.includes('Implement repositories'), 'next pending step must show');
    assert.ok(!reply.text.includes('Wire transport pair'), 'later pending steps must be hidden');
  });

  it('omits steps entirely with the decisions filter', async () => {
    await createTestPlan(h);
    await plan(h, { action: 'decide', project: PROJECT, chose: 'zod v4', why: 'already a dependency' });

    const reply = await plan(h, { action: 'get', project: PROJECT, filter: 'decisions' });
    assert.ok(!reply.text.includes('Steps:'));
    assert.ok(reply.text.includes('chose "zod v4" because already a dependency'));
  });
});

// --- cairn_plan: step ---------------------------------------------------------

describe('cairn_plan step', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness();
    await createTestPlan(h);
  });
  afterEach(async () => { await h.close(); });

  it('transitions a step through in_progress to done with an outcome', async () => {
    const started = await plan(h, { action: 'step', project: PROJECT, step_id: 1, status: 'in_progress' });
    assert.equal(started.isError, false);
    assert.equal(h.planRepo.getActive(PROJECT)?.steps[0].status, 'in_progress');

    const finished = await plan(h, {
      action: 'step', project: PROJECT, step_id: 1, status: 'done', outcome: 'schema landed',
    });
    assert.equal(finished.isError, false);

    const rendered = await plan(h, { action: 'get', project: PROJECT, filter: 'full' });
    assert.ok(rendered.text.includes('[x] 1. Design harness schema'));
    assert.ok(rendered.text.includes('outcome: schema landed'));
  });

  it('warns when starting a step whose dependencies are incomplete', async () => {
    const reply = await plan(h, { action: 'step', project: PROJECT, step_id: 2, status: 'in_progress' });
    assert.equal(reply.isError, false);
    assert.match(reply.text, /^ok/);
    assert.ok(reply.text.includes('step 2 depends on incomplete steps [1]'));
  });

  it('marks a step blocked and renders the blocker text', async () => {
    await plan(h, {
      action: 'step', project: PROJECT, step_id: 3, status: 'blocked', blockers: 'waiting on schema review',
    });
    const rendered = await plan(h, { action: 'get', project: PROJECT, filter: 'full' });
    assert.ok(rendered.text.includes('[!] 3. Wire transport pair'));
    assert.ok(rendered.text.includes('blocked: waiting on schema review'));
  });

  it('errors when the step id does not exist', async () => {
    const reply = await plan(h, { action: 'step', project: PROJECT, step_id: 99, status: 'done' });
    assert.equal(reply.isError, true);
    assert.equal(reply.text, 'error: step not found or nothing to update');
  });

  it('errors when step_id is missing', async () => {
    const reply = await plan(h, { action: 'step', project: PROJECT, status: 'done' });
    assert.equal(reply.isError, true);
    assert.equal(reply.text, 'error: step_id required');
  });

  it('errors when no active plan exists for the project', async () => {
    const reply = await plan(h, { action: 'step', project: OTHER_PROJECT, step_id: 1, status: 'done' });
    assert.equal(reply.isError, true);
    assert.equal(reply.text, 'error: no active plan');
  });

  it('rejects an unknown step status at the schema layer without touching the plan', async () => {
    const reply = await plan(h, { action: 'step', project: PROJECT, step_id: 1, status: 'finished' });
    assert.equal(reply.isError, true);
    assert.match(reply.text, /Input validation error/);
    assert.equal(h.planRepo.getActive(PROJECT)?.steps[0].status, 'pending', 'invalid status must not persist');
  });
});

// --- cairn_plan: decide -------------------------------------------------------

describe('cairn_plan decide', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness();
    await createTestPlan(h);
  });
  afterEach(async () => { await h.close(); });

  it('records a decision and echoes the rejected alternatives', async () => {
    const reply = await plan(h, {
      action: 'decide',
      project: PROJECT,
      step_id: 2,
      chose: 'in-memory transport',
      why: 'no subprocess flakiness',
      alternatives: ['stdio child process'],
    });
    assert.equal(reply.isError, false);
    assert.equal(reply.text, 'ok — recorded: chose "in-memory transport" (rejected: stdio child process)');

    const decisions = h.planRepo.getActive(PROJECT)?.decisions ?? [];
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0].step_id, 2);
    assert.equal(decisions[0].permanent, false);
    assert.deepEqual(decisions[0].alternatives, ['stdio child process']);
  });

  it('stores the permanent flag for later graduation', async () => {
    await plan(h, {
      action: 'decide', project: PROJECT, chose: 'WAL mode', why: 'concurrent readers', permanent: true,
    });
    assert.equal(h.planRepo.getActive(PROJECT)?.decisions[0].permanent, true);
  });

  it('errors when chose is missing', async () => {
    const reply = await plan(h, { action: 'decide', project: PROJECT, why: 'reasons' });
    assert.equal(reply.isError, true);
    assert.equal(reply.text, 'error: chose required for decide');
  });

  it('errors when why is missing', async () => {
    const reply = await plan(h, { action: 'decide', project: PROJECT, chose: 'a thing' });
    assert.equal(reply.isError, true);
    assert.equal(reply.text, 'error: why required for decide');
  });

  it('errors when no active plan exists', async () => {
    const reply = await plan(h, { action: 'decide', project: OTHER_PROJECT, chose: 'x', why: 'y' });
    assert.equal(reply.isError, true);
    assert.equal(reply.text, 'error: no active plan');
  });
});

// --- cairn_plan: note ---------------------------------------------------------

describe('cairn_plan note', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness();
    await createTestPlan(h);
  });
  afterEach(async () => { await h.close(); });

  it('appends a progress note to a step', async () => {
    const reply = await plan(h, {
      action: 'note', project: PROJECT, step_id: 1, note: 'harness scaffolding compiles',
    });
    assert.equal(reply.isError, false);
    assert.equal(reply.text, 'ok');

    const notes = h.planRepo.getActive(PROJECT)?.steps[0].notes ?? [];
    assert.equal(notes.length, 1);
    assert.equal(notes[0].note, 'harness scaffolding compiles');
  });

  it('accepts a note exactly at the character cap', async () => {
    const reply = await plan(h, {
      action: 'note', project: PROJECT, step_id: 1, note: 'x'.repeat(TOKEN_BUDGET.NOTE_MAX_CHARS),
    });
    assert.equal(reply.isError, false);
  });

  it('rejects a note one character over the cap', async () => {
    const reply = await plan(h, {
      action: 'note', project: PROJECT, step_id: 1, note: 'x'.repeat(TOKEN_BUDGET.NOTE_MAX_CHARS + 1),
    });
    assert.equal(reply.isError, true);
    assert.ok(reply.text.includes(`max ${TOKEN_BUDGET.NOTE_MAX_CHARS}`));
  });

  it('replaces all prior notes when replace is set', async () => {
    await plan(h, { action: 'note', project: PROJECT, step_id: 1, note: 'first note' });
    await plan(h, { action: 'note', project: PROJECT, step_id: 1, note: 'second note' });
    await plan(h, { action: 'note', project: PROJECT, step_id: 1, note: 'the only note', replace: true });

    const notes = h.planRepo.getActive(PROJECT)?.steps[0].notes ?? [];
    assert.equal(notes.length, 1);
    assert.equal(notes[0].note, 'the only note');
  });

  it('errors when the target step does not exist', async () => {
    const reply = await plan(h, { action: 'note', project: PROJECT, step_id: 99, note: 'ghost step' });
    assert.equal(reply.isError, true);
    assert.equal(reply.text, 'error: step not found');
  });

  it('errors when note text is missing', async () => {
    const reply = await plan(h, { action: 'note', project: PROJECT, step_id: 1 });
    assert.equal(reply.isError, true);
    assert.equal(reply.text, 'error: note required');
  });
});

// --- cairn_plan: complete -----------------------------------------------------

describe('cairn_plan complete', () => {
  let h: Harness;
  beforeEach(async () => { h = await createHarness(); });
  afterEach(async () => { await h.close(); });

  it('graduates permanent decisions into decision memories', async () => {
    await createTestPlan(h);
    await plan(h, {
      action: 'decide', project: PROJECT, chose: 'WAL mode', why: 'concurrent readers', permanent: true,
    });
    await plan(h, {
      action: 'decide', project: PROJECT, chose: 'tabs over spaces', why: 'ephemeral style call',
    });

    const reply = await plan(h, { action: 'complete', project: PROJECT });
    assert.equal(reply.isError, false);
    assert.equal(reply.text, 'ok — plan completed, 1 decision(s) graduated to memories');

    const rows = h.db.prepare("SELECT content, project FROM memories WHERE kind = 'decision'")
      .all() as Array<{ content: string; project: string }>;
    assert.equal(rows.length, 1, 'only the permanent decision graduates');
    assert.equal(rows[0].content, 'WAL mode — concurrent readers');
    assert.equal(rows[0].project, PROJECT);
    assert.equal(h.planRepo.getActive(PROJECT), null, 'plan must no longer be active');
  });

  it('completes without graduation when no decision is permanent', async () => {
    await createTestPlan(h);
    const reply = await plan(h, { action: 'complete', project: PROJECT });
    assert.equal(reply.text, 'ok — plan completed');
    assert.equal(countMemories(h.db, 'decision'), 0);
  });

  it('errors when no active plan exists', async () => {
    const reply = await plan(h, { action: 'complete', project: PROJECT });
    assert.equal(reply.isError, true);
    assert.equal(reply.text, 'error: no active plan');
  });
});

// --- cairn_plan: list ---------------------------------------------------------

describe('cairn_plan list', () => {
  let h: Harness;
  beforeEach(async () => { h = await createHarness(); });
  afterEach(async () => { await h.close(); });

  it('lists plans with status and done-step counts', async () => {
    await createTestPlan(h, 'Finished plan');
    await plan(h, { action: 'step', project: PROJECT, step_id: 1, status: 'done' });
    await plan(h, { action: 'complete', project: PROJECT });
    await createTestPlan(h, 'Running plan');

    const reply = await plan(h, { action: 'list', project: PROJECT });
    assert.ok(reply.text.includes('[active] "Running plan" — 0/3 steps done'));
    assert.ok(reply.text.includes('[completed] "Finished plan" — 1/3 steps done'));
  });

  it('reports when the project has no plans', async () => {
    const reply = await plan(h, { action: 'list', project: PROJECT });
    assert.equal(reply.text, 'No plans for this project.');
  });

  it('does not include plans from other projects', async () => {
    await createTestPlan(h, 'Mine');
    const reply = await plan(h, { action: 'list', project: OTHER_PROJECT });
    assert.equal(reply.text, 'No plans for this project.');
  });

  it('errors when project is missing', async () => {
    const reply = await plan(h, { action: 'list' });
    assert.equal(reply.isError, true);
    assert.equal(reply.text, 'error: project required');
  });
});

// --- cairn_remind ---------------------------------------------------------------

describe('cairn_remind', () => {
  let h: Harness;
  beforeEach(async () => { h = await createHarness(); });
  afterEach(async () => { await h.close(); });

  it('creates a global prompt reminder with default settings', async () => {
    const reply = await call(h, 'cairn_remind', {
      trigger: 'sqlite migration', action: 'check FTS triggers before altering tables',
    });
    assert.equal(reply.isError, false);
    assert.equal(reply.text, 'ok');

    const reminders = h.reminderRepo.listActive();
    assert.equal(reminders.length, 1);
    assert.equal(reminders[0].trigger_pattern, 'sqlite migration');
    assert.equal(reminders[0].action, 'check FTS triggers before altering tables');
    assert.equal(reminders[0].project, null);
    assert.equal(reminders[0].max_fires, 0);
    assert.equal(reminders[0].fire_count, 0);
    assert.equal(reminders[0].trigger_type, 'prompt');
  });

  it('stores file trigger type with its config', async () => {
    await call(h, 'cairn_remind', {
      trigger: 'schema file edit',
      action: 'bump SCHEMA_VERSION',
      project: PROJECT,
      trigger_type: 'file',
      trigger_config: { filePaths: ['src/db/schema.ts'] },
    });

    const reminders = h.reminderRepo.listActive(PROJECT);
    assert.equal(reminders.length, 1);
    assert.equal(reminders[0].trigger_type, 'file');
    assert.deepEqual(reminders[0].trigger_config, { filePaths: ['src/db/schema.ts'] });
  });

  it('errors when the trigger is blank after sanitization', async () => {
    const reply = await call(h, 'cairn_remind', { trigger: '   ', action: 'never fires' });
    assert.equal(reply.isError, true);
    assert.equal(reply.text, 'error: trigger is empty');
    assert.equal(h.reminderRepo.listActive().length, 0);
  });

  it('enforces the active reminder limit', async () => {
    for (let i = 0; i < REMINDERS.MAX_ACTIVE; i++) {
      const created = h.reminderRepo.create({ trigger: `topic ${i}`, action: `act ${i}` });
      assert.ok('id' in created, 'seed reminders must be created');
    }
    const reply = await call(h, 'cairn_remind', { trigger: 'one too many', action: 'overflow' });
    assert.equal(reply.isError, true);
    assert.equal(reply.text, `error: limit reached: ${REMINDERS.MAX_ACTIVE} active reminders`);
  });

  it('stays silent and writes nothing under critical context pressure', async () => {
    h.setMode('critical');
    const versionBefore = h.sessionCache.getMemoryVersion();
    const reply = await call(h, 'cairn_remind', { trigger: 'anything', action: 'anything' });
    assert.equal(reply.isError, false);
    assert.equal(reply.text, CRITICAL_SILENCE);
    assert.equal(h.reminderRepo.listActive().length, 0);
    assert.equal(h.sessionCache.getMemoryVersion(), versionBefore);
  });

  it('bumps the session cache memory version on create', async () => {
    const before = h.sessionCache.getMemoryVersion();
    await call(h, 'cairn_remind', { trigger: 'deploy', action: 'run smoke tests' });
    assert.ok(h.sessionCache.getMemoryVersion() > before);
  });
});

// --- cairn_reminder_list --------------------------------------------------------

describe('cairn_reminder_list', () => {
  let h: Harness;
  beforeEach(async () => { h = await createHarness(); });
  afterEach(async () => { await h.close(); });

  it('lists active reminders with scope and fire counters', async () => {
    await call(h, 'cairn_remind', {
      trigger: 'webhook handler', action: 'verify HMAC first', max_fires: 3,
    });
    await call(h, 'cairn_remind', {
      trigger: 'cron xml', action: 'drop numbercall field', project: PROJECT,
    });

    const reply = await call(h, 'cairn_reminder_list', {});
    assert.equal(reply.isError, false);
    assert.ok(reply.text.includes('when "webhook handler" → "verify HMAC first" [global] (0/3 fires)'));
    assert.ok(reply.text.includes(`when "cron xml" → "drop numbercall field" [${PROJECT}] (0 fires)`));
  });

  it('filters by project while keeping global reminders visible', async () => {
    await call(h, 'cairn_remind', { trigger: 'mine', action: 'a', project: PROJECT });
    await call(h, 'cairn_remind', { trigger: 'theirs', action: 'b', project: OTHER_PROJECT });
    await call(h, 'cairn_remind', { trigger: 'everywhere', action: 'c' });

    const reply = await call(h, 'cairn_reminder_list', { project: PROJECT });
    assert.ok(reply.text.includes('"mine"'));
    assert.ok(reply.text.includes('"everywhere"'));
    assert.ok(!reply.text.includes('"theirs"'), 'other project reminders must be excluded');
  });

  it('reports when no active reminders exist', async () => {
    const reply = await call(h, 'cairn_reminder_list', {});
    assert.equal(reply.text, 'No active reminders.');
  });

  it('omits deactivated reminders', async () => {
    await call(h, 'cairn_remind', { trigger: 'stale topic', action: 'old advice' });
    const id = h.reminderRepo.listActive()[0].id;
    await call(h, 'cairn_reminder_delete', { id });

    const reply = await call(h, 'cairn_reminder_list', {});
    assert.equal(reply.text, 'No active reminders.');
  });

  it('stays silent under critical context pressure', async () => {
    await call(h, 'cairn_remind', { trigger: 'topic', action: 'act' });
    h.setMode('critical');
    const reply = await call(h, 'cairn_reminder_list', {});
    assert.equal(reply.text, CRITICAL_SILENCE);
  });
});

// --- cairn_reminder_delete ------------------------------------------------------

describe('cairn_reminder_delete', () => {
  let h: Harness;
  beforeEach(async () => { h = await createHarness(); });
  afterEach(async () => { await h.close(); });

  async function seedReminder(): Promise<string> {
    await call(h, 'cairn_remind', { trigger: 'seeded topic', action: 'seeded action' });
    return h.reminderRepo.listActive()[0].id;
  }

  it('deactivates by default, keeping the row with active = 0', async () => {
    const id = await seedReminder();
    const reply = await call(h, 'cairn_reminder_delete', { id });
    assert.equal(reply.isError, false);
    assert.equal(reply.text, 'deactivated');

    const row = reminderRow(h.db, id);
    assert.ok(row, 'deactivated row must survive in the table');
    assert.equal(row.active, 0);
  });

  it('removes the row entirely when permanent is set', async () => {
    const id = await seedReminder();
    const reply = await call(h, 'cairn_reminder_delete', { id, permanent: true });
    assert.equal(reply.text, 'deleted');
    assert.equal(reminderRow(h.db, id), undefined);
  });

  it('returns not found for an unknown id without bumping the cache version', async () => {
    const before = h.sessionCache.getMemoryVersion();
    const reply = await call(h, 'cairn_reminder_delete', { id: 'no-such-reminder' });
    assert.equal(reply.text, 'not found');
    assert.equal(h.sessionCache.getMemoryVersion(), before);
  });

  it('returns not found when deactivating an already-inactive reminder', async () => {
    const id = await seedReminder();
    await call(h, 'cairn_reminder_delete', { id });
    const reply = await call(h, 'cairn_reminder_delete', { id });
    assert.equal(reply.text, 'not found');
  });
});
