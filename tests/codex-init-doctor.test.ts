/**
 * Parity step 5 — `cairn init` Codex wiring and `cairn doctor` parity check.
 * Hermetic: CAIRN_CODEX_DIR points at a temp dir (hermetic-env.cjs).
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// SELF-HERMETICIZE BEFORE ANYTHING ELSE — and UNCONDITIONALLY. Two reasons:
// a direct `node --test <file>` run has no hermetic-env preload, and this
// file DELETES its target directory (a conditional ??= once let a direct
// run recursively delete a developer's real ~/.codex — auth, sessions,
// memories). And under the full suite the preload's dir is SHARED across
// test processes: other files spawn the CLI against it concurrently, so
// this file's beforeEach rmSync raced them (observed flake: doctor's
// parity walk failing mid-suite, green in isolation). A private mkdtemp
// removes both hazards. Env is read at call time, so setting it here
// beats the hoisted imports below.
process.env.CAIRN_CODEX_DIR = mkdtempSync(join(tmpdir(), 'cairn-codex-test-'));

import {
  codexDir, codexHooksPath, codexConfigPath,
  codexHooks, codexHookCount, mergeCodexHooks,
  codexMcpBlock, hasCairnMcpServer, countTrustedHooksIn,
  runCodexInit, postToolRouteFor, POST_TOOL_ROUTE, LEGACY_POST_TOOL_ROUTE,
  parseTrustState, commandAt, trustedCommandsIn, pruneTrustKeys,
  type CodexHooksFile,
} from '../src/cli/codex-init.js';
import { checkCodexParity } from '../src/cli/doctor.js';

// THE RUNNING INSTALL's paths: doctor now short-circuits when the wired
// install dir is missing (moved/removed) OR is a different install than
// the one running doctor (stale nvm tree), so fixtures wire the real
// repo dist — exactly what a healthy install looks like.
const INSTALL = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const RELAY = `${INSTALL}/dist/src/hooks/hook-relay`;
const SHELL_RELAY = `bash ${INSTALL}/dist/src/hooks/hook-relay.sh`;

beforeEach(() => {
  // Hard refusal, independent of the env layer above: this test must never
  // be able to delete a real Codex home no matter how it is invoked.
  const target = resolve(codexDir());
  if (target === resolve(join(homedir(), '.codex'))) {
    throw new Error('refusing to run against the real ~/.codex — CAIRN_CODEX_DIR is not hermetic');
  }
  rmSync(target, { recursive: true, force: true });
});

/** Codex trust-state keys use the SNAKE_CASE event name (verified live:
 *  session_start, post_tool_use) — the position-join machinery depends
 *  on it, so the fixture must match the real format. */
function snakeCase(event: string): string {
  return event.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

function trustAll(hooksPath: string, file: CodexHooksFile): string {
  const lines: string[] = [];
  let i = 0;
  for (const [event, groups] of Object.entries(file.hooks)) {
    for (let g = 0; g < groups.length; g++) {
      for (let h = 0; h < groups[g].hooks.length; h++) {
        lines.push(`[hooks.state."${hooksPath}:${snakeCase(event)}:${g}:${h}"]`);
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
    assert.ok(file.hooks.SessionStart[0].hooks[0].command.startsWith(`bash ${INSTALL}/`));
  });

  it('can generate the deprecated post-tool route for wired installs', () => {
    const file = codexHooks(RELAY, LEGACY_POST_TOOL_ROUTE);
    assert.match(file.hooks.PostToolUse[0].hooks[0].command, / codex-post-tool$/);
  });
});

describe('postToolRouteFor (D3 migration policy — exact-command trust)', () => {
  const legacyCmd = `${RELAY} --client codex ${LEGACY_POST_TOOL_ROUTE}`;

  it('fresh installs get the canonical route', () => {
    assert.equal(postToolRouteFor([], legacyCmd, false), POST_TOOL_ROUTE);
  });

  it('the EXACT trusted legacy command keeps its route — renaming would invalidate hash-pinned trust', () => {
    assert.equal(postToolRouteFor([legacyCmd], legacyCmd, false), LEGACY_POST_TOOL_ROUTE);
  });

  it('trust on OTHER commands does not make an untrusted legacy route look preserved', () => {
    // A trusted foreign hook and a trusted canonical route must both
    // leave the decision at canonical.
    assert.equal(postToolRouteFor([`/usr/local/bin/foreign ${LEGACY_POST_TOOL_ROUTE}`], legacyCmd, false), POST_TOOL_ROUTE);
    assert.equal(postToolRouteFor([`${RELAY} --client codex ${POST_TOOL_ROUTE}`], legacyCmd, false), POST_TOOL_ROUTE);
  });

  it('a relay-prefix change rides the forced re-trust into the canonical route for free', () => {
    // The legacy command is trusted, but under a DIFFERENT relay prefix:
    // its trust dies with the prefix change anyway, so preservation
    // would preserve nothing — migrate as part of the same re-review.
    const oldPrefixLegacy = `/old-install/dist/src/hooks/hook-relay --client codex ${LEGACY_POST_TOOL_ROUTE}`;
    assert.equal(postToolRouteFor([oldPrefixLegacy], legacyCmd, false), POST_TOOL_ROUTE);
  });

  it('--migrate-routes always yields the canonical route', () => {
    assert.equal(postToolRouteFor([legacyCmd], legacyCmd, true), POST_TOOL_ROUTE);
  });
});

describe('trust-state parsing and scoped pruning', () => {
  it('parseTrustState joins [hooks.state] keys back to positions; commandAt resolves them', () => {
    const hooksPath = codexHooksPath();
    const file = codexHooks(RELAY, LEGACY_POST_TOOL_ROUTE);
    const toml = [
      `[hooks.state."${hooksPath}:post_tool_use:0:0"]`,
      'trusted_hash = "sha256:aaaa"',
      `[hooks.state."${hooksPath}:session_start:0:0"]`,
      'enabled = false',
      'trusted_hash = "sha256:bbbb"',
      `[hooks.state."/other/hooks.json:stop:0:0"]`,
      'trusted_hash = "sha256:cccc"',
      `[hooks.state."${hooksPath}:stop:9:9"]`,
      'trusted_hash = "sha256:dddd"',
    ].join('\n');
    const entries = parseTrustState(toml, hooksPath);
    assert.equal(entries.length, 3, 'other files excluded');
    assert.deepEqual(entries.map((e) => e.trusted), [true, false, true], 'disabled entry not trusted');
    assert.match(commandAt(file, entries[0]) ?? '', / codex-post-tool$/);
    assert.match(commandAt(file, entries[1]) ?? '', / session-start$/);
    assert.equal(commandAt(file, entries[2]), null, 'nonexistent position resolves to null');
    const trusted = trustedCommandsIn(toml, hooksPath, file);
    assert.equal(trusted.length, 1, 'only resolvable trusted positions');
    assert.match(trusted[0], / codex-post-tool$/);
  });

  it('a hand-edited hooks.json cannot inherit a stale hash — the trust shadow fails closed', () => {
    // trusted_hash pins a command VALUE Cairn cannot recompute; the shadow
    // written at init records what each position held, so editing a Cairn
    // command in place must read as UNTRUSTED, never as the old trust.
    mkdirSync(codexDir(), { recursive: true });
    runCodexInit(RELAY, '/srv/server.js', false); // writes hooks.json + shadow
    const written = JSON.parse(readFileSync(codexHooksPath(), 'utf-8')) as CodexHooksFile;
    const config = trustAll(codexHooksPath(), written);
    assert.equal(countTrustedHooksIn(config, codexHooksPath(), written).trusted, 10, 'as-written wiring is fully trusted');

    // Tamper with one Cairn command at its position, config untouched.
    const tampered = JSON.parse(
      readFileSync(codexHooksPath(), 'utf-8').replace(' session-start', ' session-start --evil'),
    ) as CodexHooksFile;
    const counts = countTrustedHooksIn(config, codexHooksPath(), tampered);
    assert.equal(counts.trusted, 9, 'the tampered position loses its trust attribution');
    assert.ok(!trustedCommandsIn(config, codexHooksPath(), tampered).some((c) => c.includes('--evil')),
      'the tampered command is never reported as trusted');
  });

  it('an externally reordered hooks.json cannot LAUNDER a stale hash through the shadow refresh', () => {
    mkdirSync(codexDir(), { recursive: true });
    // Wire Cairn, then add a foreign SessionStart group AFTER Cairn's and
    // re-init so the shadow records both positions; trust everything.
    runCodexInit(RELAY, '/srv/server.js', false);
    const wired = JSON.parse(readFileSync(codexHooksPath(), 'utf-8')) as CodexHooksFile;
    wired.hooks.SessionStart.push({ hooks: [{ type: 'command', command: '/usr/local/bin/my-hook' }] });
    writeFileSync(codexHooksPath(), `${JSON.stringify(wired, null, 2)}\n`);
    runCodexInit(RELAY, '/srv/server.js', false); // refreshes the shadow for 11 positions
    const trusted = JSON.parse(readFileSync(codexHooksPath(), 'utf-8')) as CodexHooksFile;
    writeFileSync(codexConfigPath(), trustAll(codexHooksPath(), trusted));
    assert.equal(countTrustedHooksIn(readFileSync(codexConfigPath(), 'utf-8'), codexHooksPath(), trusted).trusted, 11);

    // EXTERNAL swap of the two SessionStart groups: same commands, moved
    // positions — every hash now sits at a position it never attested.
    const swapped = JSON.parse(readFileSync(codexHooksPath(), 'utf-8')) as CodexHooksFile;
    [swapped.hooks.SessionStart[0], swapped.hooks.SessionStart[1]] =
      [swapped.hooks.SessionStart[1], swapped.hooks.SessionStart[0]];
    writeFileSync(codexHooksPath(), `${JSON.stringify(swapped, null, 2)}\n`);
    const config = readFileSync(codexConfigPath(), 'utf-8');
    assert.equal(countTrustedHooksIn(config, codexHooksPath(), swapped).trusted, 10,
      'pre-init: the shadow already refuses the moved Cairn position');

    // Re-init sees NO command delta (merged === existing) — the refresh
    // must not re-attest the moved position back to 11 (the laundering).
    runCodexInit(RELAY, '/srv/server.js', false);
    const finalFile = JSON.parse(readFileSync(codexHooksPath(), 'utf-8')) as CodexHooksFile;
    const finalConfig = readFileSync(codexConfigPath(), 'utf-8');
    assert.equal(countTrustedHooksIn(finalConfig, codexHooksPath(), finalFile).trusted, 10,
      'the moved Cairn position re-reviews; laundering back to 11/11 is the bug');
    assert.equal(parseTrustState(finalConfig, codexHooksPath()).length, 10,
      'its stale entry is pruned, not merely discounted');
  });

  it('pruneTrustKeys removes exactly the named sections', () => {
    const hooksPath = codexHooksPath();
    const toml = [
      'model = "gpt-x"',
      `[hooks.state."${hooksPath}:post_tool_use:0:0"]`,
      'trusted_hash = "sha256:aaaa"',
      `[hooks.state."${hooksPath}:stop:0:0"]`,
      'trusted_hash = "sha256:bbbb"',
    ].join('\n');
    const pruned = pruneTrustKeys(toml, new Set([`${hooksPath}:post_tool_use:0:0`]));
    assert.match(pruned, /^model = "gpt-x"/m);
    assert.ok(!pruned.includes('post_tool_use'), 'named section removed');
    assert.ok(pruned.includes(`${hooksPath}:stop:0:0`), 'unnamed section kept');
    assert.equal(pruneTrustKeys(toml, new Set()), toml, 'no keys, no change');
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

  it('is POSITION-STABLE: a Cairn-first layout keeps its indices (trust is pinned to them)', () => {
    const generated = codexHooks(RELAY);
    const existing: Partial<CodexHooksFile> = {
      hooks: {
        SessionStart: [
          { hooks: [{ type: 'command', command: '/old-install/dist/src/hooks/hook-relay --client codex session-start' }] },
          { hooks: [{ type: 'command', command: '/usr/local/bin/my-own-hook' }] },
        ],
      },
    };
    const merged = mergeCodexHooks(existing, generated);
    assert.ok(merged.hooks.SessionStart[0].hooks[0].command.startsWith(RELAY), 'Cairn stays at index 0');
    assert.equal(merged.hooks.SessionStart[1].hooks[0].command, '/usr/local/bin/my-own-hook', 'foreign stays at index 1');
  });

  it('keeps foreign handlers of a mixed group instead of deleting the group', () => {
    const generated = codexHooks(RELAY);
    const existing: Partial<CodexHooksFile> = {
      hooks: {
        Stop: [{
          hooks: [
            { type: 'command', command: '/usr/local/bin/my-stop-hook' },
            { type: 'command', command: '/old-install/dist/src/hooks/hook-relay --client codex stop' },
          ],
        }],
      },
    };
    const merged = mergeCodexHooks(existing, generated);
    assert.equal(merged.hooks.Stop[0].hooks.length, 1, 'Cairn handler stripped from the mixed group');
    assert.equal(merged.hooks.Stop[0].hooks[0].command, '/usr/local/bin/my-stop-hook', 'foreign handler survives');
    assert.ok(merged.hooks.Stop[1].hooks[0].command.startsWith(RELAY), 'fresh Cairn group appended');
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

});

describe('runCodexInit (hermetic end to end)', () => {
  it('writes hooks.json, appends MCP, and repeat runs are byte-identical', () => {
    mkdirSync(codexDir(), { recursive: true });
    writeFileSync(codexConfigPath(), 'model = "gpt-x"'); // note: no trailing newline
    runCodexInit(RELAY, `${INSTALL}/dist/src/mcp/server.js`, false);

    const written1 = readFileSync(codexHooksPath(), 'utf-8');
    assert.equal(codexHookCount(JSON.parse(written1) as CodexHooksFile), 10);
    const config = readFileSync(codexConfigPath(), 'utf-8');
    assert.match(config, /^model = "gpt-x"/m, 'existing config preserved');
    assert.equal(hasCairnMcpServer(config), true, 'MCP appended');

    // Byte-identical re-run: THE property that preserves hook trust.
    runCodexInit(RELAY, `${INSTALL}/dist/src/mcp/server.js`, false);
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

    // Explicit migration: canonical route written; ONLY the changed
    // hook's trust is pruned — the other nine keep theirs (scoped prune).
    runCodexInit(RELAY, '/srv/server.js', false, true);
    const migrated = readFileSync(codexHooksPath(), 'utf-8');
    assert.match(migrated, / post-tool"/, 'canonical route written');
    assert.ok(!migrated.includes(LEGACY_POST_TOOL_ROUTE), 'deprecated route gone');
    const configAfter = readFileSync(codexConfigPath(), 'utf-8');
    assert.equal(countTrustedHooksIn(configAfter, codexHooksPath()).trusted, 9, 'only the migrated hook re-reviews');
    assert.ok(!configAfter.includes(':post_tool_use:'), 'the invalidated entry is gone');
  });

  it('--migrate-routes NEVER prunes an enabled=false entry — a disable is a user decision', () => {
    mkdirSync(codexDir(), { recursive: true });
    const legacy = codexHooks(RELAY, LEGACY_POST_TOOL_ROUTE);
    writeFileSync(codexHooksPath(), `${JSON.stringify(legacy, null, 2)}\n`);
    // All trusted, except the PostToolUse hook is deliberately DISABLED.
    const config = trustAll(codexHooksPath(), legacy)
      .replace(`[hooks.state."${codexHooksPath()}:post_tool_use:0:0"]`,
        `[hooks.state."${codexHooksPath()}:post_tool_use:0:0"]\nenabled = false`);
    writeFileSync(codexConfigPath(), config);

    runCodexInit(RELAY, '/srv/server.js', false, true);
    const after = readFileSync(codexConfigPath(), 'utf-8');
    assert.ok(after.includes(`:post_tool_use:0:0`), 'disabled entry survives the migration');
    assert.match(after, /enabled = false/, 'the disable record is intact');
    const counts = countTrustedHooksIn(after, codexHooksPath());
    assert.equal(counts.disabled, 1, 'still reported disabled — an approve-all cannot silently re-enable it');
    assert.equal(counts.trusted, 9, 'the other nine keep their trust');
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

describe('doctor stale-install detection (step-6 review)', () => {
  it('warns when the wired install dir no longer exists', () => {
    mkdirSync(codexDir(), { recursive: true });
    writeFileSync(codexHooksPath(), JSON.stringify({
      description: 'x',
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: '/gone-xyz/dist/src/hooks/hook-relay --client codex session-start', timeout: 10 }] }] },
    }));
    const r = checkCodexParity();
    assert.equal(r.status, 'warn');
    assert.match(r.detail, /moved or removed install/);
  });

  it('warns when the wired dir EXISTS but is a different install than the one running doctor', () => {
    // The stale-nvm-tree shape: the old package dir survives the
    // switch, so hooks keep running outdated code while an
    // existence-only check reports healthy (review).
    const other = mkdtempSync(join(tmpdir(), 'cairn-other-install-'));
    mkdirSync(join(other, 'dist', 'src', 'hooks'), { recursive: true });
    writeFileSync(join(other, 'dist', 'src', 'hooks', 'hook-relay.sh'), '#!/bin/sh\n');
    mkdirSync(codexDir(), { recursive: true });
    writeFileSync(codexHooksPath(), JSON.stringify({
      description: 'x',
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `${other}/dist/src/hooks/hook-relay --client codex session-start`, timeout: 10 }] }] },
    }));
    const r = checkCodexParity();
    assert.equal(r.status, 'warn');
    assert.match(r.detail, /DIFFERENT install/);
    rmSync(other, { recursive: true, force: true });
  });

  it('a foreign command merely containing dist/src/hooks/ cannot false-positive', () => {
    mkdirSync(codexDir(), { recursive: true });
    writeFileSync(codexHooksPath(), JSON.stringify({
      description: 'x',
      hooks: { SessionStart: [
        { hooks: [{ type: 'command', command: 'node /gone-app/dist/src/hooks/custom.js', timeout: 10 }] },
        { hooks: [{ type: 'command', command: `${RELAY} --client codex session-start`, timeout: 10 }] },
      ] },
    }));
    const r = checkCodexParity();
    // The foreign /gone-app path is NOT hook-relay-anchored, so the
    // stale check ignores it; the real wiring is healthy (review).
    assert.ok(!/moved or removed/.test(r.detail), r.detail);
  });
});
