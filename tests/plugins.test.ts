/**
 * Phase 1 step 6 — thin-plugin packaging acceptance.
 *
 * The plugins ship STATIC wiring for marketplace distribution; these
 * guards pin it to the canonical generators so the two can never drift:
 * the Claude plugin's hooks.json must equal waykeepHooks() rendered
 * against the plugin launcher, versions must ride package.json, and no
 * plugin file may carry a machine-absolute path.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, mkdirSync, chmodSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { waykeepHooks } from '../src/cli/init.js';
import { VERSION } from '../src/constants/index.js';
import { RELAY_PROBE_SENTINEL, RELAY_PROBE_FLAG, MCP_SERVER_NAME, DATA_DIR_NAME, LEGACY_NAMESPACES } from 'waykeep-contract';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
/** Home-relative dirs the plugin launcher may cache under: current, then the retired ones. */
const LAUNCHER_CACHE_DIRS = [DATA_DIR_NAME, ...LEGACY_NAMESPACES.map(ns => `.${ns}`)];
const PLUGIN_RELAY = '${CLAUDE_PLUGIN_ROOT}/bin/waykeep-relay.sh';
const read = (rel: string): string => readFileSync(join(REPO_ROOT, rel), 'utf-8');
const readJson = (rel: string): Record<string, unknown> => JSON.parse(read(rel)) as Record<string, unknown>;

describe('thin-plugin packaging', () => {
  it('Claude plugin hooks.json equals the canonical generator (zero drift)', () => {
    const generated = JSON.parse(
      JSON.stringify(waykeepHooks(PLUGIN_RELAY))
        // The generator's node-form hooks carry THIS install's absolute
        // paths; the plugin routes them through the same launcher.
        .replace(/"node [^"]*dist\/src\/hooks\/([a-z-]+\.js)"/g,
          `"${PLUGIN_RELAY.replace(/\$/g, '\\u0024')} --node $1"`),
    ) as Record<string, unknown>;
    const checkedIn = readJson('plugins/claude/waykeep/hooks/hooks.json');
    assert.deepEqual(checkedIn.hooks, generated,
      'plugins/claude/waykeep/hooks/hooks.json must be regenerated when waykeepHooks() changes');
  });

  it('plugin versions AND the MCP serverInfo constant ride package.json (lockstep)', () => {
    const pkg = readJson('package.json');
    assert.equal(readJson('plugins/claude/waykeep/.claude-plugin/plugin.json').version, pkg.version);
    assert.equal(readJson('plugins/codex/waykeep/.codex-plugin/plugin.json').version, pkg.version);
    // The handshake advertised 5.1.0 on a 5.3.1 install — a comment was
    // the only guard (validation finding).
    assert.equal(VERSION, pkg.version, 'src/constants VERSION drifted from package.json — run scripts/sync-plugin-versions.mjs');
    // And the flag a new user actually types (launch validation: it was
    // an unknown command).
    const v = spawnSync('node', [CLI_JS, '--version'], { encoding: 'utf-8' });
    assert.equal(v.stdout.trim(), pkg.version);
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
    const absPath = /\/(opt|home|usr|Users|var|root|tmp|Volumes|Applications|nix)\/|[A-Z]:\\/;
    assert.ok(absPath.test('x node /opt/cairn/d.js'), 'sanity: the probe regex catches embedded paths');
    for (const rel of [
      'plugins/claude/waykeep/.claude-plugin/plugin.json',
      'plugins/claude/waykeep/hooks/hooks.json',
      'plugins/claude/waykeep/.mcp.json',
      'plugins/codex/waykeep/.codex-plugin/plugin.json',
      '.claude-plugin/marketplace.json',
      '.agents/plugins/marketplace.json',
    ]) {
      assert.ok(!absPath.test(read(rel)), `${rel} must not hardcode an install path`);
    }
  });

  it('MCP wiring never uses a shell: Claude via plugin-root launcher, Codex bare', () => {
    // A login shell was rejected by both reviewers' round 2: profile
    // output lands on stdout AHEAD of the MCP handshake (protocol
    // requires protocol-only stdout), and sh reads .profile — not the
    // .bashrc/.zshrc where nvm PATH init lives.
    const claudeMcp = readJson('plugins/claude/waykeep/.mcp.json') as unknown as { mcpServers: Record<string, { command: string; args: string[] }> };
    const codexPlugin = readJson('plugins/codex/waykeep/.codex-plugin/plugin.json') as unknown as { mcpServers: Record<string, { command: string; args: string[] }> };
    // Claude: the plugin-root launcher (reviewer-verified to expand,
    // load, and connect with `cairn` absent from PATH) — GUI-safe
    // without a shell. Codex: bare command (plugin-root-relative spawn
    // is unproven there; caveat documented, step-7 validation item).
    assert.equal(claudeMcp.mcpServers[MCP_SERVER_NAME].command, '${CLAUDE_PLUGIN_ROOT}/bin/waykeep-mcp.sh');
    assert.equal(codexPlugin.mcpServers[MCP_SERVER_NAME].command, MCP_SERVER_NAME);
    assert.deepEqual(codexPlugin.mcpServers[MCP_SERVER_NAME].args, ['serve']);
  });

  it('MCP launcher resolves off-PATH, picks the NEWEST nvm version, carries node', () => {
    // Three reviewer-executed failure shapes in one: stdout must stay
    // protocol-pure; glob order is LEXICOGRAPHIC so v9 beat v22 (the
    // OLDEST won); and the npm bin is '#!/usr/bin/env node' so a
    // node-less GUI PATH died exit 127 after finding cairn — the bin's
    // own dir must ride PATH into the exec.
    const sim = mkdtempSync(join(tmpdir(), 'cairn-mcp-sim-'));
    try {
      for (const version of ['v9.11.2', 'v22.12.0']) {
        const bin = join(sim, '.nvm', 'versions', 'node', version, 'bin');
        mkdirSync(bin, { recursive: true });
        writeFileSync(join(bin, 'cairn'),
          `#!/usr/bin/env node\nif (process.argv[2] === 'serve') process.stdout.write('serving ${version}');\n`);
        chmodSync(join(bin, 'cairn'), 0o755);
        symlinkSync(process.execPath, join(bin, 'node'));
      }
      // A NEWER node WITHOUT cairn: selecting the newest directory and
      // only then checking hid the valid v22 install (both reviewers) —
      // the scan must take the newest version that actually HAS cairn.
      mkdirSync(join(sim, '.nvm', 'versions', 'node', 'v23.5.0', 'bin'), { recursive: true });
      symlinkSync(process.execPath, join(sim, '.nvm', 'versions', 'node', 'v23.5.0', 'bin', 'node'));
      const r = spawnSync(join(REPO_ROOT, 'plugins/claude/waykeep/bin/waykeep-mcp.sh'), [], {
        // cairn is off this PATH; the version-ordering half is fully
        // proven here, and the PATH-prepend keeps the fixture's own
        // node first even where the OS has a system node (the fully
        // node-less shape was reviewer-verified on a clean box).
        encoding: 'utf-8', env: { PATH: '/usr/bin:/bin', HOME: sim },
      });
      // status/signal/error in the message: a sandboxed reviewer run got
      // empty output with nothing to diagnose (a nested-exec policy had
      // suppressed the symlinked node) — name everything spawn knows.
      assert.equal(r.stdout, 'serving v22.12.0',
        `newest version via its own node (status=${r.status} signal=${r.signal} error=${String(r.error)} stderr=${r.stderr})`);
    } finally {
      rmSync(sim, { recursive: true, force: true });
    }
  });

  it('hook launcher refuses to cache when NO absolute home is resolvable (no HOME, no passwd home)', () => {
    // ${HOME:-/tmp} put the cache in a world-writable dir: a planted
    // /tmp/${DATA_DIR_NAME}/plugin-hook-dir got EXECUTED by the next hook
    // (review, demonstrated). No home and no plugin-data = no cache.
    //
    // HERMETICITY: with HOME merely unset the launcher resolves the passwd
    // home — a real, trusted directory — so an earlier form of this test
    // cached a dead /tmp sim path into the developer's REAL ~/.waykeep
    // (found 2026-09-02). A fake `id` first on PATH names a user that
    // does not exist, so `~user` expansion fails (dash, bash, busybox ash
    // all leave the word unexpanded — review) and the launcher takes its
    // fail-closed no-cache branch; the real-home guard below proves
    // nothing leaked. A shell that runs `id` as a built-in applet without
    // consulting PATH (busybox in standalone mode) would bypass the fake
    // and cache into the real home, so the launcher is only spawned once
    // /bin/sh demonstrably runs OUR `id` (review). (The passwd-home branch
    // itself needs a fake passwd database to exercise and is deliberately
    // NOT covered here.)
    const sim = mkdtempSync(join(tmpdir(), 'cairn-nohome-sim-'));
    const priorMode = statSync(CLI_JS).mode;
    const realCachesBefore = realHomeCacheSnapshot();
    try {
      mkdirSync(join(sim, 'bin'), { recursive: true });
      mkdirSync(join(sim, 'lib', 'node_modules'), { recursive: true });
      symlinkSync(REPO_ROOT, join(sim, 'lib', 'node_modules', 'cairn-memory'));
      symlinkSync('../lib/node_modules/cairn-memory/dist/src/cli/index.js', join(sim, 'bin', 'cairn'));
      chmodSync(CLI_JS, 0o755);
      writeFileSync(join(sim, 'bin', 'id'), '#!/bin/sh\necho "waykeep-no-such-user-$$"\n');
      chmodSync(join(sim, 'bin', 'id'), 0o755);
      // NO /tmp planting: any check-then-write against a SHARED path
      // races concurrent writers (TOCTOU), and cleanup can unlink a
      // file someone else replaced (review). The same property is
      // pinned race-free: the launcher CODE (comments stripped) must
      // reference no /tmp path at all — the fallback that would have
      // read a planted cache no longer exists to be probed.
      const launcherCode = read('plugins/claude/waykeep/bin/waykeep-relay.sh')
        .split('\n').filter(l => !l.trim().startsWith('#')).join('\n');
      assert.ok(!launcherCode.includes('/tmp'),
        'the launcher CODE must never reference /tmp (the comment documenting the removed fallback may)');
      const env: Record<string, string> = { PATH: `${join(sim, 'bin')}:/usr/bin:/bin` };
      // Refuse BEFORE any write when this /bin/sh (the launcher's shebang)
      // would not run the planted `id`: the launcher would then resolve
      // the real passwd home and the guard below could only detect the leak.
      const idProbe = spawnSync('/bin/sh', ['-c', 'id -un'], { encoding: 'utf-8', env });
      assert.match(idProbe.stdout, /^waykeep-no-such-user-/u,
        `this /bin/sh runs \`id\` without consulting PATH (busybox standalone applets?) — the launcher would cache into the REAL home; not spawning it (got: ${idProbe.stdout.trim()})`);
      // cwd = sim so a hypothetical CWD-relative fallback would land HERE, where
      // the next assertion sees it, instead of somewhere the test cannot check.
      const r = spawnSync(LAUNCHER, [RELAY_PROBE_FLAG], { encoding: 'utf-8', env, cwd: sim });
      assert.equal(r.stdout.trim(), RELAY_PROBE_SENTINEL, `still works — just uncached (stderr=${r.stderr})`);
      for (const dir of LAUNCHER_CACHE_DIRS) {
        assert.equal(existsSync(join(sim, dir)), false, `no cache dir minted relative to cwd (${dir})`);
      }
      assert.deepEqual(realHomeCacheSnapshot(), realCachesBefore,
        'the launcher wrote a cache into the REAL home — the test is no longer hermetic');
    } finally {
      chmodSync(CLI_JS, priorMode);
      rmSync(sim, { recursive: true, force: true });
    }
  });

  it('claude plugin manifest relies on CONVENTION auto-load — no hooks/mcpServers keys', () => {
    // Claude Code 2.1.250 auto-loads hooks/hooks.json and .mcp.json; an
    // explicit `hooks` key naming the same file makes the plugin report
    // "failed to load" (duplicate hooks file; review B1, reproduced on a
    // real install). The conventional files exist; the manifest must not
    // double-declare them.
    const manifest = readJson('plugins/claude/waykeep/.claude-plugin/plugin.json');
    assert.equal(manifest.hooks, undefined, 'an explicit hooks key duplicates the auto-loaded path');
    assert.equal(manifest.mcpServers, undefined, '.mcp.json is auto-loaded too');
    assert.ok(read('plugins/claude/waykeep/hooks/hooks.json').length > 0);
    assert.ok(read('plugins/claude/waykeep/.mcp.json').length > 0);
  });

  it('codex plugin manifest carries the validator-required objects', () => {
    const manifest = readJson('plugins/codex/waykeep/.codex-plugin/plugin.json') as unknown as {
      author?: { name?: string }; interface?: { displayName?: string; defaultPrompt?: string };
    };
    // The bundled ingestion validator requires `author` and `interface`
    // as OBJECTS, and an interface needs a defaultPrompt (review).
    assert.equal(typeof manifest.author?.name, 'string');
    assert.equal(typeof manifest.interface?.displayName, 'string');
    assert.equal(typeof manifest.interface?.defaultPrompt, 'string');
  });

  const LAUNCHER = join(REPO_ROOT, 'plugins/claude/waykeep/bin/waykeep-relay.sh');
  const CLI_JS = join(REPO_ROOT, 'dist/src/cli/index.js');

  /** Content (or absence) of the launcher caches in the REAL home — the
   *  passwd home (`userInfo()`, which ignores HOME the way the launcher's
   *  `~user` lookup does), not `homedir()`. No passwd entry at all means the
   *  launcher cannot resolve a home either, so there is nothing to guard.
   *  Read-only: a before/after guard that a hermetic test stayed hermetic. */
  function realHomeCacheSnapshot(): Record<string, string | null> {
    let home: string;
    try { home = userInfo().homedir; } catch { return {}; }
    const snapshot: Record<string, string | null> = {};
    for (const dir of LAUNCHER_CACHE_DIRS) {
      const path = join(home, dir, 'plugin-hook-dir');
      // A single read, not exists-then-read: the file may legitimately be
      // rewritten by a live launcher between the two calls (review).
      try { snapshot[path] = readFileSync(path, 'utf-8'); } catch { snapshot[path] = null; }
    }
    return snapshot;
  }

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
      const r = runLauncher([RELAY_PROBE_FLAG], join(sim, 'bin'), join(sim, 'data'));
      assert.equal(r.stdout.trim(), RELAY_PROBE_SENTINEL, 'the launcher must reach the real relay through the bin symlink chain');
      // Resolution is CACHED, keyed to the resolving bin ("bin|dir").
      const cached = readFileSync(join(sim, 'data', 'plugin-hook-dir'), 'utf-8').trim();
      assert.match(cached, /^\/.+\|\/.+dist\/src\/hooks$/);
      // Cache REUSE: second run still answers.
      assert.equal(runLauncher([RELAY_PROBE_FLAG], join(sim, 'bin'), join(sim, 'data')).stdout.trim(), RELAY_PROBE_SENTINEL);
      // IDENTITY invalidation: a cache recorded by a DIFFERENT bin (an
      // old package-manager tree that still exists) must not be reused
      // — existence alone ran outdated hooks forever (review).
      writeFileSync(join(sim, 'data', 'plugin-hook-dir'), `/somewhere/else/bin/cairn|${cached.split('|')[1]}\n`);
      assert.equal(runLauncher([RELAY_PROBE_FLAG], join(sim, 'bin'), join(sim, 'data')).stdout.trim(), RELAY_PROBE_SENTINEL, 're-resolves past the foreign-bin cache');
      assert.match(readFileSync(join(sim, 'data', 'plugin-hook-dir'), 'utf-8'), /^\//, 'cache rewritten');
      assert.ok(readFileSync(join(sim, 'data', 'plugin-hook-dir'), 'utf-8').startsWith(join(sim, 'bin', 'cairn')), 'rewritten under the CURRENT bin');
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
      // A real shim (volta, pnpm) execs ITS OWN node by absolute path. The
      // launcher's PATH here is `sim/bin:/usr/bin:/bin`, and on the GitHub
      // runner node lives in the toolcache — a bare `exec node` found
      // nothing there and this test was red in CI while a system node on
      // /usr/bin masked it locally.
      writeFileSync(shim, `#!/bin/sh
exec "${process.execPath}" "${CLI_JS}" "$@"
`);
      chmodSync(shim, 0o755);
      const r = runLauncher([RELAY_PROBE_FLAG], join(sim, 'bin'), join(sim, 'data'));
      assert.equal(r.stdout.trim(), RELAY_PROBE_SENTINEL, 'shim layouts must resolve through cairn locate');
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
    const result = spawnSync(join(REPO_ROOT, 'plugins/claude/waykeep/bin/waykeep-relay.sh'), ['session-start'], {
      encoding: 'utf-8', env: { ...process.env, PATH: '/usr/bin:/bin' },
    });
    assert.equal(result.status, 0, 'a missing install must not break the host agent');
    assert.match(result.stderr, /npm install -g waykeep/, 'the fix is named');
    assert.equal(result.stdout, '', 'no stray stdout into the hook pipeline');
  });
});
