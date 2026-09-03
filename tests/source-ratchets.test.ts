/**
 * Source-hygiene ratchets: no file may grow its count of un-named numeric
 * literals past the pinned baseline, no new file may carry any, and no file
 * may grow past the line limit or join the oversized list. The baselines
 * are re-pinned only downward (`scripts/source-ratchets.mjs --write`).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SOURCE_HYGIENE } from '../src/constants/limits.js';
import { countNumericLiterals, numericLiteralCounts, oversizedFiles, ratchetedSourceFiles, stripStringBodies } from '../src/utils/source-ratchets.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const baseline = (name: string): Record<string, number> =>
  JSON.parse(readFileSync(join(REPO, 'tests', 'fixtures', name), 'utf-8')) as Record<string, number>;
const RE_PIN = 'lower it by naming the values in src/constants/, then re-pin with: node scripts/source-ratchets.mjs --write';

describe('numeric-literal counter', () => {
  it('counts code numbers only — not comments, not string bodies, not the trivial set', () => {
    const code = [
      "const a = 30_000; // 99 in a comment",
      "const b = 'port 8080' + `${x} of 500 items`;",
      "/* 4096 */ const c = [0, 1, 2, 3.5, 0.75];",
      "if (n > 100) retry(7);",
    ].join('\n');
    // 30_000, 3.5, 0.75, 100, 7 → 5 (0/1/2 trivial; 99/8080/500/4096 are prose)
    assert.equal(countNumericLiterals(code), 5);
  });

  it('knows every literal form: hex, octal, binary, exponent, leading dot', () => {
    // A guard that only saw \d+ let these through (Codex review).
    assert.equal(countNumericLiterals('a = 0xFF; b = 0o755; c = 0b1010; d = 2e2; e = 1e-1; f = .75; g = 1_000.5e3;'), 7);
    assert.equal(countNumericLiterals('a = 0x0; b = 0o1; c = 2.0; d = 1e0;'), 0, 'forms that evaluate to 0/1/2 are trivial');
    // Empty fractions, exponent after a dot, separators in exponents, BigInt (Codex review).
    assert.equal(countNumericLiterals('a = 3.; b = .5e2; c = 3.e2; d = 3e1_0; e = 3n; f = 0xFFn; g = 1n;'), 6);
    assert.equal(countNumericLiterals('x.5; a1; (1).toFixed(2); 1.toFixed'), 0, 'digits glued to identifiers or dots are not literals');
  });

  it('strips comments inside template interpolations (stripComments treats the whole template as a string)', () => {
    assert.equal(countNumericLiterals('const s = `${/* 99 */ 3}`;'), 1);
    assert.equal(countNumericLiterals("const s = `${/* ' */ 42} and ${7 // 55\n}`;"), 2, 'a quote inside such a comment must not open string mode');
  });

  it('counts numbers inside template interpolations but not template prose', () => {
    assert.equal(countNumericLiterals('const s = `retry in ${30_000 * scale} ms after 500 tries`;'), 1);
    assert.equal(countNumericLiterals('const s = `${a ? `inner ${42}` : 7} of 99`;'), 2, 'nested templates and braces');
    assert.equal(stripStringBodies('`x ${y} z`'), '`  ${y}  `');
  });

  it('a quote inside a regex literal cannot hide the rest of the file (planted positive after it)', () => {
    // The stripper does not lex regex literals; a newline closes the string
    // state it wrongly opened, so the planted 4242 on the next line is seen.
    const code = "const re = /don'?t/;\nconst A_MS = 4242;\nconst s = 'x';\nconst b = 99;";
    assert.equal(countNumericLiterals(code), 2);
    assert.equal(stripStringBodies("x = 'a\\'b' + \"c\""), "x = '    ' + \" \"");
  });
});

describe('source ratchets', () => {
  it('scans a real corpus', () => {
    assert.ok(ratchetedSourceFiles(REPO).length > 200, 'vacuous-instrument guard');
  });

  it('no file grew its un-named numeric literals, and no new file has any', () => {
    const pinned = baseline('numeric-literal-baseline.json');
    assert.ok(Object.keys(pinned).length > 0, 'baseline present');
    const current = numericLiteralCounts(REPO);
    const grew = Object.entries(current).filter(([f, n]) => n > (pinned[f] ?? 0)).map(([f, n]) => `${f}: ${n} (baseline ${pinned[f] ?? 0})`);
    assert.deepEqual(grew, [], `these files gained un-named numeric literals — ${RE_PIN}:\n  ${grew.join('\n  ')}`);
  });

  it(`no file grew past its pinned length, and no new file exceeds ${SOURCE_HYGIENE.MAX_FILE_LINES} lines`, () => {
    const pinned = baseline('file-length-baseline.json');
    const current = oversizedFiles(REPO);
    const grew = Object.entries(current).filter(([f, n]) => n > (pinned[f] ?? SOURCE_HYGIENE.MAX_FILE_LINES)).map(([f, n]) => `${f}: ${n} lines (baseline ${pinned[f] ?? SOURCE_HYGIENE.MAX_FILE_LINES})`);
    assert.deepEqual(grew, [], `these files grew past the limit or their pinned size — split them, then re-pin with: node scripts/source-ratchets.mjs --write:\n  ${grew.join('\n  ')}`);
  });
});
