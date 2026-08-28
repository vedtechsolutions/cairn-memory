import type Database from 'better-sqlite3';
import type { LoadedGateConfig } from '../../src/governance/gate-config.js';
import type {
  ShadowEvaluationSnapshot, ShadowStopVerdictAuditInput,
} from '../../src/governance/repository.js';
import {
  evaluateShadowStop, type ShadowEvaluationDiagnostic,
  type ShadowEvaluatorOptions, type ShadowStopEvaluatorInput,
} from '../../src/governance/shadow-evaluator.js';
import type { WorktreeDigestV2Result } from '../../src/governance/worktree-digest.js';

const CONFIG_SHA = 'a'.repeat(64);
const DIGEST = 'b'.repeat(64);
const PATHS_SHA = 'c'.repeat(64);

export function faultConfig(root: string): LoadedGateConfig {
  return {
    projectRoot: root, configPath: `${root}/.cairn/gates.json`, canonicalJson: '{}',
    sha256: CONFIG_SHA,
    config: {
      version: 1,
      defaults: {
        level: 'advise', evaluationTimeoutMs: 250, retention: { evidenceDays: 30 },
      },
      gates: {
        test: {
          argv: ['npm', 'test'], cwd: '.', parser: 'node-test', timeoutMs: 60_000,
          skips: { max: 0, requireReasons: true }, aliases: [], envNames: [],
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

export function faultDigest(overrides: Partial<WorktreeDigestV2Result> = {}): WorktreeDigestV2Result {
  return {
    status: 'complete', digest: DIGEST, version: 2, relevantPathsSha256: PATHS_SHA,
    repositoryKind: 'git', reason: null, attempts: 1, ...overrides,
  };
}

export function faultSnapshot(): ShadowEvaluationSnapshot {
  return {
    project: 'fault-project', sessionId: 'fault-session', configSha256: CONFIG_SHA,
    sequence: { eventSeq: 10, mutationSeq: 0 }, events: [],
    rules: [{
      memoryId: 'fault-memory', ruleId: 'verify-fault', revision: 1, level: 'advise',
      gateIds: ['test'], paths: [], watermark: {
        auditId: 1, ruleId: 'verify-fault', revision: 1, eventSeq: 0, mutationSeq: 0,
      },
    }],
    gateRuns: [{
      gateId: 'test', eventSeq: 10, mutationSeq: 0, configSha256: CONFIG_SHA,
      parserName: 'node-test', parserVersion: 1,
      testTotal: 3, testPass: 3, testFail: 0, testSkip: 0,
      skipReasonsComplete: true, worktreeDigest: DIGEST, digestVersion: 2,
      relevantPathsSha256: PATHS_SHA, captureResult: 'complete',
    }],
    capability: {
      project: 'fault-project', clientInstallationId: 'fault-install',
      clientName: 'claude-code', clientVersion: '1', supportsPostToolUse: true,
      supportsPostToolFailure: true, supportsFileChanged: true,
      supportsStructuredOutput: true, supportsStop: true, supportsBlocking: true,
      adapterVersion: 1, settingsSource: 'test', lastSessionId: 'fault-session',
      lastHeartbeatAt: new Date().toISOString(), lastProbeResult: 'ok',
    },
  };
}

export async function runFaultHarness(
  db: Database.Database,
  root: string,
  options: {
    snapshot?: ShadowEvaluationSnapshot;
    evaluator?: Omit<ShadowEvaluatorOptions, 'repository'>;
    input?: Partial<ShadowStopEvaluatorInput>;
  } = {},
): Promise<{ diagnostic: ShadowEvaluationDiagnostic; persisted: ShadowStopVerdictAuditInput[] }> {
  const snapshot = options.snapshot ?? faultSnapshot();
  const persisted: ShadowStopVerdictAuditInput[] = [];
  const repository = {
    readShadowSnapshot: () => snapshot,
    ensureShadowRuleWatermarks: () => ({
      watermarks: [], sequence: snapshot.sequence, created: 0, requiresRefresh: false,
    }),
    persistShadowStopVerdict: (audit: ShadowStopVerdictAuditInput) => {
      persisted.push(audit);
      return { status: 'persisted' as const, auditId: 1, sequence: audit.evaluatedThrough, fault: null };
    },
  };
  const diagnostic = await evaluateShadowStop(db, {
    sessionId: 'fault-session', projectRoot: root, clientName: 'claude-code',
    clientInstallationId: 'fault-install', stopHookActive: false, ...options.input,
  }, {
    repository, loadConfig: () => faultConfig(root),
    captureDigest: async () => faultDigest(), ...options.evaluator,
  });
  return { diagnostic, persisted };
}
