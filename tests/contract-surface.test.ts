/**
 * Contract drift guards (Phase 1 step 2): the contract package's claims
 * must match reality in every separately shipped artifact — the daemon's
 * route table, the shell relay's classification lists, and the C relay's
 * duplicated literals (it cannot import TypeScript).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SYNC_ROUTES, ASYNC_ROUTES, STANDALONE_HOOKS,
  CLIENT_HEADER, CLIENT_ENV_VAR,
} from '@cairn/contract';
import { SERVED_HOOK_ROUTES } from '../src/mcp/hook-socket.js';
import { cairnHooks } from '../src/cli/init.js';
import { codexHooks, LEGACY_POST_TOOL_ROUTE } from '../src/cli/codex-init.js';

// Compiled tests run from dist/tests — the repo root is two levels up
// (the shell-relay check would deceptively pass from one level, because
// the build COPIES hook-relay.sh into dist).
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('contract route classification matches the served table', () => {
  it('SYNC + ASYNC routes are exactly the daemon route table', () => {
    const contract = [...SYNC_ROUTES, ...ASYNC_ROUTES].sort();
    const served = [...SERVED_HOOK_ROUTES].sort();
    assert.deepEqual(contract, served,
      'contract routes must equal the served route table — update BOTH or neither');
  });

  it('no route appears in two classifications', () => {
    const all = [...SYNC_ROUTES, ...ASYNC_ROUTES, ...STANDALONE_HOOKS];
    assert.equal(new Set(all).size, all.length);
  });

  it('the shell relay agrees on sync and standalone', () => {
    const sh = readFileSync(join(REPO, 'src', 'hooks', 'hook-relay.sh'), 'utf-8');
    const syncLine = sh.match(/^SYNC_HOOKS="([^"]+)"/m)?.[1]?.split(/\s+/).sort();
    const standaloneLine = sh.match(/^STANDALONE_HOOKS="([^"]+)"/m)?.[1]?.split(/\s+/).sort();
    assert.deepEqual(syncLine, [...SYNC_ROUTES].sort(), 'hook-relay.sh SYNC_HOOKS drifted from the contract');
    assert.deepEqual(standaloneLine, [...STANDALONE_HOOKS].sort(), 'hook-relay.sh STANDALONE_HOOKS drifted from the contract');
  });
});

describe('C relay literals ⊇ contract constants', () => {
  it('carries the client header (case-insensitive — emitters may use any casing)', () => {
    const c = readFileSync(join(REPO, 'src', 'hooks', 'hook-relay.c'), 'utf-8').toLowerCase();
    assert.ok(c.includes(`${CLIENT_HEADER}: %s`), 'hook-relay.c must emit the contract client header');
    assert.ok(c.includes(CLIENT_ENV_VAR.toLowerCase()), 'hook-relay.c must set the contract client env var');
  });
});

describe('generated hook wiring targets real routes', () => {
  // A generator typo is a SILENT failure for async hooks (fire-and-forget
  // 404), so every subcommand a generator emits must exist in the contract.
  const KNOWN = new Set<string>([...SYNC_ROUTES, ...ASYNC_ROUTES, ...STANDALONE_HOOKS]);
  const RELAY = '/install/dist/src/hooks/hook-relay';

  const subcommandOf = (command: string): string => {
    const last = command.split(' ').at(-1) ?? '';
    // Node-form fallback entries name the hook by script path.
    return last.endsWith('.js') ? (last.split('/').at(-1) ?? '').replace(/\.js$/, '') : last;
  };

  const allCommands = (hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>): string[] =>
    Object.values(hooks).flatMap((groups) => groups.flatMap((g) => g.hooks.map((h) => h.command)));

  it('every Claude generator subcommand is a contract route or standalone hook', () => {
    for (const command of allCommands(cairnHooks(RELAY))) {
      assert.ok(KNOWN.has(subcommandOf(command)), `unknown hook target in: ${command}`);
    }
  });

  it('every Codex generator subcommand is a contract route or standalone hook — both route generations', () => {
    for (const file of [codexHooks(RELAY), codexHooks(RELAY, LEGACY_POST_TOOL_ROUTE)]) {
      for (const command of allCommands(file.hooks)) {
        assert.ok(KNOWN.has(subcommandOf(command)), `unknown hook target in: ${command}`);
      }
    }
  });

  it('generated async flags match the contract classification — both generators', () => {
    // The routes module's central claim: whether a hook WAITS is part of
    // the contract. A sync route wired async loses its injected context;
    // an async route wired sync blocks the agent's turn.
    const asyncSet = new Set<string>(ASYNC_ROUTES);
    const syncish = new Set<string>([...SYNC_ROUTES, ...STANDALONE_HOOKS]);
    const check = (hooks: Record<string, Array<{ hooks: Array<{ command: string; async?: boolean }> }>>): void => {
      for (const groups of Object.values(hooks)) {
        for (const g of groups) {
          for (const h of g.hooks) {
            const sub = subcommandOf(h.command);
            if (asyncSet.has(sub)) {
              assert.equal(h.async, true, `async route wired without async: ${h.command}`);
            } else if (syncish.has(sub)) {
              assert.notEqual(h.async, true, `sync/standalone route wired async: ${h.command}`);
            }
          }
        }
      }
    };
    check(cairnHooks(RELAY));
    check(codexHooks(RELAY).hooks);
    check(codexHooks(RELAY, LEGACY_POST_TOOL_ROUTE).hooks);
  });

  it('both post-tool generations have a standalone fallback entry in dist (relay socket-miss path)', () => {
    // Old wiring / new package and new wiring / new package must both
    // survive a daemon outage: the relay execs dist/src/hooks/<sub>.js.
    for (const name of ['post-tool', LEGACY_POST_TOOL_ROUTE]) {
      assert.ok(existsSync(join(REPO, 'dist', 'src', 'hooks', `${name}.js`)),
        `dist fallback entry missing for ${name} — old/new wiring would silently lose capture on socket miss`);
    }
  });
});

describe('contract package hygiene', () => {
  it('is zero-dependency and MIT (pending user publish gate)', () => {
    const pkg = JSON.parse(readFileSync(join(REPO, 'packages', 'contract', 'package.json'), 'utf-8')) as {
      dependencies?: Record<string, string>; peerDependencies?: Record<string, string>; license?: string;
    };
    assert.equal(pkg.dependencies, undefined, 'contract must stay zero-dependency');
    assert.equal(pkg.peerDependencies, undefined);
    assert.equal(pkg.license, 'MIT');
  });
});
