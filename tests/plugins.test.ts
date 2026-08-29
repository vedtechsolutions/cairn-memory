/**
 * Phase 1 step 6 — thin-plugin packaging acceptance.
 *
 * The plugins ship STATIC wiring for marketplace distribution; these
 * guards pin it to the canonical generators so the two can never drift:
 * the Claude plugin's hooks.json must equal cairnHooks() rendered
 * against the plugin launcher, versions must ride package.json, and no
 * plugin file may carry a machine-absolute path.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, mkdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { cairnHooks } from '../src/cli/init.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PLUGIN_RELAY = '${CLAUDE_PLUGIN_ROOT}/bin/cairn-relay.sh';
const read = (rel: string): string => readFileSync(join(REPO_ROOT, rel), 'utf-8');
const readJson = (rel: string): Record<string, unknown> => JSON.parse(read(rel)) as Record<string, unknown>;

describe('thin-plugin packaging', () => {
  it('Claude plugin hooks.json equals the canonical generator (zero drift)', () => {
    const generated = JSON.parse(
      JSON.stringify(cairnHooks(PLUGIN_RELAY))
        // The generator's node-form hooks carry THIS install's absolute
        // paths; the plugin routes them through the same launcher.
        .replace(/"node [^"]*dist\/src\/hooks\/([a-z-]+\.js)"/g,
          `"${PLUGIN_RELAY.replace(/\$/g, '\\u0024')} --node $1"`),
    ) as Record<string, unknown>;
    const checkedIn = readJson('plugins/claude/cairn/hooks/hooks.json');
    assert.deepEqual(checkedIn.hooks, generated,
      'plugins/claude/cairn/hooks/hooks.json must be regenerated when cairnHooks() changes');
  });

  it('plugin versions ride package.json (lockstep)', () => {
    const pkg = readJson('package.json');
    assert.equal(readJson('plugins/claude/cairn/.claude-plugin/plugin.json').version, pkg.version);
    assert.equal(readJson('plugins/codex/cairn/.codex-plugin/plugin.json').version, pkg.version);
  });

  it('marketplace sources resolve to the plugin manifests', () => {
    const claude = readJson('.claude-plugin/marketplace.json') as { plugins: Array<{ source: string }> };
    const codex = readJson('.agents/plugins/marketplace.json') as { plugins: Array<{ source: string }> };
    assert.ok(read(join(claude.plugins[0].source, '.claude-plugin/plugin.json')).includes('"cairn"'));
    assert.ok(read(join(codex.plugins[0].source, '.codex-plugin/plugin.json')).includes('"cairn"'));
  });

  it('no plugin file carries a machine-absolute path', () => {
    for (const rel of [
      'plugins/claude/cairn/.claude-plugin/plugin.json',
      'plugins/claude/cairn/hooks/hooks.json',
      'plugins/claude/cairn/.mcp.json',
      'plugins/codex/cairn/.codex-plugin/plugin.json',
      '.claude-plugin/marketplace.json',
      '.agents/plugins/marketplace.json',
    ]) {
      const text = read(rel);
      assert.ok(!/"(\/[a-z]|[A-Z]:\\\\)/.test(text), `${rel} must not hardcode an install path`);
    }
  });

  it('MCP wiring uses the bare `cairn serve` bin (machine-independent)', () => {
    const claudeMcp = readJson('plugins/claude/cairn/.mcp.json') as { mcpServers: Record<string, { command: string; args: string[] }> };
    const codexPlugin = readJson('plugins/codex/cairn/.codex-plugin/plugin.json') as { mcpServers: Record<string, { command: string; args: string[] }> };
    for (const server of [claudeMcp.mcpServers.cairn, codexPlugin.mcpServers.cairn]) {
      assert.equal(server.command, 'cairn');
      assert.deepEqual(server.args, ['serve']);
    }
  });

  it('launcher resolves a simulated npm global install and probes the relay', () => {
    const sim = mkdtempSync(join(tmpdir(), 'cairn-npm-sim-'));
    try {
      mkdirSync(join(sim, 'bin'), { recursive: true });
      mkdirSync(join(sim, 'lib', 'node_modules'), { recursive: true });
      symlinkSync(REPO_ROOT, join(sim, 'lib', 'node_modules', 'cairn-memory'));
      symlinkSync('../lib/node_modules/cairn-memory/dist/src/cli/index.js', join(sim, 'bin', 'cairn'));
      chmodSync(join(REPO_ROOT, 'dist/src/cli/index.js'), 0o755); // npm sets this on real installs
      const out = execFileSync(join(REPO_ROOT, 'plugins/claude/cairn/bin/cairn-relay.sh'), ['--cairn-probe'], {
        encoding: 'utf-8', env: { ...process.env, PATH: `${join(sim, 'bin')}:${process.env.PATH}` },
      });
      assert.equal(out.trim(), 'cairn-relay', 'the launcher must reach the real relay through the bin symlink chain');
    } finally {
      rmSync(sim, { recursive: true, force: true });
    }
  });

  it('launcher without an install is a loud-stderr NO-OP, never a hook failure', () => {
    const result = spawnSync(join(REPO_ROOT, 'plugins/claude/cairn/bin/cairn-relay.sh'), ['session-start'], {
      encoding: 'utf-8', env: { ...process.env, PATH: '/usr/bin:/bin' },
    });
    assert.equal(result.status, 0, 'a missing install must not break the host agent');
    assert.match(result.stderr, /npm install -g cairn-memory/, 'the fix is named');
    assert.equal(result.stdout, '', 'no stray stdout into the hook pipeline');
  });
});
