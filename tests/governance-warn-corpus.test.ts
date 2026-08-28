import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { openDatabase } from '../src/db/connection.js';
import { evaluationWorktreeDigest } from '../src/governance/evaluation-digest.js';
import { loadGateConfig } from '../src/governance/gate-config.js';
import { GovernanceOverrideStore } from '../src/governance/governance-overrides.js';
import type {
  ShadowEvaluationDiagnostic, ShadowEvaluatorOptions, ShadowResolvedEvaluation,
} from '../src/governance/shadow-evaluator.js';
import { evaluateGovernanceWarnStop } from '../src/governance/warn-stop.js';
import type { GateEvidenceState, ShadowFaultCode, ShadowResult, ShadowVerdictReason } from '../src/governance/verdict-types.js';
import { captureWorktreeDigestV2 } from '../src/governance/worktree-digest.js';
import { projectId } from '../src/utils/project-id.js';
import {
  cleanupCorpusAuxiliaries, runCorpusScenario, type CorpusScenario,
} from './helpers/shadow-corpus.js';

const NOW = Date.parse('2026-08-26T12:00:00.000Z');
const roots: string[] = [];
const auxiliaries: string[] = [];

type CorpusSetup = 'none' | 'valid-override' | 'expired-override' | 'invalidated-override' | 'ceiling';
interface WarnScenario {
  id: string;
  result: ShadowResult;
  reason: ShadowVerdictReason;
  state: GateEvidenceState;
  intent?: 'advise' | 'warn' | 'block';
  capability?: 'complete' | 'degraded';
  fault?: ShadowFaultCode;
  stopHookActive?: boolean;
  setup?: CorpusSetup;
  calls?: number;
  expectedVisible: number;
  expectedSuppressed?: number;
  expectedClamp?: boolean;
}

const SCENARIOS: readonly WarnScenario[] = [
  { id: 'fresh-pass', result: 'pass', reason: 'all_required_gates_fresh', state: 'fresh_pass', expectedVisible: 0 },
  { id: 'missing-evidence', result: 'missing', reason: 'gate_missing', state: 'missing', expectedVisible: 1 },
  { id: 'stale-evidence', result: 'stale', reason: 'gate_stale', state: 'stale_digest', expectedVisible: 1 },
  { id: 'recorded-non-pass', result: 'non_pass', reason: 'gate_non_pass', state: 'non_pass', expectedVisible: 1 },
  { id: 'valid-override', result: 'missing', reason: 'gate_missing', state: 'missing', setup: 'valid-override', expectedVisible: 1 },
  { id: 'evaluator-self-error', result: 'self_error', reason: 'digest_race', state: 'self_error', fault: 'digest_race', expectedVisible: 0 },
  { id: 'unsupported-client', result: 'degraded', reason: 'unsupported_client', state: 'missing', capability: 'degraded', expectedVisible: 0 },
  { id: 'stop-hook-active', result: 'missing', reason: 'gate_missing', state: 'missing', stopHookActive: true, expectedVisible: 1 },
  { id: 'advisory-intent', result: 'missing', reason: 'gate_missing', state: 'missing', intent: 'advise', expectedVisible: 0 },
  { id: 'expired-override', result: 'missing', reason: 'gate_missing', state: 'missing', setup: 'expired-override', expectedVisible: 1 },
  { id: 'invalidated-override', result: 'missing', reason: 'gate_missing', state: 'missing', setup: 'invalidated-override', expectedVisible: 1 },
  { id: 'dedup-suppressed', result: 'missing', reason: 'gate_missing', state: 'missing', calls: 2, expectedVisible: 1, expectedSuppressed: 1 },
  { id: 'session-ceiling', result: 'missing', reason: 'gate_missing', state: 'missing', setup: 'ceiling', expectedVisible: 0, expectedSuppressed: 1 },
  { id: 'block-clamped-to-warn', result: 'missing', reason: 'gate_missing', state: 'missing', intent: 'block', expectedVisible: 1, expectedClamp: true },
] as const;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  cleanupCorpusAuxiliaries(auxiliaries);
  auxiliaries.length = 0;
});

function sourceScenario(scenario: WarnScenario): CorpusScenario {
  if (scenario.id === 'fresh-pass') return { id: scenario.id, tree: 'clean' };
  if (scenario.id === 'stale-evidence') return { id: scenario.id, tree: 'clean', mutation: 'digest-only' };
  if (scenario.id === 'recorded-non-pass') {
    return { id: scenario.id, tree: 'clean', evidence: { counts: { total: 3, pass: 2, fail: 1, skip: 0 } } };
  }
  if (scenario.id === 'evaluator-self-error') return { id: scenario.id, tree: 'clean', mutation: 'hash-race' };
  if (scenario.id === 'unsupported-client') return { id: scenario.id, tree: 'clean', clientName: 'legacy-client' };
  return { id: scenario.id, tree: 'clean', evidence: { missing: true } };
}

async function evaluation(
  root: string, scenario: WarnScenario, diagnostic: ShadowEvaluationDiagnostic,
): Promise<ShadowResolvedEvaluation> {
  const intent = scenario.intent ?? 'warn';
  const healthy = scenario.capability !== 'degraded';
  const config = loadGateConfig(root);
  const digest = await captureWorktreeDigestV2({
    projectRoot: root, configSha256: config.sha256, relevantPaths: ['**'],
  });
  assert.equal(digest.status, 'complete', `${scenario.id} current digest`);
  assert.ok(diagnostic.verdict, `${scenario.id} source verdict`);
  return {
    identity: {
      project: projectId(root), projectRoot: root, sessionId: 'warn-corpus-session',
      clientName: healthy ? 'claude-code' : 'unsupported-client', clientInstallationId: 'warn-corpus-install',
    },
    config,
    snapshot: {
      project: projectId(root), sessionId: 'warn-corpus-session', configSha256: config.sha256,
      sequence: { eventSeq: 2, mutationSeq: 1 }, events: [], gateRuns: [],
      rules: [{ memoryId: 'memory-a', ruleId: 'verify-corpus', revision: 2, level: intent, gateIds: ['test'], paths: [], watermark: { auditId: 1, ruleId: 'verify-corpus', revision: 2, eventSeq: 1, mutationSeq: 0 } }],
      capability: {
        project: projectId(root), clientInstallationId: 'warn-corpus-install',
        clientName: healthy ? 'claude-code' : 'unsupported-client', clientVersion: '1',
        supportsPostToolUse: healthy, supportsPostToolFailure: healthy, supportsFileChanged: healthy,
        supportsStructuredOutput: healthy, supportsStop: true, supportsBlocking: healthy, adapterVersion: 1,
        settingsSource: healthy ? 'claude-settings:governance-gate' : null,
        lastSessionId: 'warn-corpus-session', lastHeartbeatAt: new Date(NOW).toISOString(),
        lastProbeResult: healthy ? 'governance-gate-observation' : 'unsupported',
      },
    },
    selection: {
      applicableRules: [{ ruleId: 'verify-corpus', revision: 2, gateIds: ['test'], paths: [], watermarkEventSeq: 1 }],
      requiredGateIds: ['test'], relevantPathsByGate: { test: ['**'] }, watermarkByGate: { test: 1 },
      changedPaths: [], unknownMutation: false,
    },
    verdict: {
      ...diagnostic.verdict!,
      payloadVersion: 1, mode: intent === 'advise' ? 'shadow' : 'warn',
      effectiveMode: healthy && intent !== 'advise' && !scenario.fault ? 'warn' : intent === 'advise' ? 'shadow' : 'advisory',
      completionEffect: 'none', intent,
    },
    worktreeDigest: evaluationWorktreeDigest([{ gateId: 'test', digest: digest.digest! }]),
  };
}

function fakeEvaluate(value: ShadowResolvedEvaluation) {
  return async (_db: Database.Database, _input: unknown, options: ShadowEvaluatorOptions) => {
    options.onResolved?.(value);
    return { status: 'not_persisted', verdict: value.verdict, persistence: null, elapsedMs: 1, retryCount: 0 } satisfies ShadowEvaluationDiagnostic;
  };
}

function override(db: Database.Database, value: ShadowResolvedEvaluation, scenario: WarnScenario): void {
  const invalidated = scenario.setup === 'invalidated-override';
  new GovernanceOverrideStore(db).create({
    project: value.identity.project, sessionId: value.identity.sessionId, clientName: value.identity.clientName,
    configSha256: value.config.sha256, worktreeDigest: invalidated ? 'f'.repeat(64) : value.worktreeDigest,
    rules: [{ ruleId: 'verify-corpus', revision: 2 }], gateIds: ['test'], reason: 'Confirmed corpus override',
    confirmation: { userConfirmed: true, mechanism: 'mcp-elicitation' },
    nowMs: scenario.setup === 'expired-override' ? NOW - 100 : NOW,
    durationMs: scenario.setup === 'expired-override' ? 50 : undefined,
  });
}

describe('hand-audited warn corpus on real temporary worktrees', () => {
  it('matches every audited Warn cell with zero false pass and zero unauthorized warnings', async () => {
    const passAllowlist = new Set(['fresh-pass']);
    for (const scenario of SCENARIOS) {
      const db = openDatabase({ dbPath: ':memory:' });
      try {
        const root = mkdtempSync(join(tmpdir(), `cairn-warn-corpus-${scenario.id}-`));
        roots.push(root);
        const source = await runCorpusScenario(db, root, sourceScenario(scenario), auxiliaries);
        const actualResult = source.diagnostic.verdict?.result ?? source.diagnostic.status;
        const actualReason = source.diagnostic.verdict?.reason ?? 'no_verdict';
        assert.equal(actualResult, scenario.result, `${scenario.id} source result`);
        assert.equal(actualReason, scenario.reason, `${scenario.id} source reason`);
        const value = await evaluation(root, scenario, source.diagnostic);
        if (scenario.setup?.includes('override')) override(db, value, scenario);
        if (scenario.setup === 'ceiling') {
          const insert = db.prepare(`INSERT INTO governance_audit
            (project, session_id, client_name, occurred_at, event_type, actor_class, redacted_detail, payload_version, payload)
            VALUES (?, 'warn-corpus-session', 'claude-code', ?, 'warning_emitted', 'system', 'prior warning', 1, ?)`);
          for (let index = 0; index < 5; index += 1) insert.run(value.identity.project, new Date(NOW - index).toISOString(), JSON.stringify({ fingerprint: String(index).padStart(64, '0') }));
        }
        let visible = 0;
        for (let call = 0; call < (scenario.calls ?? 1); call += 1) {
          const wireInput = {
            session_id: 'warn-corpus-session', cwd: root, stop_hook_active: scenario.stopHookActive ?? false,
            client_name: value.identity.clientName, client_installation_id: 'warn-corpus-install',
            last_assistant_message: 'WARN_CORPUS_ASSISTANT_NEEDLE',
          };
          const output = await evaluateGovernanceWarnStop(db, wireInput, {
            nowMs: () => NOW + call, evaluate: fakeEvaluate(value),
          });
          if (output !== null) {
            visible += 1;
            assert.deepEqual(Object.keys(JSON.parse(output) as object), ['systemMessage']);
            assert.doesNotMatch(output, /"decision"|WARN_CORPUS_ASSISTANT_NEEDLE|\bblocked\b|\bpassed\b/iu);
          }
        }
        assert.equal(visible, scenario.expectedVisible, `${scenario.id} visible warnings`);
        if (value.verdict.result === 'pass') assert.ok(passAllowlist.has(scenario.id), `false pass: ${scenario.id}`);
        const warnings = db.prepare(`SELECT event_type, payload FROM governance_audit WHERE event_type LIKE 'warning_%' ORDER BY id`).all() as Array<{ event_type: string; payload: string }>;
        assert.equal(warnings.filter(row => row.event_type === 'warning_emitted').length,
          (scenario.setup === 'ceiling' ? 5 : 0) + scenario.expectedVisible, `${scenario.id} emission audit`);
        assert.equal(warnings.filter(row => row.event_type === 'warning_suppressed').length,
          scenario.expectedSuppressed ?? 0, `${scenario.id} suppression audit`);
        if (scenario.expectedClamp) {
          const payload = JSON.parse(warnings.at(-1)!.payload) as Record<string, unknown>;
          assert.equal(payload.clamped_from_block, true);
        }
      } finally {
        db.close();
      }
    }
  });
});
