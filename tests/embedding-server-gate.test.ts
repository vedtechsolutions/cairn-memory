/**
 * MCP server embedding-config gate (W2 slice 1 review) — the server process
 * must TERMINATE with exit code 1 on invalid or gated CAIRN_EMBEDDING_MODEL,
 * not stay alive in silent FTS-only mode (the lazy warmup path swallows
 * rejections by design, so config errors must be resolved synchronously in
 * main()). Spawns the real server binary.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SERVER_PATH = join(process.cwd(), 'dist', 'src', 'mcp', 'server.js');
const SPAWN_TIMEOUT_MS = 15_000;

function spawnServerWith(model: string): { status: number | null; stderr: string; dbCreated: boolean } {
  // Isolated DB path: the gate fires before openDatabase, but if that
  // ordering ever regresses the process must still never touch a real store.
  const dir = mkdtempSync(join(tmpdir(), 'cairn-gate-test-'));
  const dbPath = join(dir, 'gate-test.db');
  try {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CAIRN_EMBEDDING_MODEL: model,
      CAIRN_DB_PATH: dbPath,
    };
    // The child must run as a NORMAL process: inheriting NODE_TEST_CONTEXT
    // makes Node treat it as a test-runner child and suppress its stderr,
    // which this test asserts on.
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, [SERVER_PATH], {
      env,
      timeout: SPAWN_TIMEOUT_MS,
      encoding: 'utf8',
    });
    assert.equal(result.error, undefined, `spawn failed or timed out: ${result.error}`);
    return { status: result.status, stderr: result.stderr ?? '', dbCreated: existsSync(dbPath) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('MCP server — embedding config fail-closed at startup', () => {
  it('exits 1 on an unknown CAIRN_EMBEDDING_MODEL instead of running FTS-only', () => {
    const { status, stderr } = spawnServerWith('definitely-not-a-model');
    assert.equal(status, 1, 'server must terminate with exit code 1');
    assert.match(stderr, /unknown CAIRN_EMBEDDING_MODEL "definitely-not-a-model"/);
    assert.match(stderr, /minilm-l6/, 'error lists valid keys');
  });

  it('exits 1 on a registered-but-UNPINNED model (embeddinggemma-300m) before opening the database', () => {
    // The registry key is valid, so this passes config resolution — the
    // MANIFEST gate must terminate the process anyway. Continuing in
    // FTS-only mode would leave production serving an unbenchmarked,
    // unverifiable model configuration.
    const { status, stderr, dbCreated } = spawnServerWith('embeddinggemma-300m');
    assert.equal(status, 1, 'server must terminate with exit code 1');
    assert.match(stderr, /embedding model "onnx-community\/embeddinggemma-300m-ONNX" has no artifact manifest/);
    assert.doesNotMatch(stderr, /Cairn MCP server running/, 'server must not reach the transport');
    assert.equal(dbCreated, false, 'the pin gate must fire before openDatabase');
  });

});
