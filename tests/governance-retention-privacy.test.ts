import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { openDatabase } from '../src/db/connection.js';
import { MemoryRepository } from '../src/db/memory-repository.js';
import { PlanRepository } from '../src/db/plan-repository.js';
import { ReminderRepository } from '../src/db/reminder-repository.js';
import { ContextRepository } from '../src/db/context-repository.js';
import { InvestigationRepository } from '../src/db/investigation-repository.js';
import type { HookDbClient } from '../src/hooks/shared/db-client.js';
import { handleFileChanged } from '../src/hooks/handlers/file-changed-handler.js';
import { recordGovernanceEvent } from '../src/governance/recorder.js';
import { GovernanceRepository } from '../src/governance/repository.js';
import { GovernanceRuleRepository } from '../src/governance/rule-repository.js';
import { projectId } from '../src/utils/project-id.js';
import { runMaintenance } from '../src/db/maintenance.js';
import { ENV } from '../src/constants/env.js';
import { DATA_DIR_NAME } from 'waykeep-contract';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.length = 0;
});

function tempProject(secretInCommand = false, evidenceDays = 30): string {
  const root = mkdtempSync(join(tmpdir(), 'cairn-recorder-privacy-'));
  roots.push(root);
  mkdirSync(join(root, DATA_DIR_NAME));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'a.ts'), 'source\n');
  const argv = secretInCommand
    ? ['env', 'API_TOKEN=needle-command-secret', 'npm', 'test']
    : ['npm', 'test'];
  writeFileSync(join(root, DATA_DIR_NAME, 'gates.json'), JSON.stringify({
    version: 1,
    defaults: { retention: { evidenceDays } },
    gates: {
      test: {
        argv, cwd: '.', parser: 'node-test', timeoutMs: 60_000,
        skips: { max: 0, requireReasons: false },
      },
    },
    pathRules: [{ paths: ['**'], require: ['test'] }],
  }));
  return root;
}

const nodeOutput = (suffix = ''): string =>
  `TAP version 13\nok 1 - works ${suffix}\n1..1\n# tests 1\n# pass 1\n# fail 0\n# skipped 0\n`;

function bashEvent(root: string, id: string, command: string, output: string): unknown {
  return {
    session_id: 'privacy-session', transcript_path: join(root, 'transcript.jsonl'), cwd: root,
    hook_event_name: 'PostToolUse', client_name: 'claude-code', client_version: '1.2.3',
    client_installation_id: 'privacy-install', tool_name: 'Bash', tool_use_id: id,
    tool_input: {
      command,
      private_payload: 'needle-tool-input-secret',
      env: { API_TOKEN: 'needle-env-secret' },
    },
    tool_response: { stdout: output, stderr: '', interrupted: false },
  };
}

function client(db: Database.Database): HookDbClient {
  return {
    db,
    memoryRepo: new MemoryRepository(db),
    planRepo: new PlanRepository(db),
    reminderRepo: new ReminderRepository(db),
    contextRepo: new ContextRepository(db),
    investigationRepo: new InvestigationRepository(db),
    close: () => {},
  };
}

function tableJson(db: Database.Database, table: string, columns = '*'): string {
  return JSON.stringify(db.prepare(`SELECT ${columns} FROM ${table}`).all());
}

describe('governance recorder privacy and retention (A5)', () => {
  it('keeps ephemeral tool input/output out of every durable and generic surface', async () => {
    const root = tempProject(true);
    const db = openDatabase({ dbPath: ':memory:' });
    try {
      const outputSecret = 'needle-output-secret';
      const command = 'env API_TOKEN=needle-command-secret npm test';
      const result = await recordGovernanceEvent(db, bashEvent(
        root, 'privacy-1', command, nodeOutput(outputSecret),
      ));
      assert.equal(result.status, 'recorded');
      assert.equal(result.gateRuns, 1);

      const event = db.prepare(`
        SELECT raw_command, redacted_command, normalized_argv, output_sha256
        FROM governance_tool_events WHERE tool_use_id = 'privacy-1'
      `).get() as {
        raw_command: string | null; redacted_command: string;
        normalized_argv: string; output_sha256: string;
      };
      assert.equal(event.raw_command, null,
        'raw command is not persisted by default — plaintext is opt-in only');
      assert.doesNotMatch(event.redacted_command, /needle-command-secret/u);
      assert.doesNotMatch(event.normalized_argv, /needle-command-secret/u);
      assert.match(event.output_sha256, /^[a-f0-9]{64}$/u);

      const durable = [
        tableJson(db, 'governance_tool_events', `
          event_seq, project, canonical_root, session_id, client_name, client_version,
          hook_event, tool_name, tool_use_id, delivery_fingerprint, received_at,
          started_at, ended_at, duration_ms, redacted_command, command_sha256, cwd,
          normalized_argv, outcome, exit_code, signal, interrupted, timed_out,
          output_sha256, redacted_diagnostic, mutation_class, affected_paths,
          mutation_seq, adapter_name, adapter_version, capture_status, capture_reason, created_at
        `),
        tableJson(db, 'governance_gate_runs'),
        tableJson(db, 'governance_audit'),
        tableJson(db, 'governance_client_state'),
        tableJson(db, 'hook_telemetry'),
      ].join('\n');
      for (const secret of [
        'needle-command-secret', 'needle-output-secret',
        'needle-tool-input-secret', 'needle-env-secret',
      ]) {
        assert.doesNotMatch(durable, new RegExp(secret, 'u'), `${secret} escaped a raw-only boundary`);
      }

      const memoryRepo = new MemoryRepository(db);
      assert.deepEqual(memoryRepo.exportPortable(), []);
      assert.deepEqual(memoryRepo.exportMemories(), []);
      assert.deepEqual(memoryRepo.search('needle-output-secret'), []);
      assert.deepEqual(memoryRepo.memoriesWithoutEmbeddings(), []);
      assert.deepEqual(memoryRepo.getStats(), {
        total: 0, active: 0, invalidated: 0, byKind: {},
      });

      const state = new GovernanceRepository(db).clientState(projectId(root), 'privacy-install');
      assert.ok(state);
      assert.equal(state.supports_post_tool_use, 1);
      assert.equal(state.supports_structured_output, 1);
    } finally {
      db.close();
    }
  });

  it('persists the raw command only when explicitly opted in', async () => {
    const root = tempProject(true);
    const db = openDatabase({ dbPath: ':memory:' });
    try {
      const command = 'env API_TOKEN=needle-command-secret npm test';
      await recordGovernanceEvent(
        db,
        bashEvent(root, 'optin-1', command, nodeOutput()),
        { environment: { ...process.env, [ENV.PERSIST_RAW_COMMAND]: '1' } },
      );
      const event = db.prepare(`
        SELECT raw_command FROM governance_tool_events WHERE tool_use_id = 'optin-1'
      `).get() as { raw_command: string | null };
      assert.equal(event.raw_command, command,
        'opt-in flag restores full local-only command capture');
    } finally {
      db.close();
    }
  });

  it('preserves hook business output when the recorder transaction fails', async () => {
    const root = tempProject();
    const db = openDatabase({ dbPath: ':memory:' });
    try {
      db.exec(`
        CREATE TRIGGER force_recorder_failure
        BEFORE INSERT ON governance_tool_events
        BEGIN SELECT RAISE(ABORT, 'forced recorder failure'); END
      `);
      const result = await handleFileChanged({
        session_id: 'fail-open-session', transcript_path: join(root, 'transcript.jsonl'), cwd: root,
        hook_event_name: 'FileChanged', client_name: 'claude-code',
        client_installation_id: 'fail-open-install', file_path: 'src/a.ts',
      }, client(db));
      assert.equal(result.output, null);
      assert.equal(result.remindersTriggered, 0);
      assert.equal(result.recorder?.status, 'error');
      assert.equal((db.prepare('SELECT COUNT(*) AS n FROM governance_tool_events').get() as { n: number }).n, 0);
      assert.equal((db.prepare('SELECT COUNT(*) AS n FROM governance_audit').get() as { n: number }).n, 0);
    } finally {
      db.close();
    }
  });

  it('records a supported-client adapter error without retaining its ephemeral payload', async () => {
    const root = tempProject();
    const db = openDatabase({ dbPath: ':memory:' });
    try {
      const result = await recordGovernanceEvent(db, {
        session_id: 'adapter-error-session', transcript_path: join(root, 'transcript.jsonl'), cwd: root,
        hook_event_name: 'PostToolUse', client_name: 'claude-code',
        client_installation_id: 'adapter-error-install', tool_name: 'Bash', tool_use_id: 'bad-shape',
        tool_input: { command: 'echo needle-adapter-input-secret' },
        tool_response: { mystery: 'needle-adapter-output-secret' },
      });
      assert.equal(result.status, 'recorded');
      const stored = db.prepare(`
        SELECT capture_status, raw_command, output_sha256, mutation_class
        FROM governance_tool_events WHERE tool_use_id = 'bad-shape'
      `).get() as Record<string, unknown>;
      assert.deepEqual(stored, {
        capture_status: 'adapter_error', raw_command: null,
        output_sha256: null, mutation_class: 'unknown',
      });
      const allGovernance = ['governance_tool_events', 'governance_gate_runs',
        'governance_audit', 'governance_client_state']
        .map(table => tableJson(db, table)).join('\n');
      assert.doesNotMatch(allGovernance, /needle-adapter-(?:input|output)-secret/u);
    } finally {
      db.close();
    }
  });

  it('deletes expired evidence transactionally while preserving recent and audit-linked events', async () => {
    const root = tempProject();
    const db = openDatabase({ dbPath: ':memory:' });
    const nowMs = Date.UTC(2026, 7, 26, 12);
    const oldMs = nowMs - 40 * 86_400_000;
    const shortOldMs = nowMs - 2 * 86_400_000;
    try {
      const oldLinked = await recordGovernanceEvent(db, bashEvent(root, 'old-linked', 'npm test', nodeOutput()), {
        nowMs: oldMs,
      });
      await recordGovernanceEvent(db, bashEvent(root, 'old-delete', 'npm test', nodeOutput()), { nowMs: oldMs });
      await recordGovernanceEvent(db, bashEvent(root, 'recent', 'npm test', nodeOutput()), { nowMs });
      db.prepare(`
        INSERT INTO governance_audit (
          project, session_id, client_name, occurred_at, event_type, actor_class,
          redacted_detail, linked_event_seq, payload_version, payload
        ) VALUES (?, 'privacy-session', 'claude-code', ?, 'manual_incident', 'system',
          'preserve linked evidence', ?, 1, '{}')
      `).run(projectId(root), new Date(oldMs).toISOString(), oldLinked.eventSeq);

      const repo = new GovernanceRepository(db);
      const cleaned = repo.cleanupEvidence({ nowMs });
      assert.equal(cleaned.gateRunsDeleted, 2);
      assert.equal(cleaned.toolEventsDeleted, 1);
      assert.equal(cleaned.projectsAudited, 1);
      const ids = db.prepare(`
        SELECT tool_use_id FROM governance_tool_events ORDER BY tool_use_id
      `).all() as Array<{ tool_use_id: string }>;
      assert.deepEqual(ids.map(row => row.tool_use_id), ['old-linked', 'recent']);
      assert.equal((db.prepare(`
        SELECT COUNT(*) AS n FROM governance_audit WHERE event_type = 'retention_run'
      `).get() as { n: number }).n, 1);

      const shortRoot = tempProject(false, 1);
      await recordGovernanceEvent(db, bashEvent(shortRoot, 'short-window', 'npm test', nodeOutput()), {
        nowMs: shortOldMs,
      });
      const shortened = repo.cleanupEvidence({ nowMs });
      assert.equal(shortened.gateRunsDeleted, 1);
      assert.equal(shortened.toolEventsDeleted, 1);

      const priorMax = (db.prepare(`
        SELECT MAX(mutation_seq) AS n FROM governance_tool_events
      `).get() as { n: number }).n;
      const afterRetention = await recordGovernanceEvent(
        db, bashEvent(root, 'after-retention', 'npm test', nodeOutput()), { nowMs: nowMs + 1 },
      );
      assert.ok((afterRetention.mutationSeq ?? 0) > priorMax,
        'the durable project counter never reuses a mutation sequence after cleanup');
    } finally {
      db.close();
    }
  });

  it('never age-deletes policy rules or their lifecycle audit in evidence maintenance', () => {
    const root = tempProject();
    const db = openDatabase({ dbPath: ':memory:' });
    try {
      const project = projectId(root);
      const rule = new GovernanceRuleRepository(db).create({
        ruleId: 'verify-core', content: 'Run core tests before exit', project,
        phases: ['pre_exit'], level: 'advise', gateIds: ['test'], paths: ['**'],
        confirmation: { userConfirmed: true, sessionId: 'rule-session', clientName: 'claude-code' },
      });
      db.prepare("UPDATE memories SET created_at = '2000-01-01T00:00:00.000Z' WHERE id = ?")
        .run(rule.memoryId);
      db.prepare("UPDATE governance_audit SET occurred_at = '2000-01-01T00:00:00.000Z'").run();
      new GovernanceRepository(db).cleanupEvidence({ nowMs: Date.UTC(2026, 7, 26) });
      assert.equal((db.prepare("SELECT COUNT(*) AS n FROM memories WHERE kind = 'rule'").get() as { n: number }).n, 1);
      assert.equal((db.prepare(`
        SELECT COUNT(*) AS n FROM governance_audit WHERE event_type = 'rule_created'
      `).get() as { n: number }).n, 1);
    } finally {
      db.close();
    }
  });

  it('prunes only fully retired rule families through explicit joint lifecycle cleanup', () => {
    const root = tempProject();
    const db = openDatabase({ dbPath: ':memory:' });
    const nowMs = Date.UTC(2026, 7, 26, 12);
    try {
      const project = projectId(root);
      const rules = new GovernanceRuleRepository(db);
      rules.create({
        ruleId: 'retired-rule', content: 'Old retired policy', project,
        phases: ['pre_exit'], level: 'advise', gateIds: ['test'], paths: ['**'],
        confirmation: { userConfirmed: true },
      });
      rules.retire(project, 'retired-rule', { userConfirmed: true });
      rules.create({
        ruleId: 'active-rule', content: 'Still active policy', project,
        phases: ['pre_exit'], level: 'advise', gateIds: ['test'], paths: ['**'],
        confirmation: { userConfirmed: true },
      });
      db.prepare("UPDATE memories SET created_at = '2000-01-01T00:00:00.000Z' WHERE kind = 'rule'").run();
      db.prepare("UPDATE governance_audit SET occurred_at = '2000-01-01T00:00:00.000Z'").run();

      const result = new GovernanceRepository(db).cleanupLifecycle({
        project, auditDays: 30, ruleDays: 30, nowMs, confirmed: true,
      });
      assert.equal(result.rulesDeleted, 2, 'both immutable revisions of the retired family are pruned');
      assert.equal(rules.history(project, 'retired-rule').length, 0);
      assert.equal(rules.history(project, 'active-rule').length, 1);
      assert.equal((db.prepare(`
        SELECT COUNT(*) AS n FROM governance_audit WHERE linked_rule_id = 'active-rule'
      `).get() as { n: number }).n, 1, 'active lifecycle audit remains explanatory');
      assert.equal((db.prepare(`
        SELECT COUNT(*) AS n FROM governance_audit WHERE event_type = 'lifecycle_retention_run'
      `).get() as { n: number }).n, 1);
    } finally {
      db.close();
    }
  });

  it('enforces evidence retention even when the broader maintenance sweep is rate-gated', async () => {
    const root = tempProject();
    const db = openDatabase({ dbPath: ':memory:' });
    const nowMs = Date.UTC(2026, 7, 26, 12);
    try {
      runMaintenance(db, 'maintenance-session', { nowMs, force: true });
      await recordGovernanceEvent(db, bashEvent(root, 'expired-after-gate', 'npm test', nodeOutput()), {
        nowMs: nowMs - 31 * 86_400_000,
      });
      const gated = runMaintenance(db, 'maintenance-session', { nowMs: nowMs + 1 });
      assert.equal(gated.skipped, true);
      assert.equal(gated.governanceEvidenceCleaned, 2, 'one gate run and its event were removed');
      assert.equal((db.prepare('SELECT COUNT(*) AS n FROM governance_tool_events').get() as { n: number }).n, 0);
    } finally {
      db.close();
    }
  });
});
