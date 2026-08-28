/**
 * Publish-artifact guard: the tarball must be self-sufficient. Every
 * other test runs inside the monorepo, where node_modules/@cairn/contract
 * is a workspace symlink — so a missing bundled dependency is invisible
 * to the whole suite while being fatal to every installed copy
 * (ERR_MODULE_NOT_FOUND from constants/index.js kills the CLI, the MCP
 * server, the daemon, and every hook).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('npm pack integrity', () => {
  it('bundles @cairn/contract and the load-bearing entry points', () => {
    const json = execFileSync('npm', ['pack', '--dry-run', '--json'], {
      cwd: REPO, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    const [report] = JSON.parse(json) as [{ files: { path: string }[] }];
    const files = new Set(report.files.map((f) => f.path));

    const required = [
      // The unpublished workspace dependency MUST travel in the tarball.
      'node_modules/@cairn/contract/package.json',
      'node_modules/@cairn/contract/dist/index.js',
      'node_modules/@cairn/contract/dist/routes.js',
      // Entry points and both post-tool fallback shims (D3 cross-version).
      'dist/src/cli/index.js',
      'dist/src/mcp/server.js',
      'dist/src/daemon/cairn-daemon.js',
      'dist/src/hooks/post-tool.js',
      'dist/src/hooks/codex-post-tool.js',
      'src/hooks/hook-relay.c',
      'src/hooks/hook-relay.sh',
    ];
    for (const path of required) {
      assert.ok(files.has(path), `tarball is missing ${path}`);
    }

    // The contract's SOURCE must not leak into the bundle twice via the
    // packages/ tree — only the node_modules copy ships.
    assert.ok(![...files].some((f) => f.startsWith('packages/')),
      'packages/ must not be packed directly (files list drift)');
  });
});
