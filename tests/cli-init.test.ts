import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENV } from '../src/constants/env.js';
import { MCP_SERVER_NAME } from '../src/constants/mcp.js';
import { BACKUP_SUFFIX } from '../src/constants/paths.js';
import { LEGACY_NAMESPACES } from 'waykeep-contract';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli', 'index.js');
/** The exact absolute server.js path `waykeep init` resolves for THIS install. */
const SERVER = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'mcp', 'server.js');

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

function tempSettingsPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cairn-init-'));
  dirs.push(dir);
  return join(dir, 'settings.json');
}

function init(settingsPath: string, args: string[] = []): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [CLI, 'init', ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      [ENV.CLAUDE_SETTINGS]: settingsPath,
      // init WRITES the Codex dir now — must stay hermetic even when this
      // file is run directly without the hermetic-env preload.
      [ENV.CODEX_DIR]: process.env[ENV.CODEX_DIR] ?? `${settingsPath}.codex-hermetic`,
      // …and reads ~/.claude.json + shells out to `claude mcp`: neither may
      // reach the real ones on a direct run either (an absent CLI path makes
      // init print the commands instead of spawning anything).
      [ENV.CLAUDE_CONFIG]: process.env[ENV.CLAUDE_CONFIG] ?? `${settingsPath}.claude-json-hermetic`,
      [ENV.CLAUDE_BIN]: process.env[ENV.CLAUDE_BIN] ?? `${settingsPath}.claude-cli-absent`,
    },
  }) as SpawnSyncReturns<string>;
}

interface HookCmd { command: string }
interface Settings {
  mcpServers?: Record<string, unknown>;
  statusLine?: { command?: string };
  hooks?: Record<string, Array<{ hooks: HookCmd[] }>>;
  [k: string]: unknown;
}
function read(path: string): Settings { return JSON.parse(readFileSync(path, 'utf-8')) as Settings; }

describe('cairn init CLI', () => {
  it('writes a full config to a fresh settings.json and exits 0', () => {
    const path = tempSettingsPath();
    const result = init(path);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const s = read(path);
    // Claude Code never reads mcpServers from settings.json — the server is
    // registered through `claude mcp` (tests/cli-init-claude-mcp.test.ts).
    assert.equal(s.mcpServers, undefined, 'no inert mcpServers block in settings.json');
    assert.match(result.stdout, /Claude Code MCP registry/u, 'the registry step ran');
    assert.ok(s.statusLine, 'statusLine written');
    // All 12 wired hook events present (FileChanged is deliberately not wired).
    const events = Object.keys(s.hooks ?? {});
    for (const e of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse',
      'PostToolUseFailure', 'PreCompact', 'PostCompact', 'SessionEnd', 'SubagentStart',
      'Stop', 'SubagentStop', 'StopFailure']) {
      assert.ok(events.includes(e), `hook event ${e} present`);
    }
    // Stop: governance-gate (sync) precedes stop (async).
    const stop = s.hooks!.Stop[0].hooks;
    assert.match(stop[0].command, /governance-gate/u);
    assert.match(stop[1].command, /hook-relay stop$/u);
  });

  it('sweeps a legacy `cairn` MCP server that launches OUR EXACT server.js on in-place upgrade', () => {
    const legacy = LEGACY_NAMESPACES[0];
    const path = tempSettingsPath();
    writeFileSync(path, JSON.stringify({
      mcpServers: { [legacy]: { command: 'node', args: [SERVER] } },
    }));
    const result = init(path);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const s = read(path);
    assert.equal(s.mcpServers?.[legacy], undefined, 'retired-namespace alias of THIS install removed');
    assert.equal(s.mcpServers, undefined, 'the emptied (inert) block is dropped, not left as {}');
    assert.match(result.stdout, /inert here/u, 'the sweep says WHY the block goes');
  });

  it('KEEPS + WARNS on a legacy `cairn` server at a DIFFERENT install path (never deletes foreign)', () => {
    const legacy = LEGACY_NAMESPACES[0];
    const path = tempSettingsPath();
    // A waykeep/cairn server.js, but a DIFFERENT install — could be a relocated
    // old install OR another project. Must NOT be deleted (codex B1 review).
    writeFileSync(path, JSON.stringify({
      mcpServers: { [legacy]: { command: 'node', args: ['/home/user/other-project/dist/src/mcp/server.js'] } },
    }));
    const result = init(path);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const s = read(path);
    assert.ok(s.mcpServers?.[legacy], 'a look-alike at another path must NOT be deleted');
    assert.match(result.stdout, /left in place/u, 'must warn about the retained legacy server');
  });

  it('KEEPS a foreign server merely named `cairn` that does not launch our server.js', () => {
    const legacy = LEGACY_NAMESPACES[0];
    const path = tempSettingsPath();
    // Substring-y but NOT ours: a full-segment/exact-suffix match must reject it.
    writeFileSync(path, JSON.stringify({
      mcpServers: { [legacy]: { command: 'node', args: ['/some/notdist/src/mcp/server.js-wrapper'] } },
    }));
    const result = init(path);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const s = read(path);
    assert.ok(s.mcpServers?.[legacy], 'a foreign server merely named cairn must NOT be swept');
  });

  it('--dry-run previews and writes nothing', () => {
    const path = tempSettingsPath();
    const result = init(path, ['--dry-run']);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /dry run/u);
    assert.equal(existsSync(path), false, 'dry run must not write');
  });

  it('preserves the user\'s other config and skips a non-Cairn StatusLine', () => {
    const path = tempSettingsPath();
    writeFileSync(path, JSON.stringify({
      model: 'opus',
      mcpServers: { other: { command: 'x' } },
      statusLine: { type: 'command', command: 'my-custom-statusline' },
      hooks: { SessionStart: [{ matcher: '', hooks: [{ type: 'command', command: 'user-own-hook' }] }] },
    }));
    const result = init(path);
    assert.equal(result.status, 0);
    const s = read(path);
    assert.equal(s.model, 'opus', 'unrelated setting kept');
    assert.ok(s.mcpServers?.other, 'other MCP server kept');
    assert.equal(s.mcpServers?.[MCP_SERVER_NAME], undefined, 'never written to settings.json (inert there)');
    assert.equal(s.statusLine?.command, 'my-custom-statusline', 'non-Cairn StatusLine untouched');
    const ss = s.hooks!.SessionStart;
    assert.ok(ss.some(e => e.hooks.some(h => h.command === 'user-own-hook')), 'user hook preserved');
    assert.ok(ss.some(e => e.hooks.some(h => h.command.includes('hook-relay session-start'))), 'cairn hook added');
  });

  it('migrates a legacy node-form Cairn hook instead of duplicating it (B1 regression)', () => {
    const path = tempSettingsPath();
    // The older hand-written form: node .../dist/src/hooks/session-start.js
    writeFileSync(path, JSON.stringify({
      hooks: { SessionStart: [{ matcher: '', hooks: [{ type: 'command', command: 'node /opt/cairn/dist/src/hooks/session-start.js' }] }] },
    }));
    init(path);
    const ss = read(path).hooks!.SessionStart;
    assert.equal(ss.length, 1, 'legacy Cairn entry replaced, not appended alongside');
    assert.ok(!ss.some(e => e.hooks.some(h => h.command.includes('session-start.js'))), 'legacy node-form removed');
    assert.ok(ss.some(e => e.hooks.some(h => h.command.includes('hook-relay session-start'))), 'current relay form present');
  });

  it('is idempotent — a second run produces byte-identical output', () => {
    const path = tempSettingsPath();
    init(path);
    const first = readFileSync(path, 'utf-8');
    init(path);
    assert.equal(readFileSync(path, 'utf-8'), first, 'second init must not change the file');
  });

  it('backs up the pristine file and never overwrites that backup on re-run', () => {
    const path = tempSettingsPath();
    writeFileSync(path, JSON.stringify({ model: 'sonnet' }));
    init(path);
    init(path); // second run must not clobber the pristine backup
    const backup = JSON.parse(readFileSync(`${path}${BACKUP_SUFFIX}`, 'utf-8')) as Settings;
    assert.equal(backup.model, 'sonnet');
    assert.equal(backup.mcpServers, undefined, 'backup is the pre-init original, not a merged copy');
  });

  it('exits 1 with a clear error on malformed settings and does not overwrite it', () => {
    const path = tempSettingsPath();
    writeFileSync(path, 'null');
    const result = init(path);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /not a JSON object/u);
    assert.equal(readFileSync(path, 'utf-8'), 'null', 'malformed file left untouched');
  });
});

// --- Step-6 review round: plugin coexistence + orphan sweep --------------------

describe('init review round (step 6)', () => {
  it('--statusline-only writes ONLY the StatusLine (plugin-managed hooks untouched)', () => {
    const settingsPath = tempSettingsPath();
    writeFileSync(settingsPath, JSON.stringify({ hooks: { SessionStart: [{ matcher: '', hooks: [{ type: 'command', command: 'my-own-hook' }] }] } }));
    const r = init(settingsPath, ['--statusline-only']);
    assert.equal(r.status, 0, r.stderr);
    const written = JSON.parse(readFileSync(settingsPath, 'utf8')) as Settings;
    assert.ok(written.statusLine?.command?.includes('statusline'), 'StatusLine is wired');
    assert.equal(written.mcpServers, undefined, 'no MCP server — the plugin provides it');
    assert.equal(written.hooks?.SessionStart?.[0]?.hooks?.[0]?.command, 'my-own-hook', 'hooks untouched');
    assert.equal(Object.keys(written.hooks ?? {}).length, 1, 'no Cairn hooks added — a full init here would double-fire every event');
    // And the codex side is untouched too.
    assert.ok(!existsSync(`${settingsPath}.codex-hermetic/hooks.json`), 'codex wiring skipped under --statusline-only');
  });

  it('re-init sweeps stale Cairn entries under retired events, preserving foreign ones', () => {
    const settingsPath = tempSettingsPath();
    // A previous install wired FileChanged (retired) — Cairn entry plus a
    // user's own entry under the same event.
    writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        FileChanged: [
          { matcher: '', hooks: [{ type: 'command', command: '/old/install/dist/src/hooks/hook-relay file-changed', async: true }] },
          { matcher: '', hooks: [{ type: 'command', command: 'users-own-watcher' }] },
        ],
      },
    }));
    const r = init(settingsPath);
    assert.equal(r.status, 0, r.stderr);
    const written = JSON.parse(readFileSync(settingsPath, 'utf8')) as Settings;
    const fileChanged = written.hooks?.FileChanged ?? [];
    assert.equal(fileChanged.length, 1, 'the stale Cairn entry is swept — it would otherwise survive every upgrade');
    assert.equal(fileChanged[0]?.hooks?.[0]?.command, 'users-own-watcher', 'the foreign entry under the retired event survives');
  });

  it('a retired event with ONLY Cairn entries is removed entirely', () => {
    const settingsPath = tempSettingsPath();
    writeFileSync(settingsPath, JSON.stringify({
      hooks: { FileChanged: [{ matcher: '', hooks: [{ type: 'command', command: '/old/dist/src/hooks/hook-relay file-changed' }] }] },
    }));
    const r = init(settingsPath);
    assert.equal(r.status, 0, r.stderr);
    const written = JSON.parse(readFileSync(settingsPath, 'utf8')) as Settings;
    assert.equal(written.hooks?.FileChanged, undefined);
  });
});

describe('statusline-only migration sweep (review N4)', () => {
  it('removes settings-wired Cairn hooks + MCP when switching to the plugin', () => {
    const settingsPath = tempSettingsPath();
    // The existing-user shape: full init done BEFORE the plugin existed.
    const first = init(settingsPath);
    assert.equal(first.status, 0, first.stderr);
    const before = JSON.parse(readFileSync(settingsPath, 'utf8')) as Settings;
    assert.ok(Object.keys(before.hooks ?? {}).length >= 10, 'sanity: fully wired');
    // The inert MCP block a pre-fix init wrote (current init no longer does).
    before.mcpServers = { [MCP_SERVER_NAME]: { command: 'node', args: [SERVER] } };
    // Add a foreign hook that must survive the sweep.
    before.hooks!.SessionStart!.push({ hooks: [{ command: 'users-own-hook' }] });
    writeFileSync(settingsPath, JSON.stringify(before));

    const r = init(settingsPath, ['--statusline-only']);
    assert.equal(r.status, 0, r.stderr);
    const after = JSON.parse(readFileSync(settingsPath, 'utf8')) as Settings;
    assert.equal(after.mcpServers, undefined, 'the inert MCP block is swept (and the emptied key dropped)');
    const allCommands = JSON.stringify(after.hooks ?? {});
    assert.ok(!allCommands.includes('dist/src/hooks'), 'no settings-wired Cairn hooks remain (double-fire closed)');
    assert.ok(allCommands.includes('users-own-hook'), 'foreign hooks survive');
    assert.ok(after.statusLine?.command?.includes('statusline'), 'StatusLine kept');
  });
});

describe('sweeps are handler-granular (codex round-3)', () => {
  it('a MIXED entry keeps the user handler when the Cairn handler is swept', () => {
    const settingsPath = tempSettingsPath();
    // One matcher entry carrying BOTH a stale Cairn handler and the
    // user's own — entry-level removal deleted the user's (review).
    writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        FileChanged: [{ matcher: '', hooks: [
          { type: 'command', command: '/old/dist/src/hooks/hook-relay file-changed' },
          { type: 'command', command: 'users-own-watcher' },
        ] }],
      },
    }));
    const r = init(settingsPath);
    assert.equal(r.status, 0, r.stderr);
    const written = JSON.parse(readFileSync(settingsPath, 'utf8')) as Settings;
    const cmds = JSON.stringify(written.hooks?.FileChanged ?? []);
    assert.ok(cmds.includes('users-own-watcher'), 'the foreign handler in the mixed entry survives');
    assert.ok(!cmds.includes('dist/src/hooks'), 'the Cairn handler is gone');
  });

  it('--statusline-only sweep is also handler-granular on mixed entries', () => {
    const settingsPath = tempSettingsPath();
    writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        SessionStart: [{ matcher: '', hooks: [
          { type: 'command', command: '/old/dist/src/hooks/hook-relay session-start' },
          { type: 'command', command: 'users-own-hook' },
        ] }],
      },
    }));
    const r = init(settingsPath, ['--statusline-only']);
    assert.equal(r.status, 0, r.stderr);
    const written = JSON.parse(readFileSync(settingsPath, 'utf8')) as Settings;
    const cmds = JSON.stringify(written.hooks?.SessionStart ?? []);
    assert.ok(cmds.includes('users-own-hook'), 'the foreign handler in the mixed entry survives the migration sweep');
    assert.ok(!cmds.includes('dist/src/hooks'), 'the Cairn handler is gone');
  });
});

describe('sweep resilience to malformed entries (codex round-4)', () => {
  it('an entry without a hooks array is preserved as foreign, never a crash', () => {
    const settingsPath = tempSettingsPath();
    writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        SessionStart: [
          { matcher: '' }, // user-authored malformed entry — settings are arbitrary JSON
          { matcher: '', hooks: [{ type: 'command', command: '/old/dist/src/hooks/hook-relay session-start' }] },
        ],
      },
    }));
    const r = init(settingsPath, ['--statusline-only']);
    assert.equal(r.status, 0, `must not abort on a malformed entry: ${r.stderr}`);
    const written = JSON.parse(readFileSync(settingsPath, 'utf8')) as Settings;
    const entries = written.hooks?.SessionStart ?? [];
    assert.equal(entries.length, 1, 'the Cairn entry is swept');
    assert.equal((entries[0] as { hooks?: unknown }).hooks, undefined, 'the malformed entry survives untouched');
  });
});
