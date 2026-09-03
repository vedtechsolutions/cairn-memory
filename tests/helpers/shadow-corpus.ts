import { execFileSync } from 'node:child_process';
import {
  appendFileSync, chmodSync, mkdirSync, renameSync, rmSync, symlinkSync,
  unlinkSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { loadGateConfig } from '../../src/governance/gate-config.js';
import type {
  ShadowEvaluationSnapshot, ShadowStopVerdictAuditInput,
} from '../../src/governance/repository.js';
import {
  evaluateShadowStop, type ShadowEvaluationDiagnostic,
} from '../../src/governance/shadow-evaluator.js';
import type {
  CaptureStatus, MutationClass,
} from '../../src/governance/types.js';
import {
  captureWorktreeDigestV2, type WorktreeDigestV2Result,
} from '../../src/governance/worktree-digest.js';
import { projectId } from '../../src/utils/project-id.js';
import { GENEROUS_DIGEST_BUDGET_MS } from './test-budgets.js';

export type CorpusTreeState =
  | 'clean' | 'dirty' | 'staged' | 'mixed' | 'untracked' | 'rename' | 'deletion'
  | 'mode' | 'symlink' | 'submodule-clean' | 'submodule-dirty' | 'non-git'
  | 'unborn' | 'clean-no-config';

export interface CorpusEvidence {
  parser?: 'node-test' | 'exit-only';
  captureResult?: CaptureStatus;
  counts?: { total: number; pass: number; fail: number; skip: number };
  parserVersion?: number;
  relevantPathsMismatch?: boolean;
  missing?: boolean;
  secondGateMissing?: boolean;
}

export interface CorpusScenario {
  id: string;
  tree: CorpusTreeState;
  evidence?: CorpusEvidence;
  mutation?: 'digest-only' | 'scoped' | 'unknown' | 'hash-race';
  capability?: 'complete' | 'degraded' | 'stale-heartbeat';
  clientName?: string;
  rules?: boolean;
}

export interface CorpusRun {
  diagnostic: ShadowEvaluationDiagnostic;
  persisted: ShadowStopVerdictAuditInput[];
}

function git(root: string, args: string[]): void {
  execFileSync('git', args, { cwd: root, stdio: 'ignore' });
}

function gateConfig(parser: 'node-test' | 'exit-only', secondGate: boolean): string {
  const gate = (name: string) => ({
    argv: ['npm', 'run', name], cwd: '.', parser, timeoutMs: 60_000,
    skips: { max: 0, requireReasons: true },
  });
  return JSON.stringify({
    version: 1,
    defaults: { level: 'advise', evaluationTimeoutMs: 1_000 },
    gates: secondGate ? { test: gate('test'), build: gate('build') } : { test: gate('test') },
    pathRules: [{ paths: ['**'], require: secondGate ? ['test', 'build'] : ['test'] }],
  });
}

function createSubmodule(root: string, dirty: boolean, auxiliaries: string[]): void {
  const source = `${root}-submodule-source`;
  mkdirSync(source);
  auxiliaries.push(source);
  git(source, ['init', '-q']);
  git(source, ['config', 'user.email', 'corpus@example.invalid']);
  git(source, ['config', 'user.name', 'Corpus']);
  writeFileSync(join(source, 'nested.txt'), 'nested\n');
  git(source, ['add', '.']);
  git(source, ['commit', '-qm', 'nested']);
  git(root, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', source, 'vendor/sub']);
  git(root, ['commit', '-qam', 'submodule']);
  if (dirty) appendFileSync(join(root, 'vendor/sub/nested.txt'), 'dirty\n');
}

function initializeTree(
  root: string, scenario: CorpusScenario, auxiliaries: string[],
): void {
  const noConfig = scenario.tree === 'clean-no-config';
  const nonGit = scenario.tree === 'non-git';
  const unborn = scenario.tree === 'unborn';
  if (!nonGit) {
    git(root, ['init', '-q']);
    git(root, ['config', 'user.email', 'corpus@example.invalid']);
    git(root, ['config', 'user.name', 'Corpus']);
  }
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src/a.ts'), 'export const value = 1;\n');
  if (!noConfig) {
    mkdirSync(join(root, '.cairn'), { recursive: true });
    writeFileSync(join(root, '.cairn/gates.json'), gateConfig(
      scenario.evidence?.parser ?? 'node-test', scenario.evidence?.secondGateMissing === true,
    ));
  }
  if (!nonGit && !unborn) {
    git(root, ['add', '.']);
    git(root, ['commit', '-qm', 'base']);
  }
  const file = join(root, 'src/a.ts');
  switch (scenario.tree) {
    case 'dirty': appendFileSync(file, 'export const dirty = true;\n'); break;
    case 'staged': appendFileSync(file, 'export const staged = true;\n'); git(root, ['add', file]); break;
    case 'mixed':
      appendFileSync(file, 'export const staged = true;\n');
      git(root, ['add', file]);
      appendFileSync(file, 'export const unstaged = true;\n');
      break;
    case 'untracked': writeFileSync(join(root, 'src/new.ts'), 'new file\n'); break;
    case 'rename': renameSync(file, join(root, 'src/renamed.ts')); break;
    case 'deletion': unlinkSync(file); break;
    case 'mode': chmodSync(file, 0o755); break;
    case 'symlink': symlinkSync('a.ts', join(root, 'src/link.ts')); break;
    case 'submodule-clean': createSubmodule(root, false, auxiliaries); break;
    case 'submodule-dirty': createSubmodule(root, true, auxiliaries); break;
    default: break;
  }
}

function capability(
  project: string, mode: CorpusScenario['capability'],
): ShadowEvaluationSnapshot['capability'] {
  return {
    project, clientInstallationId: 'corpus-install', clientName: 'claude-code',
    clientVersion: '1', supportsPostToolUse: true, supportsPostToolFailure: true,
    supportsFileChanged: mode === 'degraded' ? false : true,
    supportsStructuredOutput: true, supportsStop: true, supportsBlocking: true,
    adapterVersion: 1, settingsSource: 'test', lastSessionId: 'corpus-session',
    lastHeartbeatAt: mode === 'stale-heartbeat'
      ? '2000-01-01T00:00:00.000Z' : new Date().toISOString(),
    lastProbeResult: 'ok',
  };
}

function gateRun(
  gateId: string,
  configSha256: string,
  digest: WorktreeDigestV2Result,
  evidence: CorpusEvidence,
): ShadowEvaluationSnapshot['gateRuns'][number] {
  const counts = evidence.counts ?? { total: 3, pass: 3, fail: 0, skip: 0 };
  const exitOnly = evidence.parser === 'exit-only';
  return {
    gateId, eventSeq: 10, mutationSeq: 0, configSha256,
    parserName: evidence.parser ?? 'node-test', parserVersion: evidence.parserVersion ?? 1,
    testTotal: exitOnly ? null : counts.total, testPass: exitOnly ? null : counts.pass,
    testFail: exitOnly ? null : counts.fail, testSkip: exitOnly ? null : counts.skip,
    skipReasonsComplete: exitOnly ? null : true,
    worktreeDigest: digest.digest, digestVersion: 2,
    relevantPathsSha256: evidence.relevantPathsMismatch
      ? 'f'.repeat(64) : digest.relevantPathsSha256,
    captureResult: evidence.captureResult ?? 'complete',
  };
}

function mutateAfterEvidence(root: string, mutation: CorpusScenario['mutation']): void {
  if (mutation === undefined || mutation === 'hash-race') return;
  appendFileSync(join(root, 'src/a.ts'), `// ${mutation}\n`);
}

/** Real git on temporary worktrees under a loaded host can exceed the 1 s
 *  production digest ceiling. The corpora test verdict logic, not timing
 *  (the fault-injection and digest tests own that), so every corpus digest
 *  runs under this generous deadline and the evaluator reads a deterministic
 *  clock that advances one millisecond per reading — monotone, never near
 *  its budget. That was the recorded full-suite flake ("digest deadline
 *  exceeded" / deadline_exceeded verdicts) on a busy box. */
export function corpusDigestDeadline(): number { return performance.now() + GENEROUS_DIGEST_BUDGET_MS; }
export function corpusClock(): () => number { let now = 0; return () => (now += 1); }

export async function runCorpusScenario(
  db: Database.Database, root: string, scenario: CorpusScenario, auxiliaries: string[],
): Promise<CorpusRun> {
  initializeTree(root, scenario, auxiliaries);
  const hasConfig = scenario.tree !== 'clean-no-config';
  const loaded = hasConfig ? loadGateConfig(root) : null;
  const baseline = hasConfig ? await captureWorktreeDigestV2({
    projectRoot: root, relevantPaths: ['**'], configSha256: loaded!.sha256, deadlineMs: corpusDigestDeadline(),
  }) : null;
  if (baseline !== null && baseline.status !== 'complete') throw new Error(baseline.reason ?? 'baseline');
  mutateAfterEvidence(root, scenario.mutation);
  const project = projectId(root);
  const evidence = scenario.evidence ?? {};
  const hasRules = scenario.rules !== false;
  const events = scenario.mutation === 'scoped' || scenario.mutation === 'unknown' ? [{
    eventSeq: 11, mutationSeq: 1,
    mutationClass: scenario.mutation as MutationClass,
    affectedPaths: scenario.mutation === 'scoped' ? ['src/a.ts'] : [],
  }] : [];
  const runs = baseline === null || evidence.missing ? [] : [
    gateRun('test', loaded!.sha256, baseline, evidence),
  ];
  const snapshot: ShadowEvaluationSnapshot = {
    project, sessionId: 'corpus-session', configSha256: loaded?.sha256 ?? '',
    sequence: { eventSeq: events.length > 0 ? 11 : 10, mutationSeq: events.length },
    rules: hasRules ? [{
      memoryId: 'corpus-memory', ruleId: 'verify-corpus', revision: 1, level: 'advise',
      gateIds: evidence.secondGateMissing ? ['test', 'build'] : ['test'], paths: [],
      watermark: {
        auditId: 1, ruleId: 'verify-corpus', revision: 1, eventSeq: 0, mutationSeq: 0,
      },
    }] : [],
    events, gateRuns: runs, capability: capability(project, scenario.capability ?? 'complete'),
  };
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
  let raceMutation = 0;
  const captureDigest = (options: Parameters<typeof captureWorktreeDigestV2>[0]) => captureWorktreeDigestV2({
    ...options,
    deadlineMs: corpusDigestDeadline(),
    ...(scenario.mutation === 'hash-race' ? {
      onSnapshot: () => {
        raceMutation += 1;
        writeFileSync(join(root, 'src/a.ts'), `export const race = ${raceMutation};\n`);
      },
    } : {}),
  });
  const diagnostic = await evaluateShadowStop(db, {
    sessionId: 'corpus-session', projectRoot: root,
    clientName: scenario.clientName ?? 'claude-code',
    clientInstallationId: 'corpus-install', stopHookActive: false,
  }, { repository, captureDigest, monotonicNow: corpusClock() });
  return { diagnostic, persisted };
}

export function cleanupCorpusAuxiliaries(paths: string[]): void {
  for (const path of paths) rmSync(path, { recursive: true, force: true });
}
