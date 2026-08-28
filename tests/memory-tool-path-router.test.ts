/**
 * Memory-tool path router (W4 slice 1) — pure routing/validation contract:
 * canonical base64url project encoding, §8 path normalization + attack
 * corpus, exact scope/category classification, free-form vs materialized
 * routing, read-only plan.md, and the canonical-ownership inverse.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CATEGORY_KINDS, MEMORY_ROOT,
  canonicalPathFor, decodeProjectSegment, encodeProjectSegment,
  normalizeMemoryPath, routeMemoryPath,
} from '../src/memory-tool/path-router.js';

describe('project segment encoding — canonical base64url', () => {
  it('round-trips simple, hostile, and unicode project names', () => {
    for (const name of [
      'cairn-2f161aa3', 'global', '../x', '..\\..\\etc', 'p-injection',
      'with spaces', 'ünïcödé-☂', '%2e%2e%2f', 'a/b/c', '.',
    ]) {
      const seg = encodeProjectSegment(name);
      assert.equal(decodeProjectSegment(seg), name, `round-trip: ${JSON.stringify(name)}`);
      assert.match(seg, /^p-[A-Za-z0-9_-]+$/, `encoded segment is path-safe: ${seg}`);
      assert.ok(!seg.includes('.') && !seg.includes('/') && !seg.includes('%'),
        'no dots, slashes, or percents — traversal layer accepts every encoding');
    }
  });

  it('the reserved global segment is structurally uncollidable', () => {
    assert.notEqual(encodeProjectSegment('global'), 'global');
    assert.match(encodeProjectSegment('global'), /^p-/);
  });

  it('rejects non-canonical segments (they must never claim ownership)', () => {
    assert.equal(decodeProjectSegment('global'), null, 'no p- prefix');
    assert.equal(decodeProjectSegment('p-a+b'), null, 'base64 (not url) alphabet');
    assert.equal(decodeProjectSegment('p-YQ=='), null, 'padding is non-canonical');
    // 'YR' carries nonzero trailing bits: it decodes to the same byte as
    // 'YQ' but does not re-encode to itself — non-canonical, rejected.
    assert.equal(decodeProjectSegment('p-YR'), null, 'nonzero trailing bits are non-canonical');
    const canonical = encodeProjectSegment('a');
    assert.equal(decodeProjectSegment(canonical), 'a');
    assert.equal(decodeProjectSegment('p-YWE=A'), null, 'alphabet violation');
  });

  it('the empty project name round-trips: p- is its canonical encoding', () => {
    assert.equal(encodeProjectSegment(''), 'p-');
    assert.equal(decodeProjectSegment('p-'), '', 'bare prefix decodes to the empty project');
    const path = canonicalPathFor('fact', '');
    assert.equal(path, '/memories/p-/facts.md');
    assert.deepEqual(routeMemoryPath(path!),
      { type: 'materialized', project: '', category: 'facts', readOnly: false },
      'empty-project ownership inverse routes back to its own materialized file');
  });
});

describe('normalizeMemoryPath — §8 rules and attack corpus', () => {
  it('normalizes benign paths', () => {
    assert.equal(normalizeMemoryPath('/memories'), '/memories');
    assert.equal(normalizeMemoryPath('/memories//notes.md'), '/memories/notes.md');
    assert.equal(normalizeMemoryPath('/memories/./a/notes.md'), '/memories/a/notes.md');
    assert.equal(normalizeMemoryPath('/memories/a/'), '/memories/a');
  });

  it('rejects the attack corpus', () => {
    const attacks = [
      '/memories/../../etc/passwd',
      '/memories/a/../../secrets.env',
      '/memories/..',
      '/memories/..\\..\\x',
      '/memories/%2e%2e%2fescape',
      '/memories/%2E%2E%2Fescape',
      '/memories/%252e%252e%252fescape',
      '/memories/a%2fb',
      '/memories/a\\b',
      '/memories/nul' + String.fromCharCode(0) + 'byte',
      '/memories/ctrl' + String.fromCharCode(7) + 'bell',
      '/memoriesX/file.md',
      '/Memories/file.md',
      '/etc/passwd',
      'memories/relative.md',
      '',
      '/memories/' + 'a'.repeat(1030),
    ];
    for (const attack of attacks) {
      assert.throws(() => normalizeMemoryPath(attack),
        /memory paths must stay within \/memories/,
        `must reject: ${JSON.stringify(attack.slice(0, 60))}`);
    }
  });

  it('rejects traversal at EVERY encoding depth — exhausted budget fails closed', () => {
    // levels=1 → %2e%2e%2f; each extra level wraps the % as %25
    const multiEncodedDotDotSlash = (levels: number): string => {
      const pct = '%' + '25'.repeat(levels - 1);
      return `${pct}2e${pct}2e${pct}2f`;
    };
    for (let levels = 1; levels <= 6; levels++) {
      const attack = `/memories/${multiEncodedDotDotSlash(levels)}escape`;
      assert.throws(() => normalizeMemoryPath(attack),
        /memory paths must stay within \/memories/,
        `must reject traversal encoded ${levels}x`);
    }
    // Unevenly encoded components: raw dots + deeply encoded slash
    const unevenSlash = '%' + '25'.repeat(4) + '2f';
    assert.throws(() => normalizeMemoryPath(`/memories/..${unevenSlash}escape`),
      /memory paths must stay within \/memories/,
      'uneven raw-dots + level-5 slash must reject');
    // Deeply encoded backslash alone
    const unevenBackslash = '%' + '25'.repeat(5) + '5c';
    assert.throws(() => normalizeMemoryPath(`/memories/a${unevenBackslash}b`),
      /memory paths must stay within \/memories/,
      'level-6 backslash must reject');
  });

  it('accepts harmless percent-encoded and dot-bearing names (detection is not overbroad)', () => {
    for (const benign of [
      '/memories/release%2enotes.md',
      '/memories/discount%25.md',
      '/memories/deep%2525.md',
      '/memories/file%20name.md',
      '/memories/notes..md',
      '/memories/v1.2.3-changelog.md',
    ]) {
      assert.doesNotThrow(() => normalizeMemoryPath(benign), `must accept: ${benign}`);
      assert.equal(routeMemoryPath(benign).type, 'free-form', `${benign} routes free-form`);
    }
  });

  it('error message carries the documented text without an Error: prefix', () => {
    try {
      normalizeMemoryPath('/etc/passwd');
      assert.fail('should have thrown');
    } catch (err) {
      assert.ok(!(err as Error).message.startsWith('Error:'),
        'the SDK wrapper owns prefixing (§9)');
      assert.match((err as Error).message, /^invalid path /);
    }
  });
});

describe('routeMemoryPath — scope and category classification', () => {
  const P = encodeProjectSegment('proj-x');

  it('routes root and directories', () => {
    assert.deepEqual(routeMemoryPath('/memories'), { type: 'root' });
    assert.deepEqual(routeMemoryPath('/memories/global'), { type: 'directory', project: null });
    assert.deepEqual(routeMemoryPath(`/memories/${P}`), { type: 'directory', project: 'proj-x' });
  });

  it('routes every materialized category with exact scope', () => {
    for (const category of ['pitfalls', 'decisions', 'facts', 'corrections', 'references', 'patterns'] as const) {
      assert.deepEqual(routeMemoryPath(`/memories/global/${category}.md`),
        { type: 'materialized', project: null, category, readOnly: false });
      assert.deepEqual(routeMemoryPath(`/memories/${P}/${category}.md`),
        { type: 'materialized', project: 'proj-x', category, readOnly: false });
    }
  });

  it('plan.md is materialized and READ-ONLY in both scopes', () => {
    assert.deepEqual(routeMemoryPath('/memories/global/plan.md'),
      { type: 'materialized', project: null, category: 'plan', readOnly: true });
    assert.deepEqual(routeMemoryPath(`/memories/${P}/plan.md`),
      { type: 'materialized', project: 'proj-x', category: 'plan', readOnly: true });
  });

  it('user-profile is global-only: the project variant routes free-form', () => {
    assert.deepEqual(routeMemoryPath('/memories/global/user-profile.md'),
      { type: 'materialized', project: null, category: 'user-profile', readOnly: false });
    assert.deepEqual(routeMemoryPath(`/memories/${P}/user-profile.md`),
      { type: 'free-form', path: `/memories/${P}/user-profile.md` });
  });

  it('non-canonical p- segments and non-category files route free-form', () => {
    assert.equal(routeMemoryPath('/memories/p-YQ==x/pitfalls.md').type, 'free-form');
    assert.equal(routeMemoryPath('/memories/global/pitfalls.txt').type, 'free-form');
    assert.equal(routeMemoryPath('/memories/global/unknown.md').type, 'free-form');
    assert.equal(routeMemoryPath('/memories/notes.md').type, 'free-form');
    assert.equal(routeMemoryPath(`/memories/${P}/deep/nested.md`).type, 'free-form');
    assert.equal(routeMemoryPath('/memories/plain-directory-name').type, 'free-form');
  });

  it('free-form routes carry the NORMALIZED path', () => {
    assert.deepEqual(routeMemoryPath('/memories//scratch/./notes.md'),
      { type: 'free-form', path: '/memories/scratch/notes.md' });
  });
});

describe('canonicalPathFor — the ownership inverse', () => {
  it('maps every kind to exactly one canonical file (task_state to none)', () => {
    assert.equal(canonicalPathFor('pitfall', 'proj-x'), `${MEMORY_ROOT}/${encodeProjectSegment('proj-x')}/pitfalls.md`);
    assert.equal(canonicalPathFor('pitfall', null), `${MEMORY_ROOT}/global/pitfalls.md`);
    assert.equal(canonicalPathFor('goal', 'proj-x'), `${MEMORY_ROOT}/${encodeProjectSegment('proj-x')}/patterns.md`);
    assert.equal(canonicalPathFor('user_profile', 'ignored-project'), `${MEMORY_ROOT}/global/user-profile.md`,
      'user_profile is ALWAYS global regardless of the project argument');
    assert.equal(canonicalPathFor('task_state', 'proj-x'), null, 'ephemeral kind is unmapped');
  });

  it('canonical paths route back to their own materialized category (round-trip)', () => {
    for (const [category, kinds] of Object.entries(CATEGORY_KINDS)) {
      for (const kind of kinds) {
        const path = canonicalPathFor(kind, 'proj-x');
        if (path === null) continue;
        const routed = routeMemoryPath(path);
        assert.equal(routed.type, 'materialized', `${kind} canonical path is materialized`);
        if (routed.type === 'materialized') {
          assert.equal(routed.category, category, `${kind} routes to ${category}`);
        }
      }
    }
  });
});
