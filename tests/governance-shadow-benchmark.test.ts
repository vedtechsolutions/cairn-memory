import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/db/connection.js';
import { GovernanceRuleRepository } from '../src/governance/rule-repository.js';
import { evaluateShadowStop } from '../src/governance/shadow-evaluator.js';
import { projectId } from '../src/utils/project-id.js';

const roots: string[] = [];
const LIVE_BENCHMARK = process.env.CAIRN_RUN_SHADOW_BENCHMARK === '1';

interface RecordedBenchmark {
  protocol: { samples_per_size: number; budget_ms: number };
  results: Array<{ tracked_files: number; p50_ms: number; p95_ms: number }>;
  max_p95_ms: number;
  accepted: boolean;
}

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.length = 0;
});

function git(root: string, args: string[]): void {
  execFileSync('git', args, { cwd: root, stdio: 'ignore' });
}

function createRepository(fileCount: number): string {
  const root = mkdtempSync(join(tmpdir(), `cairn-shadow-bench-${fileCount}-`));
  roots.push(root);
  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 'benchmark@example.invalid']);
  git(root, ['config', 'user.name', 'Benchmark']);
  mkdirSync(join(root, '.cairn'));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, '.cairn/gates.json'), JSON.stringify({
    version: 1, defaults: { level: 'advise', evaluationTimeoutMs: 250 },
    gates: {
      test: {
        argv: ['npm', 'test'], cwd: '.', parser: 'exit-only', timeoutMs: 60_000,
        skips: { max: 0, requireReasons: false },
      },
    },
    pathRules: [{ paths: ['**'], require: ['test'] }],
  }));
  for (let index = 0; index < fileCount; index += 1) {
    writeFileSync(join(root, 'src', `file-${String(index).padStart(4, '0')}.ts`),
      `export const value${index} = ${index};\n`);
  }
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'benchmark fixture']);
  return root;
}

function percentile95(samples: number[]): number {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)];
}

describe('shadow evaluator end-to-end latency', () => {
  it('records dedicated actual p95 below 250 ms across representative repositories', async () => {
    if (!LIVE_BENCHMARK) {
      const recorded = JSON.parse(readFileSync(
        join(process.cwd(), 'docs/benchmarks/w6-shadow-evaluator.json'), 'utf8',
      )) as RecordedBenchmark;
      assert.equal(recorded.protocol.samples_per_size, 20);
      assert.equal(recorded.protocol.budget_ms, 250);
      assert.deepEqual(recorded.results.map(row => row.tracked_files), [25, 250, 1_000]);
      assert.equal(recorded.max_p95_ms, Math.max(...recorded.results.map(row => row.p95_ms)));
      assert.ok(recorded.max_p95_ms < 250);
      assert.equal(recorded.accepted, true);
      return;
    }
    const db = openDatabase({ dbPath: ':memory:' });
    const report: Array<{ files: number; samples: number; p50Ms: number; p95Ms: number }> = [];
    try {
      for (const files of [25, 250, 1_000]) {
        const root = createRepository(files);
        const project = projectId(root);
        new GovernanceRuleRepository(db).create({
          ruleId: `benchmark-${files}`, content: 'Require benchmark gate evidence', project,
          phases: ['pre_exit'], level: 'advise', gateIds: ['test'], paths: [],
          confirmation: { userConfirmed: true },
        });
        db.prepare(`
          INSERT INTO governance_client_state (
            project, client_installation_id, client_name, client_version,
            supports_post_tool_use, supports_post_tool_failure, supports_file_changed,
            supports_structured_output, supports_stop, supports_blocking, adapter_version,
            settings_source, last_session_id, last_heartbeat_at, last_probe_result
          ) VALUES (?, 'bench-install', 'claude-code', '1', 1, 1, 1, 1, 1, 1, 1,
            'benchmark', 'bench-session', ?, 'ok')
        `).run(project, new Date().toISOString());
        const run = () => evaluateShadowStop(db, {
          sessionId: 'bench-session', projectRoot: root, clientName: 'claude-code',
          clientInstallationId: 'bench-install', stopHookActive: false,
        });
        for (let warmup = 0; warmup < 3; warmup += 1) await run();
        const samples: number[] = [];
        for (let sample = 0; sample < 20; sample += 1) {
          const started = performance.now();
          const diagnostic = await run();
          samples.push(performance.now() - started);
          assert.notEqual(diagnostic.verdict?.fault, 'deadline_exceeded');
        }
        const sorted = [...samples].sort((left, right) => left - right);
        report.push({
          files, samples: samples.length,
          p50Ms: Number(sorted[Math.floor(sorted.length / 2)].toFixed(2)),
          p95Ms: Number(percentile95(samples).toFixed(2)),
        });
      }
      const allP95 = Math.max(...report.map(row => row.p95Ms));
      console.log(`[shadow-benchmark] ${JSON.stringify({ report, maxP95Ms: allP95 })}`);
      assert.ok(allP95 < 250, `shadow evaluator p95 ${allP95} ms exceeds 250 ms`);
    } finally {
      db.close();
    }
  });
});
