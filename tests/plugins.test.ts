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
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, mkdirSync, chmodSync, writeFileSync, statSync } from 'node:fs';
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

  it('marketplace sources resolve to plugin manifests whose names match', () => {
    // EVERY entry, and the name must equal the manifest's name — a text
    // search for "cairn" was vacuous (review).
    const claude = readJson('.claude-plugin/marketplace.json') as unknown as { plugins: Array<{ name: string; source: string }> };
    const codex = readJson('.agents/plugins/marketplace.json') as unknown as { plugins: Array<{ name: string; source: string }> };
    for (const entry of claude.plugins) {
      assert.equal((readJson(join(entry.source, '.claude-plugin/plugin.json')) as { name?: string }).name, entry.name);
    }
    for (const entry of codex.plugins) {
      assert.equal((readJson(join(entry.source, '.codex-plugin/plugin.json')) as { name?: string }).name, entry.name);
    }
  });

  it('no plugin file carries a machine-absolute path', () => {
    // Embedded paths too ("node /opt/…", "/Users/…"), not only values
    // that BEGIN with one (review: the anchored regex missed those).
    const absPath = /\/(opt|home|usr|Users|var|root|tmp)\/|[A-Z]:\\/;
    assert.ok(absPath.test('x node /opt/cairn/d.js'), 'sanity: the probe regex catches embedded paths');
    for (const rel of [
      'plugins/claude/cairn/.claude-plugin/plugin.json',
      'plugins/claude/cairn/hooks/hooks.json',
      'plugins/claude/cairn/.mcp.json',
      'plugins/codex/cairn/.codex-plugin/plugin.json',
      '.claude-plugin/marketplace.json',
      '.agents/plugins/marketplace.json',
    ]) {
      assert.ok(!absPath.test(read(rel)), `${rel} must not hardcode an install path`);
    }
  });

  it('MCP wiring runs `cairn serve` through a login shell (GUI-safe PATH)', () => {
    // A bare `cairn` depends on the LAUNCHING process's PATH — a
    // GUI-started agent never sourced nvm/volta init (review). The
    // login shell resolves it; the command stays machine-independent.
    const claudeMcp = readJson('plugins/claude/cairn/.mcp.json') as unknown as { mcpServers: Record<string, { command: string; args: string[] }> };
    const codexPlugin = readJson('plugins/codex/cairn/.codex-plugin/plugin.json') as unknown as { mcpServers: Record<string, { command: string; args: string[] }> };
    for (const server of [claudeMcp.mcpServers.cairn, codexPlugin.mcpServers.cairn]) {
      assert.equal(server.command, 'sh');
      assert.deepEqual(server.args, ['-lc', 'exec cairn serve']);
    }
  });

  it('claude plugin manifest relies on CONVENTION auto-load — no hooks/mcpServers keys', () => {
    // Claude Code 2.1.250 auto-loads hooks/hooks.json and .mcp.json; an
    // explicit `hooks` key naming the same file makes the plugin report
    // "failed to load" (duplicate hooks file; review B1, reproduced on a
    // real install). The conventional files exist; the manifest must not
    // double-declare them.
    const manifest = readJson('plugins/claude/cairn/.claude-plugin/plugin.json');
    assert.equal(manifest.hooks, undefined, 'an explicit hooks key duplicates the auto-loaded path');
    assert.equal(manifest.mcpServers, undefined, '.mcp.json is auto-loaded too');
    assert.ok(read('plugins/claude/cairn/hooks/hooks.json').length > 0);
    assert.ok(read('plugins/claude/cairn/.mcp.json').length > 0);
  });

  it('codex plugin manifest carries the validator-required objects', () => {
    const manifest = readJson('plugins/codex/cairn/.codex-plugin/plugin.json') as unknown as {
      author?: { name?: string }; interface?: { displayName?: string; defaultPrompt?: string };
    };
    // The bundled ingestion validator requires `author` and `interface`
    // as OBJECTS, and an interface needs a defaultPrompt (review).
    assert.equal(typeof manifest.author?.name, 'string');
    assert.equal(typeof manifest.interface?.displayName, 'string');
    assert.equal(typeof manifest.interface?.defaultPrompt, 'string');
  });

  const LAUNCHER = join(REPO_ROOT, 'plugins/claude/cairn/bin/cairn-relay.sh');
  const CLI_JS = join(REPO_ROOT, 'dist/src/cli/index.js');

  /** Run the launcher with an isolated PATH + plugin-data cache dir. */
  function runLauncher(args: string[], binDir: string, dataDir: string): { stdout: string; stderr: string; status: number | null } {
    return spawnSync(LAUNCHER, args, {
      encoding: 'utf-8',
      env: { ...process.env, PATH: `${binDir}:/usr/bin:/bin`, CLAUDE_PLUGIN_DATA: dataDir },
    });
  }

  it('launcher resolves a classic npm symlink chain and probes the relay', () => {
    const sim = mkdtempSync(join(tmpdir(), 'cairn-npm-sim-'));
    const priorMode = statSync(CLI_JS).mode;
    try {
      mkdirSync(join(sim, 'bin'), { recursive: true });
      mkdirSync(join(sim, 'lib', 'node_modules'), { recursive: true });
      symlinkSync(REPO_ROOT, join(sim, 'lib', 'node_modules', 'cairn-memory'));
      symlinkSync('../lib/node_modules/cairn-memory/dist/src/cli/index.js', join(sim, 'bin', 'cairn'));
      chmodSync(CLI_JS, 0o755); // npm sets this on real installs
      const r = runLauncher(['--cairn-probe'], join(sim, 'bin'), join(sim, 'data'));
      assert.equal(r.stdout.trim(), 'cairn-relay', 'the launcher must reach the real relay through the bin symlink chain');
      // Resolution is CACHED for subsequent hook fires.
      assert.match(readFileSync(join(sim, 'data', 'plugin-hook-dir'), 'utf-8'), /dist\/src\/hooks/);
    } finally {
      chmodSync(CLI_JS, priorMode); // don't leave the build artifact's mode mutated (review)
      rmSync(sim, { recursive: true, force: true });
    }
  });

  it('launcher resolves an EXECUTABLE SHIM (volta/pnpm style) via cairn locate', () => {
    // A shim is a plain script, not a symlink — the suffix-strip path
    // cannot resolve it, and at fb-era this silently no-opped every
    // hook on those layouts (review). The `cairn locate` fallback asks
    // the CLI itself.
    const sim = mkdtempSync(join(tmpdir(), 'cairn-shim-sim-'));
    try {
      mkdirSync(join(sim, 'bin'), { recursive: true });
      const shim = join(sim, 'bin', 'cairn');
      writeFileSync(shim, `#!/bin/sh
exec node "${CLI_JS}" "$@"
`);
      chmodSync(shim, 0o755);
      const r = runLauncher(['--cairn-probe'], join(sim, 'bin'), join(sim, 'data'));
      assert.equal(r.stdout.trim(), 'cairn-relay', 'shim layouts must resolve through cairn locate');
    } finally {
      rmSync(sim, { recursive: true, force: true });
    }
  });

  it('launcher treats a symlink CYCLE as a loud no-op, not a hang', () => {
    const sim = mkdtempSync(join(tmpdir(), 'cairn-cycle-sim-'));
    try {
      mkdirSync(join(sim, 'bin'), { recursive: true });
      symlinkSync(join(sim, 'bin', 'b'), join(sim, 'bin', 'cairn'));
      symlinkSync(join(sim, 'bin', 'cairn'), join(sim, 'bin', 'b'));
      const r = runLauncher(['session-start'], join(sim, 'bin'), join(sim, 'data'));
      assert.equal(r.status, 0);
      assert.match(r.stderr, /does not terminate|could not locate|not installed/);
    } finally {
      rmSync(sim, { recursive: true, force: true });
    }
  });

  it('launcher --node without a script (and with a missing script) is a no-op', () => {
    const sim = mkdtempSync(join(tmpdir(), 'cairn-node-sim-'));
    const priorMode = statSync(CLI_JS).mode;
    try {
      mkdirSync(join(sim, 'bin'), { recursive: true });
      mkdirSync(join(sim, 'lib', 'node_modules'), { recursive: true });
      symlinkSync(REPO_ROOT, join(sim, 'lib', 'node_modules', 'cairn-memory'));
      symlinkSync('../lib/node_modules/cairn-memory/dist/src/cli/index.js', join(sim, 'bin', 'cairn'));
      chmodSync(CLI_JS, 0o755);
      for (const args of [['--node'], ['--node', 'no-such-hook.js']]) {
        const r = runLauncher(args, join(sim, 'bin'), join(sim, 'data'));
        assert.equal(r.status, 0, `${args.join(' ')} must not fail the hook pipeline`);
        assert.notEqual(r.stderr, '', 'the reason is named on stderr');
      }
    } finally {
      chmodSync(CLI_JS, priorMode);
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
