/**
 * `waykeep init`'s Claude Code MCP registration — the pure parts: where the
 * registry and settings live, how the registry is read, how the CLI is
 * found, and what `claude mcp` calls the planner derives. The CLI round-trip
 * is tests/cli-init-claude-mcp.test.ts.
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { LEGACY_NAMESPACES, NAMESPACE } from 'waykeep-contract';

import { ENV } from '../src/constants/env.js';
import { MCP_SERVER_NAME } from '../src/constants/mcp.js';
import { CLAUDE_CODE } from '../src/constants/claude-code.js';
import {
  claudeConfigPath, claudeSettingsPath, readClaudeUserMcpServers, planClaudeMcp, commandLine, commandArgv, resolveClaudeBin,
} from '../src/cli/claude-mcp.js';
import { waykeepMcpServerEntry, sameServerEntry, referencesServer, looksLikeWaykeepServer, describeServerEntry } from '../src/cli/mcp-entry.js';

const SERVER = '/install/dist/src/mcp/server.js';
const OTHER = '/elsewhere/dist/src/mcp/server.js';
const legacy = LEGACY_NAMESPACES[0];
const desired = waykeepMcpServerEntry(SERVER);
const plan = (servers: Record<string, unknown>, pluginManaged = false) =>
  planClaudeMcp(servers, desired, { serverPath: SERVER, pluginManaged });

/** Save/restore the env vars a test group mutates. */
function envGuard(names: string[]): () => void {
  const saved = new Map(names.map(n => [n, process.env[n]] as const));
  return () => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  };
}

const dirs: string[] = [];
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs.length = 0; });
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
function executable(path: string): string {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, '#!/bin/sh\nexit 0\n');
  chmodSync(path, 0o755);
  return path;
}

describe('Claude Code config locations', () => {
  const restore = envGuard([ENV.CLAUDE_CONFIG, ENV.CLAUDE_SETTINGS, CLAUDE_CODE.CONFIG_DIR_ENV]);
  afterEach(restore);

  it('the explicit overrides win', () => {
    process.env[ENV.CLAUDE_CONFIG] = '/x/registry.json';
    process.env[ENV.CLAUDE_SETTINGS] = '/x/settings.json';
    assert.equal(claudeConfigPath(), '/x/registry.json');
    assert.equal(claudeSettingsPath(), '/x/settings.json');
  });

  it("honor Claude's own CLAUDE_CONFIG_DIR for BOTH files (the CLI writes there too)", () => {
    // Verified on 2.1.258: `claude mcp add-json -s user` lands in
    // $CLAUDE_CONFIG_DIR/.claude.json, so reading ~/.claude.json would
    // plan against a file the CLI never touches; settings.json moves with it.
    delete process.env[ENV.CLAUDE_CONFIG];
    delete process.env[ENV.CLAUDE_SETTINGS];
    process.env[CLAUDE_CODE.CONFIG_DIR_ENV] = '/cfg';
    assert.equal(claudeConfigPath(), join('/cfg', CLAUDE_CODE.CONFIG_FILENAME));
    assert.equal(claudeSettingsPath(), join('/cfg', CLAUDE_CODE.SETTINGS_FILENAME));
  });

  it('default to the home dir', () => {
    delete process.env[ENV.CLAUDE_CONFIG];
    delete process.env[ENV.CLAUDE_SETTINGS];
    delete process.env[CLAUDE_CODE.CONFIG_DIR_ENV];
    assert.equal(claudeConfigPath(), join(homedir(), CLAUDE_CODE.CONFIG_FILENAME));
    assert.equal(claudeSettingsPath(), join(homedir(), CLAUDE_CODE.CONFIG_DIR, CLAUDE_CODE.SETTINGS_FILENAME));
  });
});

describe('readClaudeUserMcpServers', () => {
  const file = (content: string): string => {
    const path = join(tempDir('cairn-claude-json-'), 'c.json');
    writeFileSync(path, content);
    return path;
  };

  it('an absent file, or one without mcpServers, is an empty registry', () => {
    assert.deepEqual(readClaudeUserMcpServers('/nonexistent/c.json'), { servers: {} });
    assert.deepEqual(readClaudeUserMcpServers(file('{"userID":"x"}')), { servers: {} });
  });

  it('returns the user-scope map', () => {
    assert.deepEqual(readClaudeUserMcpServers(file('{"mcpServers":{"a":{"command":"x"}}}')), { servers: { a: { command: 'x' } } });
  });

  it('reports — never silently empties — a corrupt registry', () => {
    // Treating bad JSON as "nothing registered" would run add-json against
    // a file the CLI cannot parse either; the user must see the real problem.
    assert.ok('error' in readClaudeUserMcpServers(file('{not json')));
    assert.ok('error' in readClaudeUserMcpServers(file('null')));
    assert.ok('error' in readClaudeUserMcpServers(file('{"mcpServers":[]}')));
  });
});

describe('resolveClaudeBin', () => {
  // HOME drives homedir() on POSIX, which is how the well-known-location
  // probe is pointed at a fixture instead of the developer's real home.
  const restore = envGuard([ENV.CLAUDE_BIN, 'PATH', 'HOME']);
  afterEach(restore);

  it('an override is used verbatim, and a wrong one is reported as such (not as "off PATH")', () => {
    process.env[ENV.CLAUDE_BIN] = '/nonexistent/claude';
    const r = resolveClaudeBin();
    assert.ok('missing' in r && r.missing.includes(ENV.CLAUDE_BIN) && r.missing.includes('/nonexistent/claude'), JSON.stringify(r));
    const bin = executable(join(tempDir('cairn-claude-bin-'), 'claude'));
    process.env[ENV.CLAUDE_BIN] = bin;
    assert.deepEqual(resolveClaudeBin(), { bin });
  });

  it('finds the CLI on PATH as an absolute path', () => {
    delete process.env[ENV.CLAUDE_BIN];
    const dir = tempDir('cairn-claude-path-');
    const bin = executable(join(dir, CLAUDE_CODE.CLI_BIN));
    process.env.PATH = `${dir}:/nonexistent`;
    assert.deepEqual(resolveClaudeBin(), { bin });
  });

  it('off PATH, probes the installer locations — the native installer first, then the NEWEST nvm version', () => {
    // A non-login shell (installers, CI) never sourced ~/.local/bin or nvm
    // into PATH; init used to print the command and exit 0 (review).
    delete process.env[ENV.CLAUDE_BIN];
    const home = tempDir('cairn-claude-home-');
    process.env.HOME = home;
    process.env.PATH = '/nonexistent';
    assert.ok('missing' in resolveClaudeBin(), 'nothing installed → missing');
    const old = executable(join(home, ...CLAUDE_CODE.NVM_VERSIONS_DIR, 'v9.11.2', 'bin', CLAUDE_CODE.CLI_BIN));
    const newer = executable(join(home, ...CLAUDE_CODE.NVM_VERSIONS_DIR, 'v22.12.0', 'bin', CLAUDE_CODE.CLI_BIN));
    assert.deepEqual(resolveClaudeBin(), { bin: newer }, `lexical order would pick ${old}`);
    const native = executable(join(home, '.local', 'bin', CLAUDE_CODE.CLI_BIN));
    assert.deepEqual(resolveClaudeBin(), { bin: native }, 'the native installer location outranks nvm');
  });
});

describe('planClaudeMcp', () => {
  it('registers when absent', () => {
    assert.deepEqual(plan({}).actions.map(a => `${a.kind} ${a.name}`), [`add ${MCP_SERVER_NAME}`]);
  });

  it('is a no-op when our exact entry is registered (as the CLI writes it, or hand-written without type)', () => {
    for (const existing of [desired, { command: 'node', args: [SERVER], env: desired.env }]) {
      const p = plan({ [MCP_SERVER_NAME]: existing });
      assert.deepEqual(p.actions, []);
      assert.match(p.notes[0], /already registered/u);
    }
  });

  it('re-points an entry that launches a different path, remembering what it replaces', () => {
    const stale = { type: 'stdio', command: 'node', args: [OTHER] };
    const p = plan({ [MCP_SERVER_NAME]: stale });
    assert.deepEqual(p.actions.map(a => `${a.kind} ${a.name}`), [`remove ${MCP_SERVER_NAME}`, `add ${MCP_SERVER_NAME}`]);
    assert.match(p.actions[0].reason, new RegExp(`was: node ${OTHER}`, 'u'));
    assert.deepEqual(p.actions[1].previous, stale, 'a failed add can print how to restore the old entry');
  });

  it('re-points an entry whose env drifted from the canonical one', () => {
    const p = plan({ [MCP_SERVER_NAME]: { type: 'stdio', command: 'node', args: [SERVER], env: {} } });
    assert.deepEqual(p.actions.map(a => a.kind), ['remove', 'add']);
  });

  it('removes a legacy key that launches OUR exact server; only warns on a look-alike; ignores a foreign one', () => {
    assert.deepEqual(plan({ [MCP_SERVER_NAME]: desired, [legacy]: { command: 'node', args: [SERVER] } }).actions.map(a => `${a.kind} ${a.name}`), [`remove ${legacy}`]);
    const suspect = plan({ [MCP_SERVER_NAME]: desired, [legacy]: { command: 'node', args: [OTHER] } });
    assert.deepEqual(suspect.actions, []);
    assert.equal(suspect.warnings.length, 1);
    assert.ok(suspect.warnings[0].includes(`claude mcp remove ${legacy} -s user`), 'the warning carries the exact removal command');
    const foreign = plan({ [MCP_SERVER_NAME]: desired, [legacy]: { command: 'node', args: ['/some/notdist/src/mcp/server.js-wrapper'] } });
    assert.deepEqual(foreign.actions, []);
    assert.deepEqual(foreign.warnings, []);
  });

  it('plugin-managed: removes our exact entry, never adds, and never calls an existing entry absent', () => {
    assert.deepEqual(plan({ [MCP_SERVER_NAME]: desired }, true).actions.map(a => `${a.kind} ${a.name}`), [`remove ${MCP_SERVER_NAME}`]);
    const empty = plan({}, true);
    assert.deepEqual(empty.actions, []);
    assert.match(empty.notes[0], /no user-scope .* plugin provides/u);
    // A wrapper-form entry (the plugin launcher copied by hand) ran a second
    // server while init said "no entry" (review): reported, with the command.
    for (const other of [
      { command: 'node', args: [OTHER] },
      { command: `/somewhere/bin/${NAMESPACE}-mcp.sh`, args: [] },
      { command: NAMESPACE, args: ['serve'] },
      { command: 'something-else' },
    ]) {
      const p = plan({ [MCP_SERVER_NAME]: other }, true);
      assert.deepEqual(p.actions, [], describeServerEntry(other));
      assert.deepEqual(p.notes, [], 'an existing entry is never reported as absent');
      assert.equal(p.warnings.length, 1);
      assert.ok(p.warnings[0].includes(`claude mcp remove ${MCP_SERVER_NAME} -s user`), p.warnings[0]);
    }
    // Legacy alias of THIS install still goes under the plugin.
    assert.deepEqual(plan({ [legacy]: { command: 'node', args: [SERVER] } }, true).actions.map(a => `${a.kind} ${a.name}`), [`remove ${legacy}`]);
  });
});

describe('command rendering', () => {
  it('argv uses the tested option orders; the pasteable line single-quotes the JSON', () => {
    const add = { kind: 'add' as const, name: MCP_SERVER_NAME, reason: '' };
    assert.deepEqual(commandArgv(add, desired), ['mcp', 'add-json', '-s', 'user', MCP_SERVER_NAME, JSON.stringify(desired)]);
    assert.equal(commandLine(add, desired), `claude mcp add-json -s user ${MCP_SERVER_NAME} '${JSON.stringify(desired)}'`);
    const remove = { kind: 'remove' as const, name: legacy, reason: '' };
    assert.deepEqual(commandArgv(remove, desired), ['mcp', 'remove', legacy, '-s', 'user']);
    assert.equal(commandLine(remove, desired), `claude mcp remove ${legacy} -s user`);
  });

  it('a single quote inside the JSON (a path with an apostrophe) is shell-escaped', () => {
    const odd = waykeepMcpServerEntry("/Users/o'brien/dist/src/mcp/server.js");
    const line = commandLine({ kind: 'add', name: MCP_SERVER_NAME, reason: '' }, odd);
    assert.ok(line.includes(`o'\\''brien`), line);
  });
});

describe('mcp-entry helpers', () => {
  it('exact-path match is the only thing that reads as OUR server; suffix match only flags a look-alike', () => {
    assert.equal(referencesServer({ args: [SERVER] }, SERVER), true);
    assert.equal(referencesServer({ args: [SERVER.replace(/\//g, '\\')] }, SERVER), true, 'Windows separators normalized');
    assert.equal(referencesServer({ args: [OTHER] }, SERVER), false);
    assert.equal(looksLikeWaykeepServer({ args: [OTHER] }), true);
    assert.equal(looksLikeWaykeepServer({ args: ['/x/server.js-wrapper'] }), false);
    assert.equal(looksLikeWaykeepServer(null), false);
    assert.equal(referencesServer('junk', SERVER), false);
  });

  it('recognizes the bin form (`waykeep serve`, legacy alias too) and the plugin launcher as Waykeep servers', () => {
    assert.equal(looksLikeWaykeepServer({ command: NAMESPACE, args: ['serve'] }), true);
    assert.equal(looksLikeWaykeepServer({ command: `/x/bin/${legacy}`, args: ['serve'] }), true);
    assert.equal(looksLikeWaykeepServer({ command: `C:\\tools\\${NAMESPACE}-mcp.sh`, args: [] }), true);
    assert.equal(looksLikeWaykeepServer({ command: NAMESPACE, args: ['doctor'] }), false, 'only the serve subcommand is a server');
    assert.equal(looksLikeWaykeepServer({ command: `${NAMESPACE}-other.sh` }), false);
  });

  it('sameServerEntry treats absent type/env/args as the CLI defaults and rejects a malformed value', () => {
    assert.equal(sameServerEntry({ command: 'node', args: [SERVER], env: desired.env }, desired), true);
    assert.equal(sameServerEntry({ command: 'node', args: [SERVER] }, desired), false, 'env differs');
    assert.equal(sameServerEntry(null, desired), false);
    assert.equal(sameServerEntry('x', desired), false);
  });

  it('describeServerEntry renders a command line or a placeholder', () => {
    assert.equal(describeServerEntry({ command: 'node', args: [OTHER] }), `node ${OTHER}`);
    assert.equal(describeServerEntry({}), '(malformed entry)');
    assert.equal(describeServerEntry(42), '(malformed entry)');
  });
});
