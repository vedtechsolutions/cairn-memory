/**
 * Parity step 5 — `cairn init` Codex wiring and `cairn doctor` parity check.
 * Hermetic: CAIRN_CODEX_DIR points at a temp dir (hermetic-env.cjs).
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';

// SELF-HERMETICIZE BEFORE ANYTHING ELSE. The suite's hermetic-env preload
// sets CAIRN_CODEX_DIR, but a direct `node --test <file>` run does not —
// and this file DELETES its target directory. Without this line, a direct
// run once recursively deleted a developer's real ~/.codex (auth, sessions,
// memories). Env is read at call time, so setting it here beats the
// hoisted imports below.
process.env.CAIRN_CODEX_DIR ??= mkdtempSync(join(tmpdir(), 'cairn-codex-test-'));

import {
  codexDir, codexHooksPath, codexConfigPath,
  codexHooks, codexHookCount, mergeCodexHooks,
  codexMcpBlock, hasCairnMcpServer, countTrustedHooksIn, pruneHookState,
  runCodexInit, postToolRouteFor, POST_TOOL_ROUTE, LEGACY_POST_TOOL_ROUTE,
  type CodexHooksFile,
} from '../src/cli/codex-init.js';
import { checkCodexParity } from '../src/cli/doctor.js';

const RELAY = '/install/dist/src/hooks/hook-relay';
const SHELL_RELAY = 'bash /install/dist/src/hooks/hook-relay.sh';

beforeEach(() => {
  // Hard refusal, independent of the env layer above: this test must never
  // be able to delete a real Codex home no matter how it is invoked.
  const target = resolve(codexDir());
  if (target === resolve(join(homedir(), '.codex'))) {
    throw new Error('refusing to run against the real ~/.codex — CAIRN_CODEX_DIR is not hermetic');
  }
  rmSync(target, { recursive: true, force: true });
});

function trustAll(hooksPath: string, file: CodexHooksFile): string {
  const lines: string[] = [];
  let i = 0;
  for (const [event, groups] of Object.entries(file.hooks)) {
    for (let g = 0; g < groups.length; g++) {
      for (let h = 0; h < groups[g].hooks.length; h++) {
        lines.push(`[hooks.state."${hooksPath}:${event.toLowerCase()}:${g}:${h}"]`);
        lines.push(`trusted_hash = "sha256:${(i++).toString(16).padStart(4, '0')}"`);
      }
    }
  }
  return lines.join('\n') + '\n';
}

describe('codexHooks generator', () => {
  it('wires all ten events through the relay with --client codex', () => {
    const file = codexHooks(RELAY);
    assert.equal(Object.keys(file.hooks).length, 10);
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
    assert.match(file.hooks.PostToolUse[0].hooks[0].command, / post-tool$/, 'fresh installs get the canonical route');
  });

  it('supports the shell-relay command form', () => {
    const file = codexHooks(SHELL_RELAY);
    assert.ok(file.hooks.SessionStart[0].hooks[0].command.startsWith('bash /install/'));
  });

  it('can generate the deprecated post-tool route for wired installs', () => {
    const file = codexHooks(RELAY, LEGACY_POST_TOOL_ROUTE);
    assert.match(file.hooks.PostToolUse[0].hooks[0].command, / codex-post-tool$/);
  });
});

describe('postToolRouteFor (D3 migration policy)', () => {
  const legacyFile = (): CodexHooksFile => codexHooks(RELAY, LEGACY_POST_TOOL_ROUTE);

  it('fresh installs get the canonical route', () => {
    assert.equal(postToolRouteFor({}, 0, false), POST_TOOL_ROUTE);
  });

  it('a TRUSTED legacy wiring keeps its route — renaming would invalidate hash-pinned trust', () => {
    assert.equal(postToolRouteFor(legacyFile(), 10, false), LEGACY_POST_TOOL_ROUTE);
  });

  it('an UNTRUSTED legacy wiring modernizes — there is no trust to preserve', () => {
    assert.equal(postToolRouteFor(legacyFile(), 0, false), POST_TOOL_ROUTE);
  });

  it('--migrate-routes always yields the canonical route', () => {
    assert.equal(postToolRouteFor(legacyFile(), 10, true), POST_TOOL_ROUTE);
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
  it('detects every valid declaration form of mcp_servers.cairn', () => {
    assert.equal(hasCairnMcpServer(''), false);
    assert.equal(hasCairnMcpServer('[mcp_servers.cairn]\ncommand = "node"\n'), true);
    assert.equal(hasCairnMcpServer('[mcp_servers."cairn"]\ncommand = "node"\n'), true);
    assert.equal(hasCairnMcpServer('mcp_servers.cairn.command = "node"\n'), true);
    assert.equal(hasCairnMcpServer('[mcp_servers]\ncairn = { command = "node" }\n'), true);
    assert.equal(hasCairnMcpServer('[mcp_servers]\nother = { command = "x" }\n[tui]\ncairn = 1\n'), false, 'cairn key outside [mcp_servers] does not count');
  });

  it('emits TOML literal strings and refuses paths a literal cannot express', () => {
    const block = codexMcpBlock('/srv/mcp/server.js');
    assert.ok(block);
    assert.match(block, /args = \['\/srv\/mcp\/server\.js'\]/, 'literal strings — backslash-safe');
    assert.equal(codexMcpBlock("/srv/o'brien/server.js"), null, 'single quote is inexpressible');
  });

  it('counts trusted vs disabled per hooks file via the [hooks.state] line scan', () => {
    const hooksPath = codexHooksPath();
    const toml = [
      `[hooks.state."${hooksPath}:session_start:0:0"]`,
      'trusted_hash = "sha256:aaaa"',
      `[hooks.state."${hooksPath}:pre_tool_use:0:0"]`,
      'enabled = false',
      'trusted_hash = "sha256:dddd"',
      `[hooks.state."/some/other/hooks.json:stop:0:0"]`,
      'trusted_hash = "sha256:bbbb"',
      `[hooks.state."${hooksPath}:stop:0:0"]`,
      'trusted_hash = "sha256:cccc"',
    ].join('\n');
    const count = countTrustedHooksIn(toml, hooksPath);
    assert.equal(count.trusted, 2, 'other files excluded; disabled excluded');
    assert.equal(count.disabled, 1, 'enabled=false counts as disabled even with a hash');
    assert.deepEqual(countTrustedHooksIn('', hooksPath), { trusted: 0, disabled: 0 });
  });

  it('pruneHookState removes exactly the sections for the given hooks file', () => {
    const hooksPath = codexHooksPath();
    const toml = [
      'model = "gpt-x"',
      `[hooks.state."${hooksPath}:stop:0:0"]`,
      'trusted_hash = "sha256:cccc"',
      `[hooks.state."/other/hooks.json:stop:0:0"]`,
      'trusted_hash = "sha256:bbbb"',
    ].join('\n');
    const pruned = pruneHookState(toml, hooksPath);
    assert.match(pruned, /^model = "gpt-x"/m);
    assert.ok(!pruned.includes(`"${hooksPath}:`));
    assert.ok(pruned.includes('/other/hooks.json'), 'foreign state kept');
  });
});

describe('runCodexInit (hermetic end to end)', () => {
  it('writes hooks.json, appends MCP, and repeat runs are byte-identical', () => {
    mkdirSync(codexDir(), { recursive: true });
    writeFileSync(codexConfigPath(), 'model = "gpt-x"'); // note: no trailing newline
    runCodexInit(RELAY, '/install/dist/src/mcp/server.js', false);

    const written1 = readFileSync(codexHooksPath(), 'utf-8');
    assert.equal(codexHookCount(JSON.parse(written1) as CodexHooksFile), 10);
    const config = readFileSync(codexConfigPath(), 'utf-8');
    assert.match(config, /^model = "gpt-x"/m, 'existing config preserved');
    assert.equal(hasCairnMcpServer(config), true, 'MCP appended');

    // Byte-identical re-run: THE property that preserves hook trust.
    runCodexInit(RELAY, '/install/dist/src/mcp/server.js', false);
    assert.equal(readFileSync(codexHooksPath(), 'utf-8'), written1);
    const config2 = readFileSync(codexConfigPath(), 'utf-8');
    assert.equal(config2.match(/\[mcp_servers\.cairn\]/g)?.length, 1, 'no duplicate declaration');
    assert.ok(existsSync(`${codexConfigPath()}.cairn-backup`));
  });

  it('prunes orphaned trust state when the Cairn command set changes', () => {
    mkdirSync(codexDir(), { recursive: true });
    // Install + trust on the binary relay…
    runCodexInit(RELAY, '/srv/server.js', false);
    const trusted = trustAll(codexHooksPath(), JSON.parse(readFileSync(codexHooksPath(), 'utf-8')) as CodexHooksFile);
    writeFileSync(codexConfigPath(), readFileSync(codexConfigPath(), 'utf-8') + trusted);
    assert.equal(countTrustedHooksIn(readFileSync(codexConfigPath(), 'utf-8'), codexHooksPath()).trusted, 10);

    // …then re-init with the shell relay: commands change, trust must not
    // survive in the report or the state file.
    runCodexInit(SHELL_RELAY, '/srv/server.js', false);
    const after = readFileSync(codexConfigPath(), 'utf-8');
    assert.equal(countTrustedHooksIn(after, codexHooksPath()).trusted, 0, 'orphaned state pruned');
  });

  it('preserves a trusted legacy post-tool route across re-init, then migrates on --migrate-routes', () => {
    mkdirSync(codexDir(), { recursive: true });
    // Seed a wired-and-trusted legacy install, written exactly as init writes.
    const legacy = codexHooks(RELAY, LEGACY_POST_TOOL_ROUTE);
    writeFileSync(codexHooksPath(), `${JSON.stringify(legacy, null, 2)}\n`);
    writeFileSync(codexConfigPath(), '[mcp_servers.cairn]\ncommand = \'node\'\nargs = [\'/srv/server.js\']\n' + trustAll(codexHooksPath(), legacy));
    const seeded = readFileSync(codexHooksPath(), 'utf-8');

    // Default re-init: byte-identical file, trust untouched — THE property
    // that keeps an upgraded install's hooks alive without a re-review.
    runCodexInit(RELAY, '/srv/server.js', false);
    assert.equal(readFileSync(codexHooksPath(), 'utf-8'), seeded, 'trusted legacy wiring preserved verbatim');
    assert.equal(countTrustedHooksIn(readFileSync(codexConfigPath(), 'utf-8'), codexHooksPath()).trusted, 10, 'trust survives');

    // Explicit migration: canonical route written, orphaned trust pruned.
    runCodexInit(RELAY, '/srv/server.js', false, true);
    const migrated = readFileSync(codexHooksPath(), 'utf-8');
    assert.match(migrated, / post-tool"/, 'canonical route written');
    assert.ok(!migrated.includes(LEGACY_POST_TOOL_ROUTE), 'deprecated route gone');
    assert.equal(countTrustedHooksIn(readFileSync(codexConfigPath(), 'utf-8'), codexHooksPath()).trusted, 0, 'invalidated trust pruned for re-review');
  });

  it('rewrites an UNTRUSTED legacy wiring to the canonical route without --migrate-routes', () => {
    mkdirSync(codexDir(), { recursive: true });
    const legacy = codexHooks(RELAY, LEGACY_POST_TOOL_ROUTE);
    writeFileSync(codexHooksPath(), `${JSON.stringify(legacy, null, 2)}\n`);
    runCodexInit(RELAY, '/srv/server.js', false);
    const written = readFileSync(codexHooksPath(), 'utf-8');
    assert.ok(!written.includes(LEGACY_POST_TOOL_ROUTE), 'nothing trusted, nothing to preserve');
  });

  it('does nothing when the codex dir is absent, and writes nothing on dry-run', () => {
    runCodexInit(RELAY, '/srv/server.js', false); // dir absent — no throw
    assert.equal(existsSync(codexHooksPath()), false);

    mkdirSync(codexDir(), { recursive: true });
    runCodexInit(RELAY, '/srv/server.js', true); // dry run
    assert.equal(existsSync(codexHooksPath()), false);
    assert.equal(existsSync(codexConfigPath()), false);
  });
});

describe('doctor checkCodexParity', () => {
  it('walks every state: absent, unwired, invalid, wrong shape, awaiting, disabled, trusted', () => {
    // Absent dir → ok / nothing to wire.
    assert.equal(checkCodexParity().status, 'ok');

    mkdirSync(codexDir(), { recursive: true });
    assert.equal(checkCodexParity().status, 'warn'); // detected, no hooks.json
    assert.match(checkCodexParity().detail, /not installed/);

    writeFileSync(codexHooksPath(), 'not json');
    assert.match(checkCodexParity().detail, /not a valid hooks file/);
    writeFileSync(codexHooksPath(), '{}');
    assert.equal(checkCodexParity().status, 'warn', 'wrong shape is a warn, not a crash');
    writeFileSync(codexHooksPath(), 'null');
    assert.equal(checkCodexParity().status, 'warn');

    // Wired but untrusted → awaiting review.
    runCodexInit(RELAY, '/srv/server.js', false);
    assert.match(checkCodexParity().detail, /awaiting one-time trust review \(0\/10/);

    // Fully trusted → ok.
    const file = JSON.parse(readFileSync(codexHooksPath(), 'utf-8')) as CodexHooksFile;
    writeFileSync(codexConfigPath(), readFileSync(codexConfigPath(), 'utf-8') + trustAll(codexHooksPath(), file));
    const ok = checkCodexParity();
    assert.equal(ok.status, 'ok');
    assert.match(ok.detail, /trusted \(10\/10 hooks; MCP registered\)/);

    // One hook disabled → warn naming the disabled count.
    const config = readFileSync(codexConfigPath(), 'utf-8')
      .replace('trusted_hash = "sha256:0000"', 'enabled = false\ntrusted_hash = "sha256:0000"');
    writeFileSync(codexConfigPath(), config);
    const disabled = checkCodexParity();
    assert.equal(disabled.status, 'warn');
    assert.match(disabled.detail, /1 hook\(s\) are DISABLED/);
  });

  it('notes deprecated route wiring without failing the check (D3 window)', () => {
    mkdirSync(codexDir(), { recursive: true });
    const legacy = codexHooks(RELAY, LEGACY_POST_TOOL_ROUTE);
    writeFileSync(codexHooksPath(), `${JSON.stringify(legacy, null, 2)}\n`);
    writeFileSync(codexConfigPath(), trustAll(codexHooksPath(), legacy));
    const result = checkCodexParity();
    assert.equal(result.status, 'ok', 'deprecated wiring stays green while the alias is served');
    assert.match(result.detail, /deprecated 'codex-post-tool' route wiring.*--migrate-routes/);

    // Canonical wiring carries no note.
    runCodexInit(RELAY, '/srv/server.js', false, true);
    assert.ok(!checkCodexParity().detail.includes('deprecated'), 'no note after migration');
  });
});
