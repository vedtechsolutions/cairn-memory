/**
 * Parity step 5 — `cairn init` Codex wiring and `cairn doctor` parity check.
 * Hermetic: CAIRN_CODEX_DIR points at a temp dir (hermetic-env.cjs).
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import {
  codexDir, codexHooksPath, codexConfigPath,
  codexHooks, codexHookCount, mergeCodexHooks,
  codexMcpBlock, hasCairnMcpServer, countTrustedCairnHooks,
  runCodexInit, type CodexHooksFile,
} from '../src/cli/codex-init.js';

const RELAY = '/install/dist/src/hooks/hook-relay';

beforeEach(() => {
  rmSync(codexDir(), { recursive: true, force: true });
});

describe('codexHooks generator', () => {
  it('wires all ten events through the relay with --client codex', () => {
    const file = codexHooks(RELAY);
    const events = Object.keys(file.hooks);
    assert.equal(events.length, 10);
    for (const groups of Object.values(file.hooks)) {
      for (const g of groups) {
        for (const h of g.hooks) {
          assert.match(h.command, /--client codex /);
          assert.ok(h.command.startsWith(RELAY));
        }
      }
    }
    assert.equal(codexHookCount(file), 10);
  });

  it('encodes the load-bearing per-hook settings', () => {
    const file = codexHooks(RELAY);
    assert.equal(file.hooks.SessionEnd[0].hooks[0].timeout, 3, 'Codex clamps SessionEnd to 3s');
    assert.equal(file.hooks.SessionStart[0].hooks[0].additionalContextLimit, 2500);
    assert.equal(file.hooks.PostToolUse[0].matcher, 'Bash|apply_patch');
    assert.equal(file.hooks.PostToolUse[0].hooks[0].async, true);
    assert.match(file.hooks.PostToolUse[0].hooks[0].command, /codex-post-tool$/);
  });
});

describe('mergeCodexHooks', () => {
  it('preserves foreign hook groups and replaces stale Cairn ones', () => {
    const generated = codexHooks(RELAY);
    const existing: Partial<CodexHooksFile> = {
      hooks: {
        SessionStart: [
          { hooks: [{ type: 'command', command: '/usr/local/bin/my-own-hook' }] },
          { hooks: [{ type: 'command', command: '/old-install/dist/src/hooks/hook-relay --client codex session-start' }] },
        ],
        Notification: [{ hooks: [{ type: 'command', command: 'notify-send hi' }] }],
      },
    };
    const merged = mergeCodexHooks(existing, generated);
    const sessionStart = merged.hooks.SessionStart;
    assert.equal(sessionStart.length, 2, 'foreign kept + one fresh Cairn group');
    assert.equal(sessionStart[0].hooks[0].command, '/usr/local/bin/my-own-hook');
    assert.ok(sessionStart[1].hooks[0].command.startsWith(RELAY), 'stale Cairn entry replaced');
    assert.equal(merged.hooks.Notification[0].hooks[0].command, 'notify-send hi', 'foreign event untouched');
  });

  it('is idempotent', () => {
    const generated = codexHooks(RELAY);
    const once = mergeCodexHooks({}, generated);
    const twice = mergeCodexHooks(once, generated);
    assert.deepEqual(twice, once);
  });
});

describe('config.toml scoped edits', () => {
  it('detects and appends the MCP block exactly once', () => {
    const empty = '';
    assert.equal(hasCairnMcpServer(empty), false);
    const appended = empty + codexMcpBlock('/install/dist/src/mcp/server.js');
    assert.equal(hasCairnMcpServer(appended), true);
    assert.match(appended, /\[mcp_servers\.cairn\]/);
  });

  it('counts trusted Cairn hooks via the [hooks.state] line scan', () => {
    const hooksPath = codexHooksPath();
    const toml = [
      `[hooks.state."${hooksPath}:session_start:0:0"]`,
      'trusted_hash = "sha256:aaaa"',
      `[hooks.state."${hooksPath}:pre_tool_use:0:0"]`,
      'enabled = false',
      `[hooks.state."/some/other/hooks.json:stop:0:0"]`,
      'trusted_hash = "sha256:bbbb"',
      `[hooks.state."${hooksPath}:stop:0:0"]`,
      'trusted_hash = "sha256:cccc"',
    ].join('\n');
    // Only entries for OUR hooks file WITH a trusted_hash count.
    assert.equal(countTrustedCairnHooks(toml, hooksPath), 2);
    assert.equal(countTrustedCairnHooks('', hooksPath), 0);
  });
});

describe('runCodexInit (hermetic end to end)', () => {
  it('writes hooks.json and appends MCP registration when ~/.codex exists', () => {
    mkdirSync(codexDir(), { recursive: true });
    writeFileSync(codexConfigPath(), 'model = "gpt-x"\n');
    runCodexInit(RELAY, '/install/dist/src/mcp/server.js', false);

    const written = JSON.parse(readFileSync(codexHooksPath(), 'utf-8')) as CodexHooksFile;
    assert.equal(codexHookCount(written), 10);
    const config = readFileSync(codexConfigPath(), 'utf-8');
    assert.match(config, /^model = "gpt-x"/m, 'existing config preserved');
    assert.equal(hasCairnMcpServer(config), true, 'MCP appended');

    // Re-run: idempotent, no duplicate MCP block, backup preserved once.
    runCodexInit(RELAY, '/install/dist/src/mcp/server.js', false);
    const config2 = readFileSync(codexConfigPath(), 'utf-8');
    assert.equal(config2.match(/\[mcp_servers\.cairn\]/g)?.length, 1);
    assert.ok(existsSync(`${codexConfigPath()}.cairn-backup`));
  });

  it('does nothing when the codex dir is absent, and writes nothing on dry-run', () => {
    runCodexInit(RELAY, '/srv/server.js', false); // dir absent — no throw
    assert.equal(existsSync(codexHooksPath()), false);

    mkdirSync(codexDir(), { recursive: true });
    runCodexInit(RELAY, '/srv/server.js', true); // dry run
    assert.equal(existsSync(codexHooksPath()), false);
  });
});
