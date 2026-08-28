import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { openDatabase } from '../src/db/connection.js';
import { GovernanceOverrideStore } from '../src/governance/governance-overrides.js';
import type {
  ShadowEvaluationDiagnostic, ShadowEvaluatorOptions, ShadowResolvedEvaluation,
} from '../src/governance/shadow-evaluator.js';
import { evaluateGovernanceWarnStop } from '../src/governance/warn-stop.js';
import { projectId } from '../src/utils/project-id.js';
import { runFaultHarness } from './helpers/shadow-fault-harness.js';

const CONFIG_SHA = 'a'.repeat(64);
const TREE_DIGEST = 'b'.repeat(64);
const NOW = Date.parse('2026-08-26T12:00:00.000Z');
const roots: string[] = [];

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.length = 0;
});

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'cairn-warn-stop-'));
  roots.push(value);
  return value;
}

function resolved(projectRoot: string, overrides: {
  capabilityHealthy?: boolean; stopHookActive?: boolean; intent?: 'warn' | 'block';
} = {}): ShadowResolvedEvaluation {
  const project = projectId(projectRoot);
  const intent = overrides.intent ?? 'warn';
  const capabilityHealthy = overrides.capabilityHealthy ?? true;
  return {
    identity: {
      project, projectRoot, sessionId: 'session-a', clientName: 'claude-code',
      clientInstallationId: 'install-a',
    },
    config: {
      projectRoot, configPath: join(projectRoot, '.cairn/gates.json'), canonicalJson: '{}',
      sha256: CONFIG_SHA,
      config: {
        version: 1, defaults: { level: intent, evaluationTimeoutMs: 250, retention: { evidenceDays: 30 } },
        gates: {
          'test-core': {
            argv: ['npm', 'test', '--', '--token=needle-secret'], cwd: '.', parser: 'node-test',
            timeoutMs: 30_000, skips: { max: 0, requireReasons: false }, aliases: [], envNames: [],
          },
        },
        pathRules: [{ paths: ['**'], require: ['test-core'] }],
      },
      enforcement: { intent, effective: 'diagnostic', block: { available: false, reason: null } },
    },
    snapshot: {
      project, sessionId: 'session-a', configSha256: CONFIG_SHA,
      sequence: { eventSeq: 2, mutationSeq: 1 }, events: [], gateRuns: [],
      rules: [{
        memoryId: 'memory-a', ruleId: 'verify-core', revision: 2, level: intent,
        gateIds: ['test-core'], paths: [], watermark: {
          auditId: 1, ruleId: 'verify-core', revision: 2, eventSeq: 1, mutationSeq: 0,
        },
      }],
      capability: {
        project, clientInstallationId: 'install-a', clientName: 'claude-code', clientVersion: '1',
        supportsPostToolUse: capabilityHealthy, supportsPostToolFailure: capabilityHealthy,
        supportsFileChanged: capabilityHealthy, supportsStructuredOutput: true,
        supportsStop: true, supportsBlocking: true, adapterVersion: 1,
        settingsSource: 'claude-settings:governance-gate', lastSessionId: 'session-a',
        lastHeartbeatAt: new Date(NOW).toISOString(), lastProbeResult: 'governance-gate-observation',
      },
    },
    selection: {
      applicableRules: [{
        ruleId: 'verify-core', revision: 2, gateIds: ['test-core'], paths: [], watermarkEventSeq: 1,
      }],
      requiredGateIds: ['test-core'], relevantPathsByGate: { 'test-core': ['**'] },
      watermarkByGate: { 'test-core': 1 }, changedPaths: [], unknownMutation: false,
    },
    verdict: {
      payloadVersion: 1, mode: 'warn', effectiveMode: 'warn', completionEffect: 'none',
      intent, result: 'missing', reason: 'gate_missing', capabilityReasons: [], fault: null,
      gates: [{ gateId: 'test-core', state: 'missing', reason: 'no_eligible_run', evidenceEventSeq: null }],
    },
    worktreeDigest: TREE_DIGEST,
  };
}

function fakeEvaluate(value: ShadowResolvedEvaluation) {
  return async (_db: Database.Database, _input: unknown, options: ShadowEvaluatorOptions) => {
    options.onResolved?.(value);
    return {
      status: 'not_persisted', verdict: value.verdict, persistence: null, elapsedMs: 5, retryCount: 0,
    } satisfies ShadowEvaluationDiagnostic;
  };
}

function wire(projectRoot: string, extra: Record<string, unknown> = {}) {
  return {
    session_id: 'session-a', cwd: projectRoot, stop_hook_active: false,
    client_name: 'claude-code', client_installation_id: 'install-a', ...extra,
  };
}

describe('synchronous governance warn evaluation', () => {
  it('emits one non-controlling systemMessage and audits later duplicates silently', async () => {
    const db = openDatabase({ dbPath: ':memory:' });
    const projectRoot = root();
    const value = resolved(projectRoot);
    const first = await evaluateGovernanceWarnStop(db, wire(projectRoot), {
      nowMs: () => NOW, evaluate: fakeEvaluate(value),
    });
    assert.ok(first);
    const parsed = JSON.parse(first) as Record<string, unknown>;
    assert.deepEqual(Object.keys(parsed), ['systemMessage']);
    assert.doesNotMatch(first, /"decision"|needle-secret|\bblocked\b|\bpassed\b/iu);
    assert.match(first, /verify-core/);
    const second = await evaluateGovernanceWarnStop(db, wire(projectRoot), {
      nowMs: () => NOW + 1, evaluate: fakeEvaluate(value),
    });
    assert.equal(second, null);
    const events = db.prepare(`SELECT event_type FROM governance_audit
      WHERE event_type LIKE 'warning_%' ORDER BY id`).all() as Array<{ event_type: string }>;
    assert.deepEqual(events.map(row => row.event_type), ['warning_emitted', 'warning_suppressed']);
    const state = db.prepare(`SELECT supports_structured_output, supports_stop,
      supports_blocking, settings_source FROM governance_client_state
      WHERE project = ? AND client_installation_id = 'install-a'`).get(value.identity.project) as Record<string, unknown>;
    assert.deepEqual(state, {
      supports_structured_output: 1, supports_stop: 1, supports_blocking: 1,
      settings_source: 'claude-settings:governance-gate',
    });
    db.close();
  });

  it('degrades to empty output when capability is incomplete', async () => {
    const db = openDatabase({ dbPath: ':memory:' });
    const projectRoot = root();
    const output = await evaluateGovernanceWarnStop(db, wire(projectRoot), {
      nowMs: () => NOW, evaluate: fakeEvaluate(resolved(projectRoot, { capabilityHealthy: false })),
    });
    assert.equal(output, null);
    db.close();
  });

  it('warns for a valid override and records the block-to-warn clamp', async () => {
    const db = openDatabase({ dbPath: ':memory:' });
    const projectRoot = root();
    const value = resolved(projectRoot, { intent: 'block' });
    new GovernanceOverrideStore(db).create({
      project: value.identity.project, sessionId: value.identity.sessionId,
      clientName: value.identity.clientName, configSha256: CONFIG_SHA,
      worktreeDigest: TREE_DIGEST, rules: [{ ruleId: 'verify-core', revision: 2 }],
      gateIds: ['test-core'], reason: 'User confirms temporary exception',
      confirmation: { userConfirmed: true, mechanism: 'mcp-elicitation' }, nowMs: NOW,
    });
    const output = await evaluateGovernanceWarnStop(db, wire(projectRoot), {
      nowMs: () => NOW + 1, evaluate: fakeEvaluate(value),
    });
    assert.match(output ?? '', /user-confirmed temporary override is active/);
    const payload = db.prepare(`SELECT payload FROM governance_audit
      WHERE event_type = 'warning_emitted'`).get() as { payload: string };
    assert.equal((JSON.parse(payload.payload) as Record<string, unknown>).clamped_from_block, true);
    db.close();
  });

  it('keeps assistant text out of evaluation and persistence and preserves stop-hook wording', async () => {
    const db = openDatabase({ dbPath: ':memory:' });
    const projectRoot = root();
    const value = resolved(projectRoot, { stopHookActive: true });
    const output = await evaluateGovernanceWarnStop(db, wire(projectRoot, {
      stop_hook_active: true, last_assistant_message: 'ASSISTANT_STOP_NEEDLE',
    }), { nowMs: () => NOW, evaluate: fakeEvaluate(value) });
    assert.match(output ?? '', /prior Stop hook is active/);
    const stored = JSON.stringify(db.prepare(`SELECT redacted_detail, payload FROM governance_audit`).all());
    assert.doesNotMatch(stored, /ASSISTANT_STOP_NEEDLE/);
    db.close();
  });

  it('fails open without partial output and records an incident when warning audit commit fails', async () => {
    const db = openDatabase({ dbPath: ':memory:' });
    const projectRoot = root();
    db.exec(`CREATE TRIGGER reject_warning BEFORE INSERT ON governance_audit
      WHEN NEW.event_type = 'warning_emitted' BEGIN SELECT RAISE(ABORT, 'warning write crash'); END`);
    const output = await evaluateGovernanceWarnStop(db, wire(projectRoot), {
      nowMs: () => NOW, evaluate: fakeEvaluate(resolved(projectRoot)),
    });
    assert.equal(output, null);
    assert.equal((db.prepare(`SELECT count(*) n FROM governance_audit
      WHERE event_type = 'warning_incident'`).get() as { n: number }).n, 1);
    db.close();
  });

  it('fails open on an evaluator deadline and records the daemon-side incident', async () => {
    const db = openDatabase({ dbPath: ':memory:' });
    const projectRoot = root();
    const value = resolved(projectRoot);
    value.verdict.result = 'self_error';
    value.verdict.reason = 'deadline_exceeded';
    value.verdict.fault = 'deadline_exceeded';
    value.verdict.gates = [];
    const output = await evaluateGovernanceWarnStop(db, wire(projectRoot), {
      nowMs: () => NOW, evaluate: fakeEvaluate(value),
    });
    assert.equal(output, null);
    const incident = db.prepare(`SELECT payload FROM governance_audit
      WHERE event_type = 'warning_incident'`).get() as { payload: string };
    assert.equal((JSON.parse(incident.payload) as Record<string, unknown>).reason, 'deadline_exceeded');
    db.close();
  });

  it('reuses the shadow evaluator without persisting in the synchronous path', async () => {
    const db = openDatabase({ dbPath: ':memory:' });
    const projectRoot = root();
    let captured = false;
    const { diagnostic, persisted } = await runFaultHarness(db, projectRoot, {
      evaluator: { persist: false, onResolved: () => { captured = true; } },
    });
    assert.equal(diagnostic.status, 'not_persisted');
    assert.equal(captured, true);
    assert.equal(persisted.length, 0);
    db.close();
  });

  it('persists declared warn and effective warn on the unchanged async path', async () => {
    const db = openDatabase({ dbPath: ':memory:' });
    const projectRoot = root();
    const snapshot = (await import('./helpers/shadow-fault-harness.js')).faultSnapshot();
    snapshot.rules[0].level = 'warn';
    const { diagnostic, persisted } = await runFaultHarness(db, projectRoot, { snapshot });
    assert.equal(diagnostic.verdict?.mode, 'warn');
    assert.equal(diagnostic.verdict?.effectiveMode, 'warn');
    assert.equal(persisted[0].mode, 'warn');
    assert.equal(persisted[0].completionEffect, 'none');
    db.close();
  });
});
