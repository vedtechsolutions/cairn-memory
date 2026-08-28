/**
 * Phase 1 step 3 — scope controls acceptance.
 *
 * A project marked private in the scope config (~/.cairn/config.json /
 * CAIRN_CONFIG_PATH) never surfaces cross-project on ANY of the five
 * surfaces: session-start briefing, prompt-check injection, pitfall-check
 * injection, subagent context, and MCP recall. Promotion out of a private
 * project requires an explicit from_private acknowledgment. Config absent
 * = pre-config behavior exactly (differential tests prove the policy, not
 * the query shape, does the blocking where a leak was reachable).
 *
 * Hermetic: every test points CAIRN_CONFIG_PATH into its own temp dir
 * (the suite preload also pins a default, so a real ~/.cairn/config.json
 * can never shape results here).
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import { registerMemoryTools } from '../src/mcp/tools/memory-tools.js';
import { registerPortabilityTools } from '../src/mcp/tools/portability-tools.js';
import { registerStatsTools } from '../src/mcp/tools/stats-tool.js';
import { registerResources } from '../src/mcp/resources.js';
import { registerPlanTool } from '../src/mcp/tools/plan-tool.js';
import { registerReminderTools } from '../src/mcp/tools/reminder-tools.js';
import { loadCairnConfig, isPrivateProject, resetConfigCacheForTests, cairnConfigPath } from '../src/config/cairn-config.js';
import { passesCrossProjectGuard, surfacesInScopedRecall } from '../src/utils/cross-project-guard.js';
import { compileBriefing, type BriefingContext } from '../src/hooks/shared/briefing-compiler.js';
import { handlePromptCheck } from '../src/hooks/handlers/prompt-handler.js';
import { handlePitfallCheck } from '../src/hooks/handlers/pitfall-handler.js';
import { handleSubagentContext } from '../src/hooks/handlers/subagent-context-handler.js';
import type { CachedHookContext } from '../src/hooks/shared/db-client.js';
import type { UserPromptSubmitInput, PreToolUseInput, SubagentStartInput } from '../src/hooks/shared/hook-io.js';
import type { ContextFingerprint } from '../src/utils/fingerprint.js';
import type { ProjectContext } from '../src/utils/project-scanner.js';
import { projectId } from '../src/utils/project-id.js';
import { setSessionProjectForTests } from '../src/utils/session-project.js';

const PRIVATE_PROJECT = 'clientwork-aaaa1111';
const OTHER_PROJECT = 'openproj-bbbb2222';
const PRIVATE_MARKER = 'PRIVATE-CLIENT-SECRET pitfall about billing exports';

/** A fingerprint broad enough to overlap any TS/Node query fingerprint. */
const OVERLAPPING_FP: ContextFingerprint = {
  lang: ['typescript'],
  framework: ['node', 'better-sqlite3'],
  module: ['hooks', 'handlers', 'billing'],
};

const TS_CONTEXT: ProjectContext = {
  gitHash: 'abc1234',
  projectName: 'openproj',
  techStack: 'TypeScript, Node, better-sqlite3',
  structure: ['src/', 'tests/'],
  entryPoints: ['src/index.ts'],
  keyConfigs: ['package.json', 'tsconfig.json'],
  scannedAt: new Date().toISOString(),
};

let configDir: string;
let savedConfigPath: string | undefined;

function writeScopeConfig(privateProjects: string[]): void {
  writeFileSync(join(configDir, 'config.json'), JSON.stringify({ v: 1, scope: { privateProjects } }));
  resetConfigCacheForTests();
}

function removeScopeConfig(): void {
  rmSync(join(configDir, 'config.json'), { force: true });
  resetConfigCacheForTests();
}

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'cairn-scope-test-'));
  savedConfigPath = process.env.CAIRN_CONFIG_PATH;
  process.env.CAIRN_CONFIG_PATH = join(configDir, 'config.json');
  resetConfigCacheForTests();
});

afterEach(() => {
  // Assigning undefined would coerce to the string "undefined" — delete.
  if (savedConfigPath === undefined) delete process.env.CAIRN_CONFIG_PATH;
  else process.env.CAIRN_CONFIG_PATH = savedConfigPath;
  resetConfigCacheForTests();
  setSessionProjectForTests(undefined);
  rmSync(configDir, { recursive: true, force: true });
});

// --- Config loader -----------------------------------------------------------

describe('scope config loader', () => {
  it('absent file yields the empty config (pre-config behavior)', () => {
    assert.equal(loadCairnConfig().scope.privateProjects.size, 0);
    assert.equal(isPrivateProject(PRIVATE_PROJECT), false);
  });

  it('CAIRN_CONFIG_PATH override is respected', () => {
    assert.equal(cairnConfigPath(), join(configDir, 'config.json'));
  });

  it('parses privateProjects and ignores unknown fields', () => {
    writeFileSync(join(configDir, 'config.json'),
      JSON.stringify({ v: 1, future_field: true, scope: { privateProjects: [PRIVATE_PROJECT], future_knob: 3 } }));
    resetConfigCacheForTests();
    assert.equal(isPrivateProject(PRIVATE_PROJECT), true);
    assert.equal(isPrivateProject(OTHER_PROJECT), false);
    assert.equal(isPrivateProject(null), false, 'global scope is never private');
  });

  it('invalid JSON and wrong shapes degrade to the empty config, never throw', () => {
    for (const bad of ['{not json', '[]', '"str"', '{"scope": 5}', '{"scope": {"privateProjects": "x"}}', '{"scope": {"privateProjects": [1, 2]}}']) {
      writeFileSync(join(configDir, 'config.json'), bad);
      resetConfigCacheForTests();
      assert.equal(isPrivateProject(PRIVATE_PROJECT), false, `must be empty for: ${bad}`);
    }
  });

  it('reloads on mtime change and reverts when the file is deleted (daemon-safe)', () => {
    writeScopeConfig([PRIVATE_PROJECT]);
    assert.equal(isPrivateProject(PRIVATE_PROJECT), true);
    // Rewrite with a bumped mtime (same-millisecond writes can share one).
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({ v: 1, scope: { privateProjects: [] } }));
    const future = new Date(Date.now() + 5000);
    utimesSync(join(configDir, 'config.json'), future, future);
    assert.equal(isPrivateProject(PRIVATE_PROJECT), false, 'edit picked up without restart');
    removeScopeConfig();
    assert.equal(isPrivateProject(PRIVATE_PROJECT), false, 'deletion reverts to default');
  });
});

// --- Guard policy (differential: the POLICY blocks, not the query shape) -----

describe('guard-module scope policy', () => {
  const privateMem = { project: PRIVATE_PROJECT, fingerprint: OVERLAPPING_FP };
  const queryFp: ContextFingerprint = { lang: ['typescript'], framework: ['node', 'better-sqlite3'], module: ['hooks', 'billing'] };

  it('config absent: a perfectly overlapping cross-project memory passes BOTH guards (today\'s behavior)', () => {
    assert.equal(passesCrossProjectGuard(privateMem, OTHER_PROJECT, queryFp), true);
    assert.equal(surfacesInScopedRecall(privateMem, OTHER_PROJECT, queryFp), true);
  });

  it('config present: the same memory is blocked by BOTH guards regardless of fingerprint', () => {
    writeScopeConfig([PRIVATE_PROJECT]);
    assert.equal(passesCrossProjectGuard(privateMem, OTHER_PROJECT, queryFp), false);
    assert.equal(surfacesInScopedRecall(privateMem, OTHER_PROJECT, queryFp), false);
  });

  it('private is not disabled: inside its own project everything still passes', () => {
    writeScopeConfig([PRIVATE_PROJECT]);
    assert.equal(passesCrossProjectGuard(privateMem, PRIVATE_PROJECT, queryFp), true);
    assert.equal(surfacesInScopedRecall(privateMem, PRIVATE_PROJECT, queryFp), true);
  });

  it('globals are unaffected by the private list (promotion is their gate)', () => {
    writeScopeConfig([PRIVATE_PROJECT]);
    const globalMem = { project: null, fingerprint: OVERLAPPING_FP };
    assert.equal(passesCrossProjectGuard(globalMem, OTHER_PROJECT, queryFp), true);
  });
});

// --- Hook-surface harness ----------------------------------------------------

function makeHookClient(db: Database.Database): CachedHookContext {
  return {
    db,
    memoryRepo: new MemoryRepository(db),
    planRepo: new PlanRepository(db),
    reminderRepo: new ReminderRepository(db),
    contextRepo: new ContextRepository(db),
    investigationRepo: new InvestigationRepository(db),
    close: () => db.close(),
  } as unknown as CachedHookContext;
}

function seedPrivatePitfall(repo: MemoryRepository): void {
  repo.create({
    content: PRIVATE_MARKER,
    kind: 'pitfall',
    project: PRIVATE_PROJECT,
    confidence: 1.0,
    fingerprint: OVERLAPPING_FP,
  });
}

// The hook handlers derive their project from cwd — seeding under any
// other id makes an absence assertion pass against EMPTY output (the
// original acceptance tests did exactly that; reviewer F8). Everything
// below seeds under the cwd-derived id and pairs every absence assertion
// with a positive control.
const OPEN_CWD = '/tmp/openproj-scope';
const OPEN_PID = projectId(OPEN_CWD);

describe('hook surfaces never leak a private project cross-project', () => {
  let db: Database.Database;
  let client: CachedHookContext;

  beforeEach(() => {
    db = openDatabase({ dbPath: ':memory:' });
    client = makeHookClient(db);
    writeScopeConfig([PRIVATE_PROJECT]);
    seedPrivatePitfall(client.memoryRepo);
    // A same-project memory proves each surface still renders content —
    // anchored to billing.ts so the pitfall surface's relevance gate hits.
    client.memoryRepo.create({
      content: 'OPEN-PROJECT pitfall about hooks and billing handlers',
      kind: 'pitfall',
      project: OPEN_PID,
      confidence: 0.9,
      fingerprint: OVERLAPPING_FP,
      anchor: 'billing.ts',
    });
    client.contextRepo.store(OPEN_PID, TS_CONTEXT);
  });

  afterEach(() => db.close());

  it('SURFACE 1 — session-start briefing', () => {
    const ctx: BriefingContext = {
      project: OPEN_PID,
      sessionType: 'startup',
      interrupted: false,
      projectContext: TS_CONTEXT,
      briefingMode: 'full',
      maxPitfalls: 5,
    };
    const briefing = compileBriefing(client.memoryRepo, client.planRepo, ctx);
    const text = typeof briefing === 'string' ? briefing : JSON.stringify(briefing);
    assert.ok(!text.includes(PRIVATE_MARKER), 'private content must not appear in another project\'s briefing');
    assert.ok(text.includes('OPEN-PROJECT'), 'surface still renders same-project content');
  });

  it('SURFACE 2 — prompt-check injection', () => {
    const input = {
      session_id: 'scope-s1',
      transcript_path: null,
      cwd: OPEN_CWD,
      hook_event_name: 'UserPromptSubmit',
      prompt: 'fix the billing exports handler hooks bug',
    } as unknown as UserPromptSubmitInput;
    const result = handlePromptCheck(input, client);
    const text = JSON.stringify(result ?? {});
    assert.ok(!text.includes(PRIVATE_MARKER), 'private content must not appear in prompt injection');
    assert.ok(text.includes('OPEN-PROJECT'), 'positive control: the surface renders same-project content');
  });

  it('SURFACE 3 — pitfall-check injection', () => {
    const input = {
      session_id: 'scope-s1',
      transcript_path: null,
      cwd: OPEN_CWD,
      hook_event_name: 'PreToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: `${OPEN_CWD}/src/hooks/billing.ts` },
    } as unknown as PreToolUseInput;
    const result = handlePitfallCheck(input, client);
    const text = JSON.stringify(result ?? {});
    assert.ok(!text.includes(PRIVATE_MARKER), 'private content must not appear in pitfall warnings');
    assert.ok(text.includes('OPEN-PROJECT'), 'positive control: the surface renders same-project content');
  });

  it('SURFACE 4 — subagent context', () => {
    const input = {
      session_id: 'scope-s1',
      transcript_path: null,
      cwd: OPEN_CWD,
      hook_event_name: 'SubagentStart',
      agent_id: 'a1',
      agent_type: 'general',
    } as unknown as SubagentStartInput;
    const result = handleSubagentContext(input, client);
    const text = JSON.stringify(result ?? {});
    assert.ok(!text.includes(PRIVATE_MARKER), 'private content must not appear in subagent context');
    assert.ok(text.includes('OPEN-PROJECT'), 'positive control: the surface renders same-project content');
  });

  function seedCoRecallBridge(): void {
    // Cairn builds the bridge itself: a legitimate recall INSIDE the
    // private project pairs the private row with a global; prediction
    // then dereferences the private id by RAW id in another project —
    // the one hook path where a cross-project row arrives unfetched.
    const global_ = client.memoryRepo.create({
      content: 'GLOBAL-BILLING pitfall validate billing handler hooks input',
      kind: 'pitfall',
      project: null,
      confidence: 1.0,
      fingerprint: OVERLAPPING_FP,
      anchor: 'billing.ts',
    });
    const priv = client.memoryRepo.create({
      content: PRIVATE_MARKER, kind: 'pitfall', project: PRIVATE_PROJECT,
      confidence: 1.0, fingerprint: OVERLAPPING_FP,
    });
    // Twice: the prompt layer's MIN_CO_COUNT is 2 (pitfall needs 1).
    client.memoryRepo.trackCoRecall('own-project-recall', [global_.id, priv.id]);
    client.memoryRepo.trackCoRecall('own-project-recall-2', [global_.id, priv.id]);
  }

  // Each surface gets its OWN differential with FRESH session ids per
  // call: the pitfall pass records injected ids in the session tracker,
  // and prompt Layer 1b skips already-injected ids — a shared session
  // would let dedup mask a removed guard (reviewer C4).
  const pitfallInput = (sess: string): PreToolUseInput => ({
    session_id: sess, transcript_path: null, cwd: OPEN_CWD,
    hook_event_name: 'PreToolUse', tool_name: 'Edit',
    tool_input: { file_path: `${OPEN_CWD}/src/hooks/billing.ts` },
  } as unknown as PreToolUseInput);
  const promptInput = (sess: string): UserPromptSubmitInput => ({
    session_id: sess, transcript_path: null, cwd: OPEN_CWD,
    hook_event_name: 'UserPromptSubmit',
    prompt: 'fix the billing handler hooks validation bug',
  } as unknown as UserPromptSubmitInput);

  it('PITFALL-surface co-recall differential — leak without the policy, blocked with it', () => {
    seedCoRecallBridge();
    removeScopeConfig();
    const open = JSON.stringify(handlePitfallCheck(pitfallInput('pit-off'), client) ?? {});
    assert.ok(open.includes(PRIVATE_MARKER),
      'differential premise: without config, prediction surfaces the cross-project row');
    writeScopeConfig([PRIVATE_PROJECT]);
    const closed = JSON.stringify(handlePitfallCheck(pitfallInput('pit-on'), client) ?? {});
    assert.ok(!closed.includes(PRIVATE_MARKER), 'pitfall-surface prediction is guarded');
  });

  it('PROMPT-surface co-recall differential — leak without the policy, blocked with it', () => {
    seedCoRecallBridge();
    removeScopeConfig();
    const open = JSON.stringify(handlePromptCheck(promptInput('prm-off'), client) ?? {});
    assert.ok(open.includes(PRIVATE_MARKER),
      'differential premise: without config, the prompt surface renders the cross-project row');
    writeScopeConfig([PRIVATE_PROJECT]);
    const closed = JSON.stringify(handlePromptCheck(promptInput('prm-on'), client) ?? {});
    assert.ok(!closed.includes(PRIVATE_MARKER), 'prompt-surface prediction is guarded');
  });
});

// --- MCP recall (surface 5) + promotion guard --------------------------------

describe('MCP surfaces', () => {
  let db: Database.Database;
  let repo: MemoryRepository;
  let server: McpServer;
  let client: Client;
  let sessionCache: SessionCache;

  beforeEach(async () => {
    db = openDatabase({ dbPath: ':memory:' });
    repo = new MemoryRepository(db);
    sessionCache = new SessionCache();
    server = new McpServer({ name: 'scope-test', version: '0.0.0' });
    const contextRepo = new ContextRepository(db);
    contextRepo.store(OTHER_PROJECT, TS_CONTEXT);
    registerMemoryTools(server, repo, () => 'normal', server.server, new EdgeRepository(db), sessionCache, undefined, contextRepo);
    registerPortabilityTools(server, repo, () => 'normal', sessionCache);
    registerStatsTools(server, repo, new PlanRepository(db), new ReminderRepository(db), db, () => 'normal');
    registerResources(server, new PlanRepository(db), repo, () => 'normal');
    registerPlanTool(server, new PlanRepository(db), repo, () => 'normal', sessionCache);
    registerReminderTools(server, new ReminderRepository(db), () => 'normal', sessionCache);
    // The MCP session "runs in" the open project unless a test says otherwise.
    setSessionProjectForTests(OTHER_PROJECT);
    client = new Client({ name: 'scope-test-client', version: '0.0.0' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);
  });

  afterEach(async () => {
    await client.close();
    await server.close();
    sessionCache.destroy();
    db.close();
  });

  async function call(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
    const result = await client.callTool({ name, arguments: args });
    const { content, isError } = result as { content?: unknown; isError?: boolean };
    const text = (content as Array<{ type: string; text?: string }>)
      .filter(c => c.type === 'text' && typeof c.text === 'string')
      .map(c => c.text as string).join('\n');
    return { text, isError: isError === true };
  }

  it('SURFACE 5 — recall: private rows blocked from other-project AND bare recalls; own project unaffected', async () => {
    seedPrivatePitfall(repo);
    writeScopeConfig([PRIVATE_PROJECT]);

    const scoped = await call('cairn_recall', { query: 'billing exports pitfall', project: OTHER_PROJECT });
    assert.ok(!scoped.text.includes(PRIVATE_MARKER), 'blocked in another project\'s recall');

    const bare = await call('cairn_recall', { query: 'billing exports pitfall' });
    assert.ok(!bare.text.includes(PRIVATE_MARKER), 'blocked in a bare (unscoped) recall');

    // Naming the project from OUTSIDE it is not consent (the `project`
    // argument selects scope, the SESSION establishes standing):
    const named = await call('cairn_recall', { query: 'billing exports pitfall', project: PRIVATE_PROJECT });
    assert.ok(!named.text.includes(PRIVATE_MARKER), 'caller-supplied project cannot read a private project from elsewhere');

    setSessionProjectForTests(PRIVATE_PROJECT);
    const own = await call('cairn_recall', { query: 'billing exports pitfall', project: PRIVATE_PROJECT });
    assert.ok(own.text.includes(PRIVATE_MARKER), 'still recallable from a session inside the project');
  });

  it('SURFACE 5 differential — the reachable leak is GRAPH ENRICHMENT: a private row rides a 1-hop edge into another project\'s recall without config, and is blocked with it', async () => {
    // Direct fetches are SQL-scoped to (project OR NULL), so the reachable
    // cross-project path is enrichWithGraphNeighbors, whose edge join has
    // no project filter. Construct exactly that leak.
    const own = repo.create({ content: 'OWN-ROW billing exports handler notes', kind: 'fact', project: OTHER_PROJECT, confidence: 0.9, fingerprint: OVERLAPPING_FP });
    const priv = repo.create({ content: PRIVATE_MARKER, kind: 'pitfall', project: PRIVATE_PROJECT, confidence: 1.0, fingerprint: OVERLAPPING_FP });
    new EdgeRepository(db).createEdge(own.id, priv.id, 'informs', 1.0);

    removeScopeConfig();
    const open = await call('cairn_recall', { query: 'billing exports handler', project: OTHER_PROJECT });
    assert.ok(open.text.includes(PRIVATE_MARKER),
      'without config the edge-neighbor private row surfaces — proving the leak the policy closes is real');

    writeScopeConfig([PRIVATE_PROJECT]);
    const closed = await call('cairn_recall', { query: 'billing exports handler', project: OTHER_PROJECT });
    assert.ok(closed.text.includes('OWN-ROW'), 'own row still returned');
    assert.ok(!closed.text.includes(PRIVATE_MARKER), 'the private neighbor is blocked');
  });

  it("scope: 'project' returns only the project's own rows (globals excluded)", async () => {
    repo.create({ content: 'GLOBAL-LESSON prefer WAL mode', kind: 'fact', project: null, confidence: 0.9 });
    repo.create({ content: 'OWN-ROW billing schema quirk', kind: 'fact', project: OTHER_PROJECT, confidence: 0.9 });
    const all = await call('cairn_recall', { query: 'WAL billing schema', project: OTHER_PROJECT });
    assert.ok(all.text.includes('GLOBAL-LESSON'), 'default scope includes globals');
    const projOnly = await call('cairn_recall', { query: 'WAL billing schema', project: OTHER_PROJECT, scope: 'project' });
    assert.ok(!projOnly.text.includes('GLOBAL-LESSON'), "scope:'project' excludes globals");
    assert.ok(projOnly.text.includes('OWN-ROW'), 'own rows still returned');

    const noProject = await call('cairn_recall', { query: 'WAL billing schema', scope: 'project' });
    assert.equal(noProject.isError, true, "scope:'project' without a project is a caller error, not a silent no-op");
  });

  it('cairn_expand redacts private rows for other sessions — no short-id content oracle', async () => {
    const priv = repo.create({ content: PRIVATE_MARKER, kind: 'pitfall', project: PRIVATE_PROJECT, confidence: 0.9 });
    writeScopeConfig([PRIVATE_PROJECT]);
    const redacted = await call('cairn_expand', { ids: [`pit:${priv.id.slice(0, 8)}`] });
    assert.ok(!redacted.text.includes(PRIVATE_MARKER), 'content must not be readable by short-id from elsewhere');
    assert.match(redacted.text, /private project/);

    setSessionProjectForTests(PRIVATE_PROJECT);
    const own = await call('cairn_expand', { ids: [`pit:${priv.id.slice(0, 8)}`] });
    assert.ok(own.text.includes(PRIVATE_MARKER), 'expand works from inside the project');
  });

  it('cairn_cleanup preview and cairn_stats health redact private content', async () => {
    repo.create({ content: PRIVATE_MARKER, kind: 'pitfall', project: PRIVATE_PROJECT, confidence: 0.9 });
    writeScopeConfig([PRIVATE_PROJECT]);
    const preview = await call('cairn_cleanup', { action: 'preview', filter: { project: PRIVATE_PROJECT } });
    assert.ok(!preview.text.includes(PRIVATE_MARKER), 'cleanup preview samples are redacted');
    const health = await call('cairn_stats', { action: 'health' });
    assert.ok(!health.text.includes(PRIVATE_MARKER), 'stats health previews are redacted');
  });

  it('cairn_export excludes private rows outside the project and SAYS so; includes them inside', async () => {
    repo.create({ content: PRIVATE_MARKER, kind: 'pitfall', project: PRIVATE_PROJECT, confidence: 0.9 });
    repo.create({ content: 'ordinary exported row', kind: 'fact', project: OTHER_PROJECT, confidence: 0.9 });
    writeScopeConfig([PRIVATE_PROJECT]);

    const outside = await call('cairn_export', {});
    assert.ok(!outside.text.includes(PRIVATE_MARKER), 'unfiltered export must not carry private content');
    assert.match(outside.text, /1 record\(s\) from private project\(s\) excluded/, 'exclusion is reported, never silent');

    setSessionProjectForTests(PRIVATE_PROJECT);
    const inside = await call('cairn_export', { project: PRIVATE_PROJECT });
    assert.ok(inside.text.includes(PRIVATE_MARKER), 'export from within the project is complete');
  });

  it('the briefing resource refuses a private project from other sessions', async () => {
    repo.create({ content: PRIVATE_MARKER, kind: 'pitfall', project: PRIVATE_PROJECT, confidence: 0.9 });
    writeScopeConfig([PRIVATE_PROJECT]);
    const res = await client.readResource({ uri: `cairn://briefing/${PRIVATE_PROJECT}` });
    const text = (res.contents as Array<{ text?: string }>).map(c => c.text ?? '').join('\n');
    assert.ok(!text.includes(PRIVATE_MARKER), 'resource must not render private content cross-session');
    assert.match(text, /marked private/);

    setSessionProjectForTests(PRIVATE_PROJECT);
    const own = await client.readResource({ uri: `cairn://briefing/${PRIVATE_PROJECT}` });
    const ownText = (own.contents as Array<{ text?: string }>).map(c => c.text ?? '').join('\n');
    assert.ok(ownText.includes(PRIVATE_MARKER), 'resource renders from inside the project');
  });

  it('strict restore cannot move a private row out of its project without from_private (the second door, closed)', async () => {
    const priv = repo.create({ content: PRIVATE_MARKER, kind: 'pitfall', project: PRIVATE_PROJECT, confidence: 0.9 });
    writeScopeConfig([PRIVATE_PROJECT]);
    // Build the restore doc with the REAL exporter (from inside the
    // project), then flip its project to global — the exact record a
    // backup-restore would replay after a scope edit.
    setSessionProjectForTests(PRIVATE_PROJECT);
    const exported = await call('cairn_export', { project: PRIVATE_PROJECT });
    assert.ok(exported.text.includes(PRIVATE_MARKER), 'premise: export from inside is complete');
    const doc = exported.text.replaceAll(`"project":${JSON.stringify(PRIVATE_PROJECT)}`, '"project":null');
    assert.notEqual(doc, exported.text, 'premise: the doc actually changes the scope');
    setSessionProjectForTests(OTHER_PROJECT);

    // Also seed an ordinary row INTO the doc so atomicity is observable:
    // the refused private change must roll back EVERYTHING.
    const ordinary = repo.create({ content: 'ordinary original', kind: 'fact', project: OTHER_PROJECT, confidence: 0.9 });
    setSessionProjectForTests(OTHER_PROJECT);
    const ordinaryDoc = (await call('cairn_export', { project: OTHER_PROJECT })).text
      .replace('ordinary original', 'ordinary replacement');
    const combined = `${ordinaryDoc}\n${doc.split('\n').slice(4).join('\n')}`;

    const refused = await call('cairn_ingest', { content: combined, mode: 'restore' });
    assert.equal(refused.isError, true);
    assert.match(refused.text, /aborted, NOTHING was written/);
    assert.equal(repo.findById(priv.id)?.project, PRIVATE_PROJECT, 'private row untouched');
    assert.equal(repo.findById(ordinary.id)?.content, 'ordinary original',
      'ATOMICITY: the ordinary record in the same doc must roll back too');

    // The flag alone is not standing: from outside, still aborted.
    const flagOnly = await call('cairn_ingest', { content: doc, mode: 'restore', from_private: true });
    assert.equal(flagOnly.isError, true, 'from_private without a session inside the project is refused');

    // Standing + acknowledgment applies the change.
    setSessionProjectForTests(PRIVATE_PROJECT);
    const acked = await call('cairn_ingest', { content: doc, mode: 'restore', from_private: true });
    assert.equal(acked.isError, false);
    assert.equal(repo.findById(priv.id)?.project, null, 'acknowledged restore applies the scope change');
  });

  it('plan tool, plan resource, and reminders are session-bound (the surfaces the first sweep missed)', async () => {
    writeScopeConfig([PRIVATE_PROJECT]);
    const planRepo2 = new PlanRepository(db);
    planRepo2.create({ name: 'PRIVATE-PLAN quarterly reconciliation', project: PRIVATE_PROJECT, steps: [{ description: 'PRIVATE-STEP export payment tokens' }] });
    const reminderRepo2 = new ReminderRepository(db);
    reminderRepo2.create({ trigger: 'ACME invoice', action: 'PRIVATE-REMINDER check settlement terms', project: PRIVATE_PROJECT });

    const planGet = await call('cairn_plan', { action: 'get', project: PRIVATE_PROJECT });
    assert.ok(!planGet.text.includes('PRIVATE-PLAN'), 'cairn_plan get is bound');
    assert.match(planGet.text, /marked private/);
    const planRes = await client.readResource({ uri: `cairn://plan/${PRIVATE_PROJECT}/active` });
    const planText = (planRes.contents as Array<{ text?: string }>).map(c => c.text ?? '').join('\n');
    assert.ok(!planText.includes('PRIVATE-PLAN'), 'plan resource is bound');
    const reminders = await call('cairn_reminder_list', {});
    assert.ok(!reminders.text.includes('PRIVATE-REMINDER'), 'reminder list is bound');

    setSessionProjectForTests(PRIVATE_PROJECT);
    const own = await call('cairn_plan', { action: 'get', project: PRIVATE_PROJECT });
    assert.ok(own.text.includes('PRIVATE-PLAN'), 'plan readable from inside');
    const ownReminders = await call('cairn_reminder_list', { project: PRIVATE_PROJECT });
    assert.ok(ownReminders.text.includes('PRIVATE-REMINDER'), 'reminders readable from inside');
  });

  it('mutations follow readability: forget/correct/cleanup-execute cannot touch private rows from outside', async () => {
    const mem = repo.create({ content: PRIVATE_MARKER, kind: 'pitfall', project: PRIVATE_PROJECT, confidence: 0.9 });
    writeScopeConfig([PRIVATE_PROJECT]);

    const forgot = await call('cairn_forget', { id: mem.id });
    assert.equal(forgot.isError, true);
    assert.match(forgot.text, /private project/);
    assert.ok(repo.findById(mem.id), 'row survives cairn_forget from outside');

    const corrected = await call('cairn_correct', { id: mem.id, action: 'invalidate' });
    assert.equal(corrected.isError, true);
    assert.ok(!repo.findById(mem.id)?.invalidated, 'row survives cairn_correct from outside');

    const cleaned = await call('cairn_cleanup', { action: 'execute', filter: { project: PRIVATE_PROJECT } });
    assert.match(cleaned.text, /deleted 0.*skipped/s, 'cleanup execute skips private rows and says so');
    assert.ok(repo.findById(mem.id), 'row survives cleanup execute from outside');

    setSessionProjectForTests(PRIVATE_PROJECT);
    const ownForget = await call('cairn_forget', { id: mem.id });
    assert.equal(ownForget.isError, false, 'the owner session can still delete');
  });

  it('promotion out of a private project requires STANDING (session inside) and the acknowledgment', async () => {
    const mem = repo.create({ content: PRIVATE_MARKER, kind: 'pitfall', project: PRIVATE_PROJECT, confidence: 0.9 });
    writeScopeConfig([PRIVATE_PROJECT]);

    // From OUTSIDE: refused even WITH the flag, and the refusal must not
    // name the flag (an instruction to re-run with it is the path of
    // least resistance for an autonomous agent).
    const outside = await call('cairn_promote', { id: mem.id, from_private: true });
    assert.equal(outside.isError, true);
    assert.ok(!outside.text.includes('from_private'), 'outside-refusal must not name the bypass flag');
    assert.match(outside.text, /session inside/);
    assert.equal(repo.findById(mem.id)?.project, PRIVATE_PROJECT, 'not promoted');

    // From INSIDE: the flag is still required (deliberate act) ...
    setSessionProjectForTests(PRIVATE_PROJECT);
    const noFlag = await call('cairn_promote', { id: mem.id });
    assert.equal(noFlag.isError, true);
    assert.match(noFlag.text, /from_private: true/);

    // ... and then it works.
    const acked = await call('cairn_promote', { id: mem.id, from_private: true });
    assert.equal(acked.isError, false);
    assert.equal(repo.findById(mem.id)?.project, null, 'promoted with standing + acknowledgment');
  });

  it('promotion from a NON-private project is unaffected by the config', async () => {
    const mem = repo.create({ content: 'ordinary lesson', kind: 'pitfall', project: OTHER_PROJECT, confidence: 0.9 });
    writeScopeConfig([PRIVATE_PROJECT]);
    const promoted = await call('cairn_promote', { id: mem.id });
    assert.equal(promoted.isError, false);
    assert.match(promoted.text, /promoted to global/);
  });
});
