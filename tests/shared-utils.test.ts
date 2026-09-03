/**
 * The shared utilities that replaced duplicated helpers (audit): one
 * truncation, one Jaccard, one shell quoting, one plain-object guard, one
 * canonical path, one slug. Each pins the exact behavior the copies had.
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { ELLIPSIS } from '../src/constants/budgets.js';
import { LIMITS } from '../src/constants/limits.js';
import { truncate, truncateAscii } from '../src/utils/text.js';
import { jaccardOverlap } from '../src/utils/similarity.js';
import { shellQuote } from '../src/utils/shell.js';
import { isPlainObject } from '../src/utils/plain-object.js';
import { canonicalPath } from '../src/utils/fs-paths.js';
import { slugOf, slugTag } from '../src/importers/shared.js';

describe('truncate', () => {
  it('never exceeds maxChars; the ellipsis counts toward it; short text is untouched', () => {
    assert.equal(truncate('abcdef', 4), `abc${ELLIPSIS.UNICODE}`);
    assert.equal(truncate('abcd', 4), 'abcd');
    assert.equal(truncateAscii('abcdefgh', 6), `abc${ELLIPSIS.ASCII}`);
    assert.equal(truncateAscii('abcdef', 6), 'abcdef');
    // The exact arithmetic of the former copies: slice(0, max-1)+'…' and slice(0, max-3)+'...'.
    const long = 'x'.repeat(300);
    assert.equal(truncate(long, 200), 'x'.repeat(199) + ELLIPSIS.UNICODE);
    assert.equal(truncateAscii(long, 200), 'x'.repeat(197) + ELLIPSIS.ASCII);
    assert.equal(truncate('abc', 0, '...'), '...', 'a budget below the ellipsis yields the ellipsis alone, never a negative slice');
  });
});

describe('jaccardOverlap', () => {
  it('is |A∩B|/|A∪B| over sets or arrays, 0 when either side is empty', () => {
    assert.equal(jaccardOverlap(new Set(['a', 'b']), new Set(['b', 'c'])), 1 / 3);
    assert.equal(jaccardOverlap(['a', 'a', 'b'], ['b']), 0.5, 'arrays are de-duplicated');
    assert.equal(jaccardOverlap([], ['a']), 0);
    assert.equal(jaccardOverlap(new Set(['a']), new Set()), 0);
    assert.equal(jaccardOverlap(['a'], ['a']), 1);
  });
});

describe('shellQuote', () => {
  it('passes safe arguments through and single-quotes the rest, escaping embedded quotes', () => {
    assert.equal(shellQuote('/opt/x/y.js'), '/opt/x/y.js');
    assert.equal(shellQuote('a b'), "'a b'");
    assert.equal(shellQuote("o'brien"), "'o'\\''brien'");
    assert.equal(shellQuote('{"k":"v"}'), `'{"k":"v"}'`);
  });
});

describe('isPlainObject', () => {
  it('accepts objects, rejects null, arrays and primitives', () => {
    assert.equal(isPlainObject({}), true);
    assert.equal(isPlainObject({ a: 1 }), true);
    assert.equal(isPlainObject(null), false);
    assert.equal(isPlainObject([]), false);
    assert.equal(isPlainObject('x'), false);
    assert.equal(isPlainObject(undefined), false);
  });
});

describe('canonicalPath', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs.length = 0; });
  it('resolves an existing symlink to its target and a missing path lexically', () => {
    const d = mkdtempSync(join(tmpdir(), 'waykeep-canon-'));
    dirs.push(d);
    writeFileSync(join(d, 'real'), '');
    symlinkSync(join(d, 'real'), join(d, 'link'));
    assert.equal(canonicalPath(join(d, 'link')), canonicalPath(join(d, 'real')));
    assert.equal(canonicalPath(join(d, 'missing', '..', 'nope')), resolve(join(d, 'nope')));
  });
});

describe('slugOf / slugTag', () => {
  it('lower-cases, collapses runs of non-alphanumerics, trims edge dashes, caps the length', () => {
    assert.equal(slugOf('Hello, World!'), 'hello-world');
    assert.equal(slugOf('  --x--  '), 'x');
    assert.equal(slugOf('!!!'), '', 'nothing survives → empty, so callers can skip the tag');
    assert.equal(slugOf('a'.repeat(100)).length, LIMITS.SLUG_MAX_CHARS);
    assert.equal(slugOf('a'.repeat(LIMITS.SLUG_MAX_CHARS - 1) + ' b'), 'a'.repeat(LIMITS.SLUG_MAX_CHARS - 1), 'a slug cut at the cap never ends in a dash');
    assert.equal(slugTag('type', 'Bug Fix'), 'type:bug-fix');
  });
});
