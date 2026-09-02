/**
 * `waykeep init` registers the MCP server through the `claude` CLI: the
 * settings.json `mcpServers` block earlier versions wrote is inert (Claude
 * Code reads MCP servers from ~/.claude.json only — verified on 2.1.258,
 * where `claude mcp list` showed nothing while settings.json declared the
 * server). The CLI here is a fake with the real one's semantics
 * (tests/helpers/fake-claude-cli.ts); every path is hermetic via ENV.
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LEGACY_NAMESPACES, NAMESPACE } from 'waykeep-contract';

import { ENV } from '../src/constants/env.js';
import { MCP_SERVER_NAME } from '../src/constants/mcp.js';
import { CLAUDE_CODE } from '../src/constants/claude-code.js';
import { waykeepMcpServerEntry } from '../src/cli/mcp-entry.js';
import { installFakeClaudeCli, type FakeClaudeCli } from './helpers/fake-claude-cli.js';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli', 'index.js');
/** The exact absolute server.js path `waykeep init` resolves for THIS install. */
const SERVER = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'mcp', 'server.js');
const OTHER = '/old/install/dist/src/mcp/server.js';
const legacy = LEGACY_NAMESPACES[0];
const desired = waykeepMcpServerEntry(SERVER);

const dirs: string[] = [];
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs.length = 0; });

interface Sandbox { dir: string; settings: string; claude: FakeClaudeCli }
function sandbox(options: { fail?: boolean; failOn?: 'add-json' | 'remove'; lie?: boolean } = {}): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), 'cairn-init-mcp-'));
  dirs.push(dir);
  return { dir, settings: join(dir, 'settings.json'), claude: installFakeClaudeCli(dir, options) };
}
function seedRegistry(sb: Sandbox, servers: Record<string, unknown>): void {
  writeFileSync(sb.claude.registry, JSON.stringify({ userID: 'u', mcpServers: servers }));
}
function init(sb: Sandbox, args: string[] = [], envOverrides: Record<string, string> = {}): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [CLI, 'init', ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      [ENV.CLAUDE_SETTINGS]: sb.settings,
      [ENV.CODEX_DIR]: join(sb.dir, 'codex-hermetic'),
      [ENV.CLAUDE_CONFIG]: sb.claude.registry,
      [ENV.CLAUDE_BIN]: sb.claude.bin,
      ...envOverrides,
    },
  }) as SpawnSyncReturns<string>;
}
const settingsOf = (sb: Sandbox): { mcpServers?: Record<string, unknown> } =>
  JSON.parse(readFileSync(sb.settings, 'utf-8')) as { mcpServers?: Record<string, unknown> };

describe('init registers the MCP server through `claude mcp`', () => {
  it('fresh registry: one add-json at user scope with the canonical entry; nothing in settings.json', () => {
    const sb = sandbox();
    const r = init(sb);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(sb.claude.calls(), [['mcp', 'add-json', '-s', 'user', MCP_SERVER_NAME, JSON.stringify(desired)]]);
    assert.deepEqual(sb.claude.servers()[MCP_SERVER_NAME], desired);
    assert.equal(settingsOf(sb).mcpServers, undefined);
    assert.match(r.stdout, new RegExp(`✓ ${MCP_SERVER_NAME} registered`, 'u'));
    assert.match(r.stdout, /waykeep init: done\./u);
  });

  it('is idempotent: a second run makes no CLI call and leaves the registry byte-identical', () => {
    const sb = sandbox();
    init(sb);
    const first = readFileSync(sb.claude.registry, 'utf-8');
    const r = init(sb);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(sb.claude.calls().length, 1, 'only the first run called the CLI');
    assert.equal(readFileSync(sb.claude.registry, 'utf-8'), first);
    assert.match(r.stdout, /already registered/u);
  });

  it('re-points an entry left by a moved install (remove, then add)', () => {
    const sb = sandbox();
    seedRegistry(sb, { [MCP_SERVER_NAME]: { type: 'stdio', command: 'node', args: [OTHER] } });
    const r = init(sb);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(sb.claude.calls().map(c => c.slice(0, 2).join(' ')), ['mcp remove', 'mcp add-json']);
    assert.deepEqual(sb.claude.servers()[MCP_SERVER_NAME], desired);
    assert.match(r.stdout, /re-pointing to this install/u);
  });

  it('a re-point whose add fails after the remove succeeded prints the restore command and fails init', () => {
    // Remove-then-add is forced by add-json refusing existing names; the
    // window between them is real, so the old entry must be recoverable (review).
    const sb = sandbox({ failOn: 'add-json' });
    const stale = { type: 'stdio', command: 'node', args: [OTHER] };
    seedRegistry(sb, { [MCP_SERVER_NAME]: stale });
    const r = init(sb);
    assert.equal(r.status, 1);
    assert.equal(sb.claude.servers()[MCP_SERVER_NAME], undefined, 'the scenario: nothing registered after the failure');
    assert.match(r.stderr, /restore it with:/u);
    assert.ok(r.stderr.includes(`claude mcp add-json -s user ${MCP_SERVER_NAME} '${JSON.stringify(stale)}'`), r.stderr);
  });

  it('removes the retired-namespace alias of THIS install, only warns on one at another path, ignores a foreign one', () => {
    const sb = sandbox();
    seedRegistry(sb, { [MCP_SERVER_NAME]: desired, [legacy]: { command: 'node', args: [SERVER] } });
    let r = init(sb);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(sb.claude.calls(), [['mcp', 'remove', legacy, '-s', 'user']]);
    assert.equal(sb.claude.servers()[legacy], undefined);

    const sb2 = sandbox();
    seedRegistry(sb2, { [MCP_SERVER_NAME]: desired, [legacy]: { command: 'node', args: [OTHER] } });
    r = init(sb2);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(sb2.claude.calls(), [], 'a look-alike at another path is never touched');
    assert.ok(r.stdout.includes(`claude mcp remove ${legacy} -s user`), 'the warning names the exact command');

    const sb3 = sandbox();
    seedRegistry(sb3, { [MCP_SERVER_NAME]: desired, [legacy]: { command: 'node', args: ['/some/notdist/src/mcp/server.js-wrapper'] } });
    r = init(sb3);
    assert.deepEqual(sb3.claude.calls(), []);
    assert.ok(!r.stdout.includes(`${legacy} left in place`), 'a foreign server merely named like the old namespace draws no warning');
  });

  it('--statusline-only removes our user-scope entry (the plugin provides the server) and never adds one', () => {
    const sb = sandbox();
    seedRegistry(sb, { [MCP_SERVER_NAME]: desired });
    let r = init(sb, ['--statusline-only']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(sb.claude.calls(), [['mcp', 'remove', MCP_SERVER_NAME, '-s', 'user']]);
    assert.equal(sb.claude.servers()[MCP_SERVER_NAME], undefined);

    const sb2 = sandbox();
    r = init(sb2, ['--statusline-only']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(sb2.claude.calls(), []);
    assert.match(r.stdout, /plugin provides the server/u);

    // A wrapper-form entry (the plugin launcher registered by hand) is
    // reported with the removal command — not called absent (review).
    const sb3 = sandbox();
    seedRegistry(sb3, { [MCP_SERVER_NAME]: { command: `/hand/copied/${NAMESPACE}-mcp.sh`, args: [] } });
    r = init(sb3, ['--statusline-only']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(sb3.claude.calls(), []);
    assert.ok(r.stdout.includes(`${MCP_SERVER_NAME} left in place`) && r.stdout.includes(`claude mcp remove ${MCP_SERVER_NAME} -s user`), r.stdout);
    assert.ok(!r.stdout.includes('no user-scope'), r.stdout);
  });

  it('--dry-run prints the exact command and calls nothing', () => {
    const sb = sandbox();
    const r = init(sb, ['--dry-run']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(sb.claude.calls(), []);
    assert.ok(r.stdout.includes(`would run \`claude mcp add-json -s user ${MCP_SERVER_NAME} '`), r.stdout);
    assert.equal(existsSync(sb.claude.registry), false);
  });

  it('a CLI that cannot be found leaves the registration PENDING: the command is printed, repeated last, and the summary says so', () => {
    const sb = sandbox();
    const r = init(sb, [], { [ENV.CLAUDE_BIN]: join(sb.dir, 'no-such-claude') });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(r.stdout.includes(`${ENV.CLAUDE_BIN}=${join(sb.dir, 'no-such-claude')} is not an executable file`), 'a wrong override is named as such, not as "off PATH"');
    const command = `claude mcp add-json -s user ${MCP_SERVER_NAME} '${JSON.stringify(desired)}'`;
    assert.equal(r.stdout.split(command).length - 1, 2, 'printed in the registry section AND repeated at the end');
    const tail = r.stdout.slice(r.stdout.lastIndexOf('ACTION REQUIRED'));
    assert.ok(tail.includes(command) && /waykeep init: done, 1 action required/u.test(tail), tail);
  });

  it('off PATH and without an override, the CLI is found in the native installer location', () => {
    // The common installer/CI shape: a non-login shell whose PATH lacks
    // ~/.local/bin. HOME is the sandbox so no real install is reachable.
    const sb = sandbox();
    const home = join(sb.dir, 'home');
    mkdirSync(join(home, '.local', 'bin'), { recursive: true });
    copyFileSync(sb.claude.bin, join(home, '.local', 'bin', CLAUDE_CODE.CLI_BIN));
    const r = init(sb, [], { [ENV.CLAUDE_BIN]: '', HOME: home, PATH: '/usr/bin:/bin' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(sb.claude.calls().length, 1, 'the fake in ~/.local/bin was invoked');
    assert.match(r.stdout, /waykeep init: done\./u);
  });

  it('a failing CLI call is reported on stderr with its output and fails init', () => {
    const sb = sandbox({ fail: true });
    const r = init(sb);
    assert.equal(r.status, 1, 'init must not report success when the server is not registered');
    assert.match(r.stderr, /✗ .*failed — simulated failure/u);
    assert.match(r.stdout, /finished with errors/u);
    assert.ok(existsSync(sb.settings), 'hooks + StatusLine were still written');
  });

  it('a CLI that reports success without writing is caught by re-reading the registry (add AND remove)', () => {
    // The real CLI exited 0 with "Added …" against a registry it could not
    // modify (validation); trusting the exit status alone would reproduce the
    // original "reports success while nothing is registered" symptom.
    const sb = sandbox({ lie: true });
    let r = init(sb);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.equal(sb.claude.calls().length, 1, 'the add was attempted');
    assert.match(r.stderr, /✗ .*reported success, but .* does not show it/u);
    assert.ok(r.stderr.includes(`claude mcp add-json -s user ${MCP_SERVER_NAME} '`), 'the by-hand command is printed');
    assert.match(r.stdout, /finished with errors/u);

    const sb2 = sandbox({ lie: true });
    seedRegistry(sb2, { [MCP_SERVER_NAME]: desired });
    r = init(sb2, ['--statusline-only']);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /✗ .*reported success, but .* does not show it/u);
    assert.ok(r.stderr.includes(`claude mcp remove ${MCP_SERVER_NAME} -s user`), r.stderr);
  });

  it('a corrupt registry is reported and fails init without any CLI call', () => {
    const sb = sandbox();
    writeFileSync(sb.claude.registry, '{not json');
    const r = init(sb);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /✗ could not read/u);
    assert.deepEqual(sb.claude.calls(), []);
  });

  it('sweeps the inert mcpServers block an earlier init wrote (any install path), keeping other servers', () => {
    const sb = sandbox();
    writeFileSync(sb.settings, JSON.stringify({
      mcpServers: { [MCP_SERVER_NAME]: { command: 'node', args: [OTHER] }, other: { command: 'x' } },
    }));
    const r = init(sb);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const s = settingsOf(sb);
    assert.equal(s.mcpServers?.[MCP_SERVER_NAME], undefined, 'inert entry swept');
    assert.deepEqual(s.mcpServers?.other, { command: 'x' }, 'foreign server kept');
    assert.match(r.stdout, /inert here/u);
  });
});
