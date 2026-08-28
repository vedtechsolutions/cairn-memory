import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/db/connection.js';
import type { LoadedGateConfig } from '../src/governance/gate-config.js';
import { GateConfigError } from '../src/governance/gate-config.js';
import type {
  ShadowEvaluationSnapshot, ShadowStopVerdictAuditInput,
} from '../src/governance/repository.js';
import {
  evaluateShadowStop, type ShadowEvaluatorStage, type ShadowStopEvaluatorInput,
} from '../src/governance/shadow-evaluator.js';
import type { WorktreeDigestV2Result } from '../src/governance/worktree-digest.js';

const roots: string[] = [];
const CONFIG_SHA = 'a'.repeat(64);
const DIGEST = 'b'.repeat(64);
const PATHS_SHA = 'c'.repeat(64);

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.length = 0;
});

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'cairn-shadow-evaluator-'));
  roots.push(value);
  return value;
}

function input(projectRoot = root()): ShadowStopEvaluatorInput {
  return {
    sessionId: 'session-a', projectRoot, clientName: 'claude-code',
    clientInstallationId: 'install-a', stopHookActive: false,
  };
}

function config(projectRoot: string): LoadedGateConfig {
  return {
    projectRoot, configPath: join(projectRoot, '.cairn', 'gates.json'),
    canonicalJson: '{}', sha256: CONFIG_SHA,
    config: {
      version: 1,
      defaults: {
        level: 'advise', evaluationTimeoutMs: 250,
        retention: { evidenceDays: 30 },
      },
      gates: {
        test: {
          argv: ['npm', 'test'], cwd: '.', parser: 'exit-only', timeoutMs: 1_000,
          skips: { max: 0, requireReasons: false }, aliases: [], envNames: [],
        },
      },
      pathRules: [{ paths: ['**'], require: ['test'] }],
    },
    enforcement: {
      intent: 'advise', effective: 'diagnostic',
      block: { available: false, reason: 'shadow' },
    },
  };
}

function snapshot(options: {
  watermark?: boolean;
  rules?: Array<{ ruleId: string; level: 'advise' | 'warn' | 'block' }>;
} = {}): ShadowEvaluationSnapshot {
  const rules = options.rules ?? [{ ruleId: 'verify-core', level: 'advise' }];
  return {
    project: 'project-a', sessionId: 'session-a', configSha256: CONFIG_SHA,
    sequence: { eventSeq: 1, mutationSeq: 0 }, events: [],
    rules: rules.map((rule, index) => ({
      memoryId: `memory-${index}`, ruleId: rule.ruleId, revision: 1,
      level: rule.level, gateIds: ['test'], paths: [],
      watermark: options.watermark === false ? null : {
        auditId: index + 1, ruleId: rule.ruleId, revision: 1, eventSeq: 0, mutationSeq: 0,
      },
    })),
    gateRuns: [{
      gateId: 'test', eventSeq: 1, mutationSeq: 0, configSha256: CONFIG_SHA,
      parserName: 'exit-only', parserVersion: 1,
      testTotal: null, testPass: null, testFail: null, testSkip: null,
      skipReasonsComplete: null, worktreeDigest: DIGEST, digestVersion: 2,
      relevantPathsSha256: PATHS_SHA, captureResult: 'complete',
    }],
    capability: {
      project: 'project-a', clientInstallationId: 'install-a', clientName: 'claude-code',
      clientVersion: '1', supportsPostToolUse: true, supportsPostToolFailure: true,
      supportsFileChanged: true, supportsStructuredOutput: true, supportsStop: true,
      supportsBlocking: true, adapterVersion: 1, settingsSource: 'test',
      lastSessionId: 'session-a', lastHeartbeatAt: '2026-08-26T12:00:00.000Z',
      lastProbeResult: 'ok',
    },
  };
}

function completeDigest(): WorktreeDigestV2Result {
  return {
    status: 'complete', digest: DIGEST, version: 2,
    relevantPathsSha256: PATHS_SHA, repositoryKind: 'git', reason: null, attempts: 1,
  };
}

function mockRepository(snapshots: ShadowEvaluationSnapshot[]) {
  const persisted: ShadowStopVerdictAuditInput[] = [];
  let reads = 0;
  return {
    persisted,
    get reads() { return reads; },
    readShadowSnapshot: () => snapshots[Math.min(reads++, snapshots.length - 1)],
    ensureShadowRuleWatermarks: () => ({
      watermarks: [], sequence: { eventSeq: 1, mutationSeq: 0 },
      created: 1, requiresRefresh: true,
    }),
    persistShadowStopVerdict: (audit: ShadowStopVerdictAuditInput) => {
      persisted.push(audit);
      return {
        status: 'persisted' as const, auditId: persisted.length,
        sequence: audit.evaluatedThrough, fault: null,
      };
    },
  };
}

describe('shadow evaluator orchestration', () => {
  it('composes the Gate 1/2 stages in order and persists elapsed time', async () => {
    const db = openDatabase({ dbPath: ':memory:' });
    try {
      const projectRoot = root();
      const repository = mockRepository([snapshot()]);
      const stages: ShadowEvaluatorStage[] = [];
      let now = 10;
      const result = await evaluateShadowStop(db, input(projectRoot), {
        repository, loadConfig: () => config(projectRoot),
        captureDigest: async () => completeDigest(),
        monotonicNow: () => now++, wallNowMs: () => 1_777_000_000_000,
        onStage: stage => stages.push(stage),
      });
      assert.equal(result.status, 'persisted');
      assert.equal(result.verdict?.result, 'pass');
      assert.deepEqual(stages, [
        'identity', 'config', 'snapshot', 'selection', 'digest', 'classification',
        'capability', 'precedence', 'persist',
      ]);
      assert.ok(repository.persisted[0].elapsedMs > 0);
      assert.equal(repository.persisted[0].stopHookActive, false);
    } finally {
      db.close();
    }
  });

  it('refreshes the snapshot exactly once when a watermark is created', async () => {
    const db = openDatabase({ dbPath: ':memory:' });
    try {
      const projectRoot = root();
      const repository = mockRepository([snapshot({ watermark: false }), snapshot()]);
      const stages: ShadowEvaluatorStage[] = [];
      const result = await evaluateShadowStop(db, input(projectRoot), {
        repository, loadConfig: () => config(projectRoot),
        captureDigest: async () => completeDigest(), onStage: stage => stages.push(stage),
      });
      assert.equal(result.status, 'persisted');
      assert.equal(repository.reads, 2);
      assert.equal(stages.filter(stage => stage === 'snapshot-refresh').length, 1);
    } finally {
      db.close();
    }
  });

  it('re-runs the full evaluation once and reports a second sequence race', async () => {
    const db = openDatabase({ dbPath: ':memory:' });
    try {
      const projectRoot = root();
      const base = mockRepository([snapshot(), snapshot()]);
      let writes = 0;
      const repository = {
        ...base,
        persistShadowStopVerdict: (audit: ShadowStopVerdictAuditInput) => {
          base.persisted.push(audit);
          writes += 1;
          return writes === 1
            ? { status: 'retry' as const, auditId: null, sequence: audit.evaluatedThrough, fault: null }
            : {
                status: 'self_error' as const, auditId: null,
                sequence: audit.evaluatedThrough, fault: 'concurrent_mutation' as const,
              };
        },
      };
      let digests = 0;
      const result = await evaluateShadowStop(db, input(projectRoot), {
        repository, loadConfig: () => config(projectRoot),
        captureDigest: async () => { digests += 1; return completeDigest(); },
      });
      assert.equal(writes, 2);
      assert.equal(digests, 2, 'retry must repeat digest and classification');
      assert.equal(result.retryCount, 1);
      assert.equal(result.status, 'not_persisted');
      assert.equal(result.verdict?.fault, 'concurrent_mutation');
    } finally {
      db.close();
    }
  });

  it('persists the verdict when the one allowed full retry is stable', async () => {
    const db = openDatabase({ dbPath: ':memory:' });
    try {
      const projectRoot = root();
      const base = mockRepository([snapshot(), snapshot()]);
      let writes = 0;
      const repository = {
        ...base,
        persistShadowStopVerdict: (audit: ShadowStopVerdictAuditInput) => {
          base.persisted.push(audit);
          writes += 1;
          return writes === 1
            ? { status: 'retry' as const, auditId: null, sequence: audit.evaluatedThrough, fault: null }
            : {
                status: 'persisted' as const, auditId: 2,
                sequence: audit.evaluatedThrough, fault: null,
              };
        },
      };
      const result = await evaluateShadowStop(db, input(projectRoot), {
        repository, loadConfig: () => config(projectRoot),
        captureDigest: async () => completeDigest(),
      });
      assert.equal(result.status, 'persisted');
      assert.equal(result.retryCount, 1);
      assert.equal(base.persisted[1].retryCount, 1);
    } finally {
      db.close();
    }
  });

  it('skips persistence only when both config and active rules are absent', async () => {
    const db = openDatabase({ dbPath: ':memory:' });
    try {
      const repository = mockRepository([snapshot({ rules: [] })]);
      const result = await evaluateShadowStop(db, input(), { repository });
      assert.equal(result.status, 'skipped');
      assert.equal(result.verdict, null);
      assert.equal(repository.persisted.length, 0);
    } finally {
      db.close();
    }
  });

  it('persists config_missing with honest nullable config coordinates when rules exist', async () => {
    const db = openDatabase({ dbPath: ':memory:' });
    try {
      const repository = mockRepository([snapshot()]);
      const result = await evaluateShadowStop(db, input(), {
        repository,
        loadConfig: () => { throw new GateConfigError('invalid-config-path', 'missing'); },
      });
      assert.equal(result.status, 'persisted');
      assert.equal(result.verdict?.fault, 'config_missing');
      assert.equal(repository.persisted[0].configVersion, null);
      assert.equal(repository.persisted[0].configSha256, null);
    } finally {
      db.close();
    }
  });

  it('records the strongest applicable rule intent without exposing assistant text', async () => {
    const db = openDatabase({ dbPath: ':memory:' });
    try {
      const projectRoot = root();
      const repository = mockRepository([snapshot({ rules: [
        { ruleId: 'warn-rule', level: 'warn' },
        { ruleId: 'block-rule', level: 'block' },
      ] })]);
      const stop = input(projectRoot) as ShadowStopEvaluatorInput & { last_assistant_message: string };
      stop.last_assistant_message = 'needle-assistant-message-must-not-persist';
      const result = await evaluateShadowStop(db, stop, {
        repository, loadConfig: () => config(projectRoot),
        captureDigest: async () => completeDigest(),
      });
      assert.equal(result.verdict?.intent, 'block');
      assert.doesNotMatch(JSON.stringify(repository.persisted), /needle-assistant-message/u);
    } finally {
      db.close();
    }
  });

  it('fails open with deadline_exceeded at every orchestration boundary', async () => {
    const stages: ShadowEvaluatorStage[] = [
      'identity', 'config', 'snapshot', 'selection', 'digest', 'classification',
      'capability', 'precedence', 'persist',
    ];
    for (const expiringStage of stages) {
      const db = openDatabase({ dbPath: ':memory:' });
      try {
        const projectRoot = root();
        const repository = mockRepository([snapshot()]);
        let now = 0;
        const result = await evaluateShadowStop(db, input(projectRoot), {
          repository, loadConfig: () => config(projectRoot),
          captureDigest: async () => completeDigest(), monotonicNow: () => now,
          onStage: stage => { if (stage === expiringStage) now = 250; },
        });
        assert.equal(result.verdict?.result, 'self_error', expiringStage);
        assert.equal(result.verdict?.fault, 'deadline_exceeded', expiringStage);
        assert.equal(result.verdict?.completionEffect, 'none', expiringStage);
      } finally {
        db.close();
      }
    }
  });

  it('checks deadline boundaries around watermark creation and its sole refresh', async () => {
    for (const expiringStage of ['watermarks', 'snapshot-refresh'] as const) {
      const db = openDatabase({ dbPath: ':memory:' });
      try {
        const projectRoot = root();
        const repository = mockRepository([snapshot({ watermark: false }), snapshot()]);
        let now = 0;
        const result = await evaluateShadowStop(db, input(projectRoot), {
          repository, loadConfig: () => config(projectRoot), monotonicNow: () => now,
          captureDigest: async () => completeDigest(),
          onStage: stage => { if (stage === expiringStage) now = 250; },
        });
        assert.equal(result.verdict?.fault, 'deadline_exceeded', expiringStage);
        assert.equal(repository.reads, 1, expiringStage);
      } finally {
        db.close();
      }
    }
  });

  it('caps an explicit evaluator budget at the one-second hard ceiling', async () => {
    const db = openDatabase({ dbPath: ':memory:' });
    try {
      let now = 0;
      const result = await evaluateShadowStop(db, input(), {
        budgetMs: 5_000, monotonicNow: () => now,
        onStage: stage => { if (stage === 'config') now = 1_000; },
      });
      assert.equal(result.verdict?.fault, 'deadline_exceeded');
    } finally {
      db.close();
    }
  });
});
