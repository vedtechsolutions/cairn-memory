/**
 * Contract drift guards (Phase 1 step 2): the contract package's claims
 * must match reality in every separately shipped artifact — the daemon's
 * route table, the shell relay's classification lists, and the C relay's
 * duplicated literals (it cannot import TypeScript).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SYNC_ROUTES, ASYNC_ROUTES, STANDALONE_HOOKS,
  CLIENT_HEADER, CLIENT_ENV_VAR,
} from '@cairn/contract';
import { SERVED_HOOK_ROUTES } from '../src/mcp/hook-socket.js';

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
