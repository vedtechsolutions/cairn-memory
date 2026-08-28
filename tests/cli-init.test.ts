import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli', 'index.js');

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
      CAIRN_CLAUDE_SETTINGS: settingsPath,
      // init WRITES the Codex dir now — must stay hermetic even when this
      // file is run directly without the hermetic-env preload.
      CAIRN_CODEX_DIR: process.env.CAIRN_CODEX_DIR ?? `${settingsPath}.codex-hermetic`,
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
    assert.ok(s.mcpServers?.cairn, 'cairn MCP server written');
    assert.ok(s.statusLine, 'statusLine written');
    // All 14 hook events present.
    const events = Object.keys(s.hooks ?? {});
    for (const e of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse',
      'PostToolUseFailure', 'PreCompact', 'PostCompact', 'SessionEnd', 'SubagentStart',
      'Stop', 'SubagentStop', 'StopFailure', 'FileChanged']) {
      assert.ok(events.includes(e), `hook event ${e} present`);
    }
    // Stop: governance-gate (sync) precedes stop (async).
    const stop = s.hooks!.Stop[0].hooks;
    assert.match(stop[0].command, /governance-gate/u);
    assert.match(stop[1].command, /hook-relay stop$/u);
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
    assert.ok(s.mcpServers?.cairn, 'cairn MCP server added');
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
    const backup = JSON.parse(readFileSync(`${path}.cairn-backup`, 'utf-8')) as Settings;
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
