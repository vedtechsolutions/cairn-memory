import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { createHookDbClient, type HookDbClient } from '../src/hooks/shared/db-client.js';
import { SessionCache } from '../src/hooks/shared/session-cache.js';
import { GovernanceRuleRepository } from '../src/governance/rule-repository.js';
import { projectId } from '../src/utils/project-id.js';
import { prepareRelayDir, runRelay } from './relay-harness.js';

const LIVE_BENCHMARK = process.env.CAIRN_RUN_WARN_RELAY_BENCHMARK === '1';
const stateRoot = mkdtempSync(join(tmpdir(), 'cairn-warn-relay-benchmark-'));
const cairnDir = join(stateRoot, '.cairn');
process.env.CAIRN_DIR = cairnDir;

interface RecordedBenchmark {
  protocol: { samples_per_size: number; budget_ms: number };
  results: Array<{ tracked_files: number; visible_responses: number; p50_ms: number; p95_ms: number }>;
  max_p95_ms: number;
  accepted: boolean;
}

function git(root: string, args: string[]): void {
  execFileSync('git', args, { cwd: root, stdio: 'ignore' });
}

function createRepository(fileCount: number): string {
  const root = mkdtempSync(join(stateRoot, `repo-${fileCount}-`));
  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 'benchmark@example.invalid']);
  git(root, ['config', 'user.name', 'Benchmark']);
  mkdirSync(join(root, '.cairn'));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, '.cairn/gates.json'), JSON.stringify({
    version: 1, defaults: { level: 'warn', evaluationTimeoutMs: 250 },
    gates: { test: { argv: ['npm', 'test'], cwd: '.', parser: 'exit-only', timeoutMs: 60_000 } },
    pathRules: [{ paths: ['**'], require: ['test'] }],
  }));
  for (let index = 0; index < fileCount; index += 1) {
    writeFileSync(join(root, 'src', `file-${String(index).padStart(4, '0')}.ts`), `export const value${index} = ${index};\n`);
  }
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'benchmark fixture']);
  return root;
}

function percentile95(samples: number[]): number {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)];
}

describe('governance warn relay spawn-to-warm-daemon latency', () => {
  let client: HookDbClient;
  let cache: SessionCache;
  let server: Server;
  let relayDirectory: string;

  before(async () => {
    if (!LIVE_BENCHMARK) return;
    mkdirSync(cairnDir, { recursive: true });
    client = createHookDbClient(':memory:');
    cache = new SessionCache();
    const { startHookSocket } = await import('../src/mcp/hook-socket.js');
    const claimed = await startHookSocket(client, cache);
    assert.ok(claimed, 'sandboxed CAIRN_DIR must have no live socket owner');
    server = claimed;
    // startHookSocket awaits listen + fail-closed verify before returning, so
    // the server is already listening; guard so 'listening' isn't awaited after
    // it has fired (which would hang this before-hook).
    if (!server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.once('listening', resolve);
        server.once('error', reject);
      });
    }
    relayDirectory = prepareRelayDir('cairn-warn-relay-benchmark');
  });

  after(async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
    cache?.destroy();
    client?.close();
    rmSync(stateRoot, { recursive: true, force: true });
  });

  it('records actual p95 below the 400 ms hard round-trip ceiling', async () => {
    if (!LIVE_BENCHMARK) {
      const recorded = JSON.parse(readFileSync(
        join(process.cwd(), 'docs/benchmarks/w6-warn-relay.json'), 'utf8',
      )) as RecordedBenchmark;
      assert.equal(recorded.protocol.samples_per_size, 20);
      assert.equal(recorded.protocol.budget_ms, 400);
      assert.deepEqual(recorded.results.map(row => row.tracked_files), [25, 250, 1_000]);
      assert.equal(recorded.max_p95_ms, Math.max(...recorded.results.map(row => row.p95_ms)));
      assert.ok(recorded.max_p95_ms < 400);
      assert.equal(recorded.accepted, true);
      return;
    }
    const report: Array<{ files: number; samples: number; visibleResponses: number; p50Ms: number; p95Ms: number }> = [];
    const binary = join(relayDirectory, 'hook-relay');
    for (const files of [25, 250, 1_000]) {
      const root = createRepository(files);
      const project = projectId(root);
      new GovernanceRuleRepository(client.db).create({
        ruleId: `benchmark-${files}`, content: 'Require benchmark gate evidence', project,
        phases: ['pre_exit'], level: 'warn', gateIds: ['test'], paths: [],
        confirmation: { userConfirmed: true },
      });
      client.db.prepare(`INSERT INTO governance_client_state (
        project, client_installation_id, client_name, supports_post_tool_use,
        supports_post_tool_failure, supports_file_changed, adapter_version
      ) VALUES (?, 'warn-bench-install', 'claude-code', 1, 1, 1, 1)`).run(project);
      const run = async (sample: number) => {
        const input = JSON.stringify({
          session_id: `warn-bench-${files}-${sample}`, cwd: root, stop_hook_active: false,
          client_name: 'claude-code', client_installation_id: 'warn-bench-install',
        });
        const started = performance.now();
        const result = await runRelay(binary, 'governance-gate', input, stateRoot);
        const elapsed = performance.now() - started;
        assert.equal(result.status, 0);
        if (result.stdout) assert.deepEqual(Object.keys(JSON.parse(result.stdout) as object), ['systemMessage']);
        assert.doesNotMatch(result.stdout, /"decision"/u);
        return { elapsed, visible: Boolean(result.stdout) };
      };
      for (let warmup = 0; warmup < 3; warmup += 1) await run(-warmup - 1);
      const samples: number[] = [];
      let visibleResponses = 0;
      for (let sample = 0; sample < 20; sample += 1) {
        const measured = await run(sample);
        samples.push(measured.elapsed);
        if (measured.visible) visibleResponses += 1;
      }
      const sorted = [...samples].sort((left, right) => left - right);
      report.push({
        files, samples: samples.length, visibleResponses,
        p50Ms: Number(sorted[Math.floor(sorted.length / 2)].toFixed(2)),
        p95Ms: Number(percentile95(samples).toFixed(2)),
      });
    }
    const maxP95Ms = Math.max(...report.map(row => row.p95Ms));
    console.log(`[warn-relay-benchmark] ${JSON.stringify({ report, maxP95Ms })}`);
    assert.ok(maxP95Ms < 400, `warn relay p95 ${maxP95Ms} ms exceeds 400 ms`);
  });
});
