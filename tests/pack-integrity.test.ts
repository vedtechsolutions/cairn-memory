/**
 * Publish-artifact guard: the tarball must be self-sufficient. Every
 * other test runs inside the monorepo, where node_modules/waykeep-contract
 * is a workspace symlink — so a missing bundled dependency is invisible
 * to the whole suite while being fatal to every installed copy
 * (ERR_MODULE_NOT_FOUND from constants/index.js kills the CLI, the MCP
 * server, the daemon, and every hook).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('npm pack integrity', () => {
  it('bundles waykeep-contract and the load-bearing entry points', () => {
    const json = execFileSync('npm', ['pack', '--dry-run', '--json'], {
      cwd: REPO, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    const [report] = JSON.parse(json) as [{ files: { path: string }[] }];
    const files = new Set(report.files.map((f) => f.path));

    const required = [
      // The unpublished workspace dependency MUST travel in the tarball.
      'node_modules/waykeep-contract/package.json',
      'node_modules/waykeep-contract/dist/index.js',
      'node_modules/waykeep-contract/dist/routes.js',
      // Entry points and both post-tool fallback shims (D3 cross-version).
      'dist/src/cli/index.js',
      'dist/src/mcp/server.js',
      'dist/src/daemon/waykeep-daemon.js',
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

  it('the dependency pin tracks the workspace version exactly', () => {
    // A drifted pin makes npm skip the workspace link and hit the
    // registry for an unpublished name — loud at install, silent here
    // without this guard (verify-pack.mjs enforces the same at prepack).
    const root = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf-8')) as {
      dependencies: Record<string, string>; bundleDependencies?: string[];
    };
    const contract = JSON.parse(readFileSync(join(REPO, 'packages', 'contract', 'package.json'), 'utf-8')) as { version: string };
    assert.equal(root.dependencies['waykeep-contract'], contract.version);
    assert.ok(root.bundleDependencies?.includes('waykeep-contract'));
  });
});
