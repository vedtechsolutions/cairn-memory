import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { openDatabase } from '../src/db/connection.js';
import {
  GovernanceRepository, SHADOW_REPOSITORY_LIMITS, ShadowRepositoryError,
  type ShadowRuleRevisionSnapshot, type ShadowStopVerdictAuditInput,
} from '../src/governance/repository.js';
import { GovernanceRuleRepository } from '../src/governance/rule-repository.js';

const temporaryDirectories: string[] = [];
const PROJECT = 'project-a';
const SESSION = 'session-a';
const CONFIG_SHA = 'a'.repeat(64);

afterEach(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
  temporaryDirectories.length = 0;
});

function createRule(db: Database.Database, ruleId = 'verify-core'): ShadowRuleRevisionSnapshot {
  const rule = new GovernanceRuleRepository(db).create({
    ruleId, content: 'Run the required gate', project: PROJECT,
    phases: ['pre_exit'], level: 'advise', gateIds: ['test'], paths: ['**'],
    confirmation: { userConfirmed: true },
  });
  return {
    memoryId: rule.memoryId, ruleId, revision: 1, level: 'advise',
    gateIds: ['test'], paths: ['**'], watermark: null,
  };
}

function recordEvent(
  repository: GovernanceRepository, id: string, options: { gate?: boolean; session?: string } = {},
): { eventSeq: number; mutationSeq: number } {
  const result = repository.record({
    event: {
      project: PROJECT, canonicalRoot: '/tmp/project-a', sessionId: options.session ?? SESSION,
      clientName: 'claude-code', clientVersion: '1.0.0', clientInstallationId: 'install-a',
      hookEvent: 'PostToolUse', toolName: 'Bash', toolUseId: id,
      deliveryFingerprint: null, receivedAt: '2026-08-26T12:00:00.000Z',
      startedAt: null, endedAt: null, durationMs: 1, rawCommand: null,
      redactedCommand: null, commandSha256: null, cwd: null, normalizedArgv: null,
      outcome: 'success', exitCode: 0, signal: null, interrupted: false, timedOut: false,
      outputSha256: 'b'.repeat(64), redactedDiagnostic: null,
      mutationClass: 'unknown', affectedPaths: [], adapterName: 'claude-code',
      adapterVersion: 1, captureStatus: 'complete', captureReason: null,
      observedStructuredOutput: true,
    },
    gateRuns: options.gate ? [{
      gateId: 'test', ruleId: null, ruleRevision: null, configVersion: 1,
      configSha256: CONFIG_SHA, parserName: 'node-test', parserVersion: 1,
      testTotal: 1, testPass: 1, testFail: 0, testSkip: 0,
      skipReasonsComplete: true, worktreeDigest: 'c'.repeat(64), digestVersion: 2,
      relevantPathsSha256: 'd'.repeat(64), captureResult: 'complete', incidentReason: null,
    }] : [],
    evidenceDays: 30,
  });
  return { eventSeq: result.eventSeq, mutationSeq: result.mutationSeq };
}

function verdictInput(options: {
  rule: ShadowRuleRevisionSnapshot;
  eventSeq: number;
  mutationSeq: number;
  retryCount?: 0 | 1;
}): ShadowStopVerdictAuditInput {
  return {
    project: PROJECT, sessionId: SESSION, clientName: 'claude-code',
    occurredAt: '2026-08-26T12:01:00.000Z', mode: 'shadow', effectiveMode: 'shadow',
    completionEffect: 'none', intent: 'advise', result: 'pass',
    reason: 'all_required_gates_fresh', fault: null, configVersion: 1,
    configSha256: CONFIG_SHA,
    evaluatedThrough: { eventSeq: options.eventSeq, mutationSeq: options.mutationSeq },
    rules: [{
      ruleId: options.rule.ruleId, memoryId: options.rule.memoryId,
      revision: options.rule.revision, watermarkEventSeq: 0, watermarkMutationSeq: 0,
    }],
    requiredGateIds: ['test'],
    gates: [{
      gateId: 'test', state: 'fresh_pass', reason: 'fresh_pass',
      evidenceEventSeq: options.eventSeq, captureResult: 'complete',
      parserName: 'node-test', parserVersion: 1, digestVersion: 2,
    }],
    capabilityReasons: [], stopHookActive: false, evaluatorVersion: 1,
    digestVersion: 2, elapsedMs: 25, retryCount: options.retryCount ?? 0,
  };
}

describe('shadow evaluator repository', () => {
  it('creates revision watermarks once in BEGIN IMMEDIATE and reads normalized evidence', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    try {
      const rule = createRule(db);
      const repository = new GovernanceRepository(db);
      const event = recordEvent(repository, 'event-1', { gate: true });
      const before = repository.readShadowSnapshot({
        project: PROJECT, sessionId: SESSION,
        clientInstallationId: 'install-a', configSha256: CONFIG_SHA,
      });
      assert.equal(before.rules.length, 1);
      assert.equal(before.rules[0].watermark, null);
      assert.equal(before.events.length, 1);
      assert.equal(before.gateRuns.length, 1);
      assert.equal(before.capability?.supportsPostToolUse, true);
      assert.equal(before.sequence.eventSeq, event.eventSeq);

      const first = repository.ensureShadowRuleWatermarks({
        project: PROJECT, occurredAt: '2026-08-26T12:00:30.000Z', rules: [rule],
      });
      assert.equal(first.created, 1);
      assert.equal(first.requiresRefresh, true, 'new policy can never pass on its first observed Stop');
      assert.deepEqual(first.watermarks[0], {
        auditId: first.watermarks[0].auditId, ruleId: rule.ruleId, revision: 1,
        eventSeq: event.eventSeq, mutationSeq: event.mutationSeq,
      });
      const second = repository.ensureShadowRuleWatermarks({
        project: PROJECT, occurredAt: '2026-08-26T12:00:31.000Z', rules: [rule],
      });
      assert.equal(second.created, 0);
      assert.equal(second.requiresRefresh, false);
      assert.equal(second.watermarks[0].auditId, first.watermarks[0].auditId);
      assert.equal((db.prepare(`
        SELECT COUNT(*) AS count FROM governance_audit
        WHERE event_type = 'shadow_rule_watermark'
      `).get() as { count: number }).count, 1);
      const payload = JSON.parse((db.prepare(`
        SELECT payload FROM governance_audit WHERE event_type = 'shadow_rule_watermark'
      `).get() as { payload: string }).payload) as Record<string, unknown>;
      assert.deepEqual(payload, {
        rule_id: rule.ruleId, revision: 1,
        event_seq: event.eventSeq, mutation_seq: event.mutationSeq,
      });
    } finally {
      db.close();
    }
  });

  it('holds one read snapshot when another connection records a concurrent event', () => {
    const directory = mkdtempSync(join(tmpdir(), 'cairn-shadow-snapshot-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'snapshot.db');
    const readerDb = openDatabase({ dbPath: path });
    const writerDb = openDatabase({ dbPath: path });
    try {
      createRule(readerDb);
      const reader = new GovernanceRepository(readerDb);
      const writer = new GovernanceRepository(writerDb);
      const first = recordEvent(reader, 'before-snapshot');
      let wrote = false;
      const snapshot = reader.readShadowSnapshot({
        project: PROJECT, sessionId: SESSION,
        clientInstallationId: 'install-a', configSha256: CONFIG_SHA,
        onReadStage: stage => {
          if (stage === 'rules' && !wrote) {
            wrote = true;
            recordEvent(writer, 'during-snapshot');
          }
        },
      });
      assert.equal(wrote, true);
      assert.deepEqual(snapshot.sequence, first);
      assert.deepEqual(snapshot.events.map(event => event.eventSeq), [first.eventSeq]);
      const recheck = reader.recheckShadowSequence(PROJECT, snapshot.sequence, 0);
      assert.equal(recheck.status, 'retry');
    } finally {
      writerDb.close();
      readerDb.close();
    }
  });

  it('permits one full retry and classifies a second sequence race as concurrent_mutation', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    try {
      const rule = createRule(db);
      const repository = new GovernanceRepository(db);
      const initial = recordEvent(repository, 'initial', { gate: true });
      recordEvent(repository, 'racing-event');
      assert.deepEqual(repository.recheckShadowSequence(PROJECT, initial, 0).status, 'retry');
      const second = repository.recheckShadowSequence(PROJECT, initial, 1);
      assert.equal(second.status, 'self_error');
      assert.equal(second.fault, 'concurrent_mutation');
      assert.equal(repository.persistShadowStopVerdict(verdictInput({
        rule, ...initial, retryCount: 0,
      })).status, 'retry');
      const persisted = repository.persistShadowStopVerdict(verdictInput({
        rule, ...initial, retryCount: 1,
      }));
      assert.equal(persisted.status, 'self_error');
      assert.equal(persisted.fault, 'concurrent_mutation');
      assert.equal((db.prepare(`
        SELECT COUNT(*) AS count FROM governance_audit WHERE event_type = 'shadow_stop_verdict'
      `).get() as { count: number }).count, 0);
    } finally {
      db.close();
    }
  });

  it('persists only the bounded payload and links a sole unambiguous subject', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    try {
      const rule = createRule(db);
      const repository = new GovernanceRepository(db);
      const sequence = recordEvent(repository, 'evidence', { gate: true });
      const input = verdictInput({ rule, ...sequence }) as ShadowStopVerdictAuditInput & {
        assistantText?: string;
      };
      input.assistantText = 'needle-ephemeral-assistant-secret';
      const persisted = repository.persistShadowStopVerdict(input);
      assert.equal(persisted.status, 'persisted');
      const row = db.prepare(`
        SELECT linked_rule_id, linked_rule_memory_id, linked_gate_id, linked_event_seq,
          payload_version, payload, redacted_detail
        FROM governance_audit WHERE event_type = 'shadow_stop_verdict'
      `).get() as Record<string, unknown>;
      assert.equal(row.linked_rule_id, rule.ruleId);
      assert.equal(row.linked_rule_memory_id, rule.memoryId);
      assert.equal(row.linked_gate_id, 'test');
      assert.equal(row.linked_event_seq, sequence.eventSeq);
      assert.equal(row.payload_version, 1);
      assert.doesNotMatch(JSON.stringify(row), /needle-ephemeral/u);
      assert.equal((JSON.parse(row.payload as string) as Record<string, unknown>).completion_effect, 'none');

      const secondRule = createRule(db, 'verify-extra');
      const multiRule = verdictInput({ rule, ...sequence });
      multiRule.rules = [multiRule.rules[0], {
        ruleId: secondRule.ruleId, memoryId: secondRule.memoryId, revision: 1,
        watermarkEventSeq: 0, watermarkMutationSeq: 0,
      }];
      assert.equal(repository.persistShadowStopVerdict(multiRule).status, 'persisted');
      const multiRuleLinks = db.prepare(`
        SELECT linked_rule_id, linked_rule_memory_id, linked_gate_id, linked_event_seq
        FROM governance_audit WHERE event_type = 'shadow_stop_verdict'
        ORDER BY id DESC LIMIT 1
      `).get() as Record<string, unknown>;
      assert.equal(multiRuleLinks.linked_rule_id, null);
      assert.equal(multiRuleLinks.linked_rule_memory_id, null);
      assert.equal(multiRuleLinks.linked_gate_id, 'test');
      assert.equal(multiRuleLinks.linked_event_seq, sequence.eventSeq);

      const multiGate = verdictInput({ rule, ...sequence });
      multiGate.requiredGateIds = ['test', 'lint'];
      multiGate.gates = [multiGate.gates[0], {
        gateId: 'lint', state: 'missing', reason: 'no_eligible_run',
        evidenceEventSeq: null, captureResult: null, parserName: null,
        parserVersion: null, digestVersion: null,
      }];
      assert.equal(repository.persistShadowStopVerdict(multiGate).status, 'persisted');
      const multiGateLinks = db.prepare(`
        SELECT linked_rule_id, linked_rule_memory_id, linked_gate_id, linked_event_seq
        FROM governance_audit WHERE event_type = 'shadow_stop_verdict'
        ORDER BY id DESC LIMIT 1
      `).get() as Record<string, unknown>;
      assert.equal(multiGateLinks.linked_rule_id, rule.ruleId);
      assert.equal(multiGateLinks.linked_rule_memory_id, rule.memoryId);
      assert.equal(multiGateLinks.linked_gate_id, null);
      assert.equal(multiGateLinks.linked_event_seq, null);

      const oversized = verdictInput({ rule, ...sequence });
      oversized.requiredGateIds = Array.from(
        { length: SHADOW_REPOSITORY_LIMITS.requiredGates + 1 }, (_, index) => `gate-${index}`,
      );
      const rejected = repository.persistShadowStopVerdict(oversized);
      assert.equal(rejected.status, 'self_error');
      assert.equal(rejected.fault, 'serialization_bound_exceeded');
    } finally {
      db.close();
    }
  });

  it('accepts nullable config coordinates only for config-unavailable self-errors', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    try {
      const rule = createRule(db);
      const repository = new GovernanceRepository(db);
      const sequence = recordEvent(repository, 'config-fault');
      for (const fault of [
        'config_missing', 'config_invalid', 'config_oversized', 'config_path_escape',
      ] as const) {
        const input = verdictInput({ rule, ...sequence });
        Object.assign(input, {
          result: 'self_error', reason: fault, fault,
          configVersion: null, configSha256: null,
          requiredGateIds: [], gates: [],
        });
        assert.equal(repository.persistShadowStopVerdict(input).status, 'persisted', fault);
      }

      const partiallyKnown = verdictInput({ rule, ...sequence });
      Object.assign(partiallyKnown, {
        result: 'self_error', reason: 'config_invalid', fault: 'config_invalid',
        configVersion: null, configSha256: CONFIG_SHA,
        requiredGateIds: [], gates: [],
      });
      assert.equal(repository.persistShadowStopVerdict(partiallyKnown).status, 'persisted');

      const nonConfigFault = verdictInput({ rule, ...sequence });
      Object.assign(nonConfigFault, {
        result: 'self_error', reason: 'deadline_exceeded', fault: 'deadline_exceeded',
        configVersion: null, configSha256: null,
        requiredGateIds: [], gates: [],
      });
      const rejected = repository.persistShadowStopVerdict(nonConfigFault);
      assert.equal(rejected.status, 'self_error');
      assert.equal(rejected.fault, 'serialization_bound_exceeded');
    } finally {
      db.close();
    }
  });

  it('returns audit_write_failed internally and rolls back a forced audit failure', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    try {
      const rule = createRule(db);
      const repository = new GovernanceRepository(db);
      const sequence = recordEvent(repository, 'evidence', { gate: true });
      db.exec(`
        CREATE TRIGGER force_shadow_audit_failure
        BEFORE INSERT ON governance_audit
        WHEN NEW.event_type = 'shadow_stop_verdict'
        BEGIN SELECT RAISE(ABORT, 'forced shadow audit failure'); END
      `);
      const result = repository.persistShadowStopVerdict(verdictInput({ rule, ...sequence }));
      assert.equal(result.status, 'self_error');
      assert.equal(result.fault, 'audit_write_failed');
      assert.equal((db.prepare(`
        SELECT COUNT(*) AS count FROM governance_audit WHERE event_type = 'shadow_stop_verdict'
      `).get() as { count: number }).count, 0);
    } finally {
      db.close();
    }
  });

  it('classifies malformed rows, missing schema, closed databases, and write contention', () => {
    const malformedRuleDb = openDatabase({ dbPath: ':memory:' });
    try {
      const rule = createRule(malformedRuleDb);
      malformedRuleDb.prepare('UPDATE memories SET context = ? WHERE id = ?').run('{', rule.memoryId);
      assert.throws(() => new GovernanceRepository(malformedRuleDb).readShadowSnapshot({
        project: PROJECT, sessionId: SESSION,
        clientInstallationId: 'install-a', configSha256: CONFIG_SHA,
      }), (error: unknown) => error instanceof ShadowRepositoryError && error.fault === 'rule_malformed');
    } finally {
      malformedRuleDb.close();
    }

    const malformedEvidenceDb = openDatabase({ dbPath: ':memory:' });
    try {
      const repository = new GovernanceRepository(malformedEvidenceDb);
      recordEvent(repository, 'bad-paths');
      malformedEvidenceDb.prepare(`
        UPDATE governance_tool_events SET affected_paths = '{' WHERE tool_use_id = 'bad-paths'
      `).run();
      assert.throws(() => repository.readShadowSnapshot({
        project: PROJECT, sessionId: SESSION,
        clientInstallationId: 'install-a', configSha256: CONFIG_SHA,
      }), (error: unknown) => error instanceof ShadowRepositoryError && error.fault === 'evidence_malformed');
    } finally {
      malformedEvidenceDb.close();
    }

    const malformedWatermarkDb = openDatabase({ dbPath: ':memory:' });
    try {
      const rule = createRule(malformedWatermarkDb);
      malformedWatermarkDb.prepare(`
        INSERT INTO governance_audit (
          project, occurred_at, event_type, actor_class, redacted_detail,
          linked_rule_id, linked_rule_memory_id, payload_version, payload
        ) VALUES (?, '2026-08-26T12:00:00.000Z', 'shadow_rule_watermark', 'system',
          'malformed test watermark', ?, ?, 1, '{')
      `).run(PROJECT, rule.ruleId, rule.memoryId);
      assert.throws(() => new GovernanceRepository(malformedWatermarkDb).readShadowSnapshot({
        project: PROJECT, sessionId: SESSION,
        clientInstallationId: 'install-a', configSha256: CONFIG_SHA,
      }), (error: unknown) => error instanceof ShadowRepositoryError && error.fault === 'evidence_malformed');
      malformedWatermarkDb.prepare(`
        UPDATE governance_audit SET payload = ?, payload_version = 2
        WHERE event_type = 'shadow_rule_watermark'
      `).run(JSON.stringify({ rule_id: rule.ruleId, revision: 1, event_seq: 0, mutation_seq: 0 }));
      assert.throws(() => new GovernanceRepository(malformedWatermarkDb).readShadowSnapshot({
        project: PROJECT, sessionId: SESSION,
        clientInstallationId: 'install-a', configSha256: CONFIG_SHA,
      }), (error: unknown) => error instanceof ShadowRepositoryError &&
        error.fault === 'unsupported_payload_version');
    } finally {
      malformedWatermarkDb.close();
    }

    const schemaDb = openDatabase({ dbPath: ':memory:' });
    try {
      schemaDb.exec('DROP TABLE governance_gate_runs');
      assert.throws(() => new GovernanceRepository(schemaDb).readShadowSnapshot({
        project: PROJECT, sessionId: SESSION,
        clientInstallationId: 'install-a', configSha256: CONFIG_SHA,
      }), (error: unknown) => error instanceof ShadowRepositoryError && error.fault === 'schema_unavailable');
    } finally {
      schemaDb.close();
    }

    const unexpectedDb = openDatabase({ dbPath: ':memory:' });
    try {
      assert.throws(() => new GovernanceRepository(unexpectedDb).readShadowSnapshot({
        project: PROJECT, sessionId: SESSION,
        clientInstallationId: 'install-a', configSha256: CONFIG_SHA,
        onReadStage: () => { throw new Error('injected unexpected read failure'); },
      }), (error: unknown) => error instanceof ShadowRepositoryError && error.fault === 'unexpected_error');
    } finally {
      unexpectedDb.close();
    }

    const watermarkAuditDb = openDatabase({ dbPath: ':memory:' });
    try {
      const rule = createRule(watermarkAuditDb);
      watermarkAuditDb.exec(`
        CREATE TRIGGER force_watermark_audit_failure
        BEFORE INSERT ON governance_audit
        WHEN NEW.event_type = 'shadow_rule_watermark'
        BEGIN SELECT RAISE(ABORT, 'forced watermark audit failure'); END
      `);
      assert.throws(() => new GovernanceRepository(watermarkAuditDb).ensureShadowRuleWatermarks({
        project: PROJECT, occurredAt: '2026-08-26T12:00:00.000Z', rules: [rule],
      }), (error: unknown) => error instanceof ShadowRepositoryError &&
        error.fault === 'audit_write_failed');
    } finally {
      watermarkAuditDb.close();
    }

    const closedDb = openDatabase({ dbPath: ':memory:' });
    const closedRepository = new GovernanceRepository(closedDb);
    closedDb.close();
    assert.throws(() => closedRepository.readShadowSnapshot({
      project: PROJECT, sessionId: SESSION,
      clientInstallationId: 'install-a', configSha256: CONFIG_SHA,
    }), (error: unknown) => error instanceof ShadowRepositoryError && error.fault === 'database_unavailable');

    const directory = mkdtempSync(join(tmpdir(), 'cairn-shadow-busy-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'busy.db');
    const lockingDb = openDatabase({ dbPath: path });
    const contendingDb = openDatabase({ dbPath: path });
    try {
      const rule = createRule(lockingDb);
      contendingDb.pragma('busy_timeout = 0');
      lockingDb.exec('BEGIN IMMEDIATE');
      assert.throws(() => new GovernanceRepository(contendingDb).ensureShadowRuleWatermarks({
        project: PROJECT, occurredAt: '2026-08-26T12:00:00.000Z', rules: [rule],
      }), (error: unknown) => error instanceof ShadowRepositoryError && error.fault === 'database_busy');
      lockingDb.exec('ROLLBACK');
    } finally {
      contendingDb.close();
      lockingDb.close();
    }
  });
});
