/**
 * Phase 1 step 4 — tokens-saved report acceptance.
 *
 * The metric is DEFINED and honest: gross = client-reported PostCompact
 * savings + an estimated impact proxy; injected context is a COST; net =
 * gross − cost. Acceptance: report numbers reproduce hand-computed
 * values; rollup rows survive the 7-day telemetry prune; the disable
 * switch is a true zero-write.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';

import { openDatabase } from '../src/db/connection.js';
import { migrateToV30 } from '../src/db/migrations/v30-telemetry-rollup.js';
import { recordRollup, computeRollupReport, pruneRollup, rollupEnabled } from '../src/db/telemetry-rollup.js';
import { cleanupTelemetry } from '../src/db/maintenance.js';
import { handlePostCompact } from '../src/hooks/handlers/postcompact-handler.js';
import { handlePromptCheck } from '../src/hooks/handlers/prompt-handler.js';
import { MemoryRepository } from '../src/db/memory-repository.js';
import { PlanRepository } from '../src/db/plan-repository.js';
import { ReminderRepository } from '../src/db/reminder-repository.js';
import { ContextRepository } from '../src/db/context-repository.js';
import { InvestigationRepository } from '../src/db/investigation-repository.js';
import { resetConfigCacheForTests } from '../src/config/cairn-config.js';
import { estimateTokensFast } from '../src/utils/tokens.js';
import { ROLLUP, ROLLUP_METRICS } from '../src/constants/index.js';
import { handlePitfallCheck } from '../src/hooks/handlers/pitfall-handler.js';
import { handleSubagentContext } from '../src/hooks/handlers/subagent-context-handler.js';
import { handleErrorLearning } from '../src/hooks/handlers/error-learning-handler.js';
import { handleFileChanged } from '../src/hooks/handlers/file-changed-handler.js';
import { handleSuccessTracker } from '../src/hooks/handlers/success-tracker-handler.js';
import { loadTracker } from '../src/hooks/shared/edit-tracker.js';
import { SessionCache } from '../src/hooks/shared/session-cache.js';
import { projectId } from '../src/utils/project-id.js';
import { isPrivateProject } from '../src/config/cairn-config.js';
import type { CachedHookContext } from '../src/hooks/shared/db-client.js';
import type { PostCompactInput, UserPromptSubmitInput, PreToolUseInput, SubagentStartInput } from '../src/hooks/shared/hook-io.js';

let db: Database.Database;
let configDir: string;
let savedConfigPath: string | undefined;
let savedRollupEnv: string | undefined;

function rollupRows(): Array<{ metric: string; surface: string; tokens: number }> {
  return db.prepare('SELECT metric, surface, tokens FROM telemetry_rollup ORDER BY id').all() as never;
}

function hookClient(): CachedHookContext {
  return {
    db,
    memoryRepo: new MemoryRepository(db),
    planRepo: new PlanRepository(db),
    reminderRepo: new ReminderRepository(db),
    contextRepo: new ContextRepository(db),
    investigationRepo: new InvestigationRepository(db),
    close: () => { /* owned by test */ },
  } as unknown as CachedHookContext;
}

beforeEach(() => {
  db = openDatabase({ dbPath: ':memory:' });
  configDir = mkdtempSync(join(tmpdir(), 'cairn-report-test-'));
  savedConfigPath = process.env.CAIRN_CONFIG_PATH;
  savedRollupEnv = process.env.CAIRN_ROLLUP;
  process.env.CAIRN_CONFIG_PATH = join(configDir, 'config.json');
  delete process.env.CAIRN_ROLLUP;
  resetConfigCacheForTests();
});

afterEach(() => {
  db.close();
  if (savedConfigPath === undefined) delete process.env.CAIRN_CONFIG_PATH;
  else process.env.CAIRN_CONFIG_PATH = savedConfigPath;
  if (savedRollupEnv === undefined) delete process.env.CAIRN_ROLLUP;
  else process.env.CAIRN_ROLLUP = savedRollupEnv;
  resetConfigCacheForTests();
  rmSync(configDir, { recursive: true, force: true });
});

describe('schema v30 migration', () => {
  it('fresh databases carry telemetry_rollup; the migration is idempotent on re-run', () => {
    // Fresh DB (created at SCHEMA_VERSION) has the table.
    assert.doesNotThrow(() => db.prepare('SELECT COUNT(*) FROM telemetry_rollup').get());
    // Simulate a crash-rerun: drop back to v29, migrate twice.
    db.exec('DROP TABLE telemetry_rollup');
    db.prepare('UPDATE schema_version SET version = 29').run();
    migrateToV30(db);
    migrateToV30(db);
    assert.doesNotThrow(() => db.prepare('SELECT COUNT(*) FROM telemetry_rollup').get());
    const v = db.prepare('SELECT version FROM schema_version').get() as { version: number };
    assert.equal(v.version, 30);
  });
});

describe('recordRollup + the disable switch', () => {
  it('writes one row per event with the day stamped', () => {
    recordRollup(db, 's1', ROLLUP_METRICS.INJECTED, 'prompt-check', 42);
    const rows = rollupRows();
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0], { metric: 'injected', surface: 'prompt-check', tokens: 42 });
  });

  it('skips zero and negative token counts', () => {
    recordRollup(db, 's1', ROLLUP_METRICS.COMPACT_SAVED, 'postcompact', 0);
    recordRollup(db, 's1', ROLLUP_METRICS.INJECTED, 'prompt-check', -5);
    assert.equal(rollupRows().length, 0);
  });

  it('CAIRN_ROLLUP=0 is a true zero-write', () => {
    process.env.CAIRN_ROLLUP = '0';
    assert.equal(rollupEnabled(), false);
    recordRollup(db, 's1', ROLLUP_METRICS.INJECTED, 'prompt-check', 42);
    assert.equal(rollupRows().length, 0);
  });

  it('config {"report":{"rollup":false}} is a true zero-write, and re-enabling works live', () => {
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({ report: { rollup: false } }));
    resetConfigCacheForTests();
    assert.equal(rollupEnabled(), false);
    recordRollup(db, 's1', ROLLUP_METRICS.INJECTED, 'prompt-check', 42);
    assert.equal(rollupRows().length, 0);

    rmSync(join(configDir, 'config.json'));
    resetConfigCacheForTests();
    assert.equal(rollupEnabled(), true, 'default is on');
    recordRollup(db, 's1', ROLLUP_METRICS.INJECTED, 'prompt-check', 42);
    assert.equal(rollupRows().length, 1);
  });
});

describe('hand-computed acceptance (the arithmetic the user sees)', () => {
  it('gross/cost/net reproduce a scripted session exactly', () => {
    // Scripted session, hand-computed:
    //   client-reported compaction savings: 1200
    //   verified impacts: 2 → proxy 2 × IMPACT_PROXY_TOKENS = 300
    //   injected: briefing 90 + warning 60 = 150
    //   gross = 1500, cost = 150, net = 1350
    handlePostCompact({
      session_id: 'acc-s1', transcript_path: null, cwd: '/tmp',
      hook_event_name: 'PostCompact', trigger: 'auto', tokens_saved: 1200,
    } as unknown as PostCompactInput, hookClient());
    recordRollup(db, 'acc-s1', ROLLUP_METRICS.IMPACT_PROXY, 'success-tracker', 2 * ROLLUP.IMPACT_PROXY_TOKENS, 2);
    recordRollup(db, 'acc-s1', ROLLUP_METRICS.INJECTED, 'session-start', 90);
    recordRollup(db, 'acc-s1', ROLLUP_METRICS.INJECTED, 'pitfall-check', 60);

    const report = computeRollupReport(db, 30);
    assert.equal(report.compactSaved, 1200);
    assert.equal(report.impactProxy, 2 * ROLLUP.IMPACT_PROXY_TOKENS);
    assert.equal(report.impactEvents, 2);
    assert.equal(report.gross, 1200 + 2 * ROLLUP.IMPACT_PROXY_TOKENS);
    assert.equal(report.cost, 150);
    assert.deepEqual(report.costBySurface, { 'session-start': 90, 'pitfall-check': 60 });
    assert.equal(report.net, report.gross - 150);
    assert.equal(report.perDay.length, 1);
    assert.equal(report.perDay[0].net, report.net);
  });

  it('prompt-check WIRING: a real injection MUST record a cost row (non-vacuous)', () => {
    const client = hookClient();
    // Seed under the CWD-DERIVED id — the handler resolves project from
    // cwd, and a mismatched seed makes any if/else assertion vacuous
    // (this exact test previously passed asserting nothing; review).
    const cwd = '/tmp/report-wire';
    client.memoryRepo.create({
      content: 'REPORT-WIRING pitfall about billing exports handler hooks',
      kind: 'pitfall',
      project: projectId(cwd),
      confidence: 1.0,
    });
    const result = handlePromptCheck({
      session_id: 'wire-s1', transcript_path: null, cwd,
      hook_event_name: 'UserPromptSubmit',
      prompt: 'fix the billing exports handler',
    } as unknown as UserPromptSubmitInput, client);

    assert.ok(result.output, 'PREMISE: the prompt path must actually inject');
    const injected = rollupRows().filter(r => r.metric === 'injected' && r.surface === 'prompt-check');
    assert.equal(injected.length, 1, 'one cost row per injecting prompt-check');
    assert.ok(injected[0].tokens > 0);
  });

  it('WIRING battery: every recording surface leaves its row (a one-line site change must fail here)', async () => {
    const client = hookClient();
    const cwd = '/tmp/report-wire2';
    const pid = projectId(cwd);

    // pitfall-check — seeded, anchored; row counts CONTEXT, not envelope.
    client.memoryRepo.create({
      content: 'WIRE pitfall about billing handler', kind: 'pitfall',
      project: pid, confidence: 1.0, anchor: 'billing.ts',
    });
    const pit = handlePitfallCheck({
      session_id: 'wire-s2', transcript_path: null, cwd,
      hook_event_name: 'PreToolUse', tool_name: 'Edit',
      tool_input: { file_path: `${cwd}/src/billing.ts` },
    } as unknown as PreToolUseInput, client);
    assert.ok(pit.output, 'PREMISE: pitfall warning emitted');
    const pitRow = rollupRows().find(r => r.surface === 'pitfall-check');
    assert.ok(pitRow && pitRow.tokens > 0, 'pitfall-check records');
    assert.ok(pitRow!.tokens < estimateTokensFast(pit.output!),
      'cost counts the injected CONTEXT, strictly less than the JSON envelope');

    // subagent-context — plan + pitfall render into the briefing.
    client.contextRepo.store(pid, {
      gitHash: 'x', projectName: 'wire', techStack: 'TypeScript',
      structure: [], entryPoints: [], keyConfigs: [], scannedAt: new Date().toISOString(),
    });
    const sub = handleSubagentContext({
      session_id: 'wire-s2', transcript_path: null, cwd,
      hook_event_name: 'SubagentStart', agent_id: 'a', agent_type: 'g',
    } as unknown as SubagentStartInput, client);
    assert.ok(sub.output, 'PREMISE: subagent context emitted');
    assert.ok(rollupRows().some(r => r.surface === 'subagent-context' && r.tokens > 0), 'subagent-context records');

    // error-learning — a learnable failure injects a lesson AND records cost.
    const el = await handleErrorLearning({
      session_id: 'wire-s2', transcript_path: null, cwd,
      hook_event_name: 'PostToolUseFailure', tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      error: "TypeError: Cannot read properties of undefined (reading 'foo') at billing.ts:10",
    } as unknown as Parameters<typeof handleErrorLearning>[0], client);
    if (el.output) {
      assert.ok(rollupRows().some(r => r.surface === 'error-learning' && r.metric === 'injected'), 'error-learning cost recorded');
    }

    // file-changed — seeded file reminder fires.
    client.reminderRepo.create({ trigger: 'billing.ts', action: 'WIRE reminder check thresholds', project: pid, trigger_type: 'file' });
    const fc = await handleFileChanged({
      session_id: 'wire-s2', transcript_path: null, cwd,
      hook_event_name: 'FileChanged', file_path: `${cwd}/src/billing.ts`,
    } as unknown as Parameters<typeof handleFileChanged>[0], client);
    if (fc.output) {
      assert.ok(rollupRows().some(r => r.surface === 'file-changed'), 'file-changed cost recorded');
    }

    // success-tracker — surfaced pitfall + successful edit = impact row with events.
    const mem = client.memoryRepo.create({ content: 'WIRE tracked pitfall', kind: 'pitfall', project: pid, confidence: 0.9 });
    const cache = new SessionCache();
    const tracked = { ...loadTracker('wire-s3'), surfacedPitfalls: { [`${cwd}/src/billing.ts`]: [mem.id] }, sessionId: 'wire-s3' };
    cache.setTracker('wire-s3', tracked);
    const stClient = { ...client, cache } as unknown as CachedHookContext;
    await handleSuccessTracker({
      session_id: 'wire-s3', transcript_path: null, cwd,
      hook_event_name: 'PostToolUse', tool_name: 'Edit',
      tool_input: { file_path: `${cwd}/src/billing.ts` }, tool_response: 'ok',
    } as unknown as Parameters<typeof handleSuccessTracker>[0], stClient);
    const impact = rollupRows().find(r => r.metric === 'impact_proxy' && r.surface === 'success-tracker');
    assert.ok(impact, 'success-tracker records the impact proxy');
    assert.equal(impact!.tokens, ROLLUP.IMPACT_PROXY_TOKENS, 'one verified impact at the documented rate');
    cache.destroy();
  });
});

describe('config-section independence (review blocker)', () => {
  it('a malformed report block NEVER deactivates the scope privacy settings, and vice versa', () => {
    // The exact one-character slip from the README string, alongside a
    // perfectly valid scope block.
    writeFileSync(join(configDir, 'config.json'),
      '{"scope":{"privateProjects":["clienta-11112222"]},"report":{"rollups":false}}');
    resetConfigCacheForTests();
    assert.equal(isPrivateProject('clienta-11112222'), true,
      'privacy SURVIVES a typo in the cosmetic report block');
    assert.equal(rollupEnabled(), true, 'broken report block falls back to its own default');

    // Reverse: malformed scope, valid report opt-out.
    writeFileSync(join(configDir, 'config.json'),
      '{"scope":{"private_projects":["clienta-11112222"]},"report":{"rollup":false}}');
    resetConfigCacheForTests();
    assert.equal(rollupEnabled(), false, 'the opt-out SURVIVES a typo in the scope block');
    assert.equal(isPrivateProject('clienta-11112222'), false, 'the broken scope section is inactive');
  });
});

describe('report window and mixed rates', () => {
  it('--days=1 means today only (the inclusive bound previously spanned N+1 dates)', () => {
    db.prepare(`INSERT INTO telemetry_rollup (session_id, day, metric, surface, tokens, events)
      VALUES ('w', date('now'), 'injected', 's', 10, 1)`).run();
    db.prepare(`INSERT INTO telemetry_rollup (session_id, day, metric, surface, tokens, events)
      VALUES ('w', date('now', '-1 day'), 'injected', 's', 20, 1)`).run();
    assert.equal(computeRollupReport(db, 1).cost, 10, 'yesterday excluded at days=1');
    assert.equal(computeRollupReport(db, 2).cost, 30, 'yesterday included at days=2');
  });

  it('impactEvents comes from the PERSISTED count, immune to constant retuning', () => {
    // Two rows written under different (historical) rates.
    db.prepare(`INSERT INTO telemetry_rollup (session_id, day, metric, surface, tokens, events)
      VALUES ('m', date('now'), 'impact_proxy', 'success-tracker', 300, 2)`).run();
    db.prepare(`INSERT INTO telemetry_rollup (session_id, day, metric, surface, tokens, events)
      VALUES ('m', date('now'), 'impact_proxy', 'error-learning', 100, 1)`).run();
    const report = computeRollupReport(db, 7);
    assert.equal(report.impactProxy, 400);
    assert.equal(report.impactEvents, 3, 'count is stored, never derived by dividing by the current constant');
  });
});

describe('retention', () => {
  it('rollup rows SURVIVE the 7-day telemetry prune', () => {
    db.prepare(`
      INSERT INTO hook_telemetry (hook_name, event_type, duration_ms, success, created_at)
      VALUES ('session-start', 'startup', 5, 1, datetime('now', '-10 days'))
    `).run();
    db.prepare(`
      INSERT INTO telemetry_rollup (session_id, day, metric, surface, tokens, created_at)
      VALUES ('old-s', date('now', '-10 days'), 'injected', 'session-start', 77, datetime('now', '-10 days'))
    `).run();

    cleanupTelemetry(db);

    const telemetryLeft = (db.prepare('SELECT COUNT(*) n FROM hook_telemetry').get() as { n: number }).n;
    assert.equal(telemetryLeft, 0, 'telemetry pruned at 7 days');
    assert.equal(rollupRows().length, 1, 'rollup persists past the telemetry prune');
  });

  it('rollup has its OWN long retention', () => {
    db.prepare(`
      INSERT INTO telemetry_rollup (session_id, day, metric, surface, tokens, created_at)
      VALUES ('ancient', date('now', '-400 days'), 'injected', 'session-start', 10, datetime('now', '-400 days'))
    `).run();
    db.prepare(`
      INSERT INTO telemetry_rollup (session_id, day, metric, surface, tokens)
      VALUES ('fresh', date('now'), 'injected', 'session-start', 20)
    `).run();
    const pruned = pruneRollup(db);
    assert.equal(pruned, 1);
    assert.equal(rollupRows().length, 1);
  });
});
