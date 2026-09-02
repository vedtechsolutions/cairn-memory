/**
 * Scanner-validation harness (remediation plan, step 8 — the incident's
 * actual remedy).
 *
 * "A search that cannot find known examples is an unvalidated instrument."
 * The incident investigation trusted ad hoc scans that returned false
 * nulls: one could not find a planted positive at all, one scanned a single
 * file when the violation spanned two (the relay handshake split between
 * generator and detectors). These gates prove, on the SHARED primitives the
 * structural audits use, that:
 *
 *   GATE 1 (known-positive): planted violations are found and located —
 *          including inside string literals that contain comment markers,
 *          and across MULTIPLE target values.
 *   GATE 2 (cross-file): a violation whose halves live in different files
 *          (distinct generator/detector values) is fully reported.
 *   GATE 3 (mutation): the SAME gate assertions are run against
 *          deliberately defective scanner variants — each variant fails at
 *          least one committed gate, so the gates are proven to
 *          discriminate, not merely to pass.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  listSourceFiles, stripComments, scanForInlineValues, scanForTokens, type ScanHit,
} from '../src/utils/structural-scan.js';

let dir: string;
let files: string[];

/** Distinct generator/detector halves — the incident's cross-file shape. */
const GEN_VALUE = '--plantedns-probe';
const DET_VALUE = 'plantedns-probe-ack';
const PLANTED_VALUE = '/home/user/.plantedns/plantedns.db';
const PLANTED_ENV = 'PLANTEDNS_DB_PATH';

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'scanner-validation-'));
  mkdirSync(join(dir, 'nested'));
  // a.ts — an OWNED env token accessed through an ALIAS (the shape
  // prefix-anchored scanners miss), plus an owned name inside a string that
  // CONTAINS comment markers (the regex-stripper false-null shape).
  writeFileSync(join(dir, 'a.ts'), [
    "const e = process.env;",
    `const dbPath = e.${PLANTED_ENV} ?? 'fallback';`,
    "// comment mentioning /home/user/.plantedns/plantedns.db must NOT hit",
    `const msg = 'see // ${PLANTED_ENV} and /* ${PLANTED_VALUE} */ for details';`,
    "export default dbPath;",
  ].join('\n'));
  // nested/b.ts — the inline value violation TWICE (all occurrences must
  // report), in a file a first-file-only scan never reaches.
  writeFileSync(join(dir, 'nested', 'b.ts'), [
    "export function open() {",
    `  return connect('${PLANTED_VALUE}');`,
    "}",
    `export const FALLBACK = '${PLANTED_VALUE}';`,
  ].join('\n'));
  // c.ts — entirely clean (no false positives allowed).
  writeFileSync(join(dir, 'c.ts'),
    "export const CLEAN_CONSTANT = 42; // PLANTEDNS_UNRELATED_MARKER is not owned\n");
  // generator.ts / detector.ts — DISTINCT halves of one handshake.
  writeFileSync(join(dir, 'generator.ts'), `export const FLAG = '${GEN_VALUE}';\n`);
  writeFileSync(join(dir, 'nested', 'detector.ts'), `export const ACK = '${DET_VALUE}';\n`);
  files = listSourceFiles(dir);
});

after(() => rmSync(dir, { recursive: true, force: true }));

type ValueScanner = typeof scanForInlineValues;
type TokenScanner = typeof scanForTokens;

/**
 * THE committed gate assertions — run identically against the real scanner
 * and every mutant, so a mutant's failure proves the gate discriminates.
 */
function gate1KnownPositives(scanValues: ValueScanner, scanTokens: TokenScanner): string | null {
  const vhits = scanValues(files, [PLANTED_VALUE, GEN_VALUE]);
  const inB = vhits.filter(h => h.file.endsWith('b.ts') && h.value === PLANTED_VALUE);
  if (inB.length !== 2) return `expected BOTH b.ts occurrences, got ${inB.length}`;
  if (!vhits.some(h => h.file.endsWith('a.ts') && h.value === PLANTED_VALUE)) {
    return 'missed the value inside a comment-marker-bearing string literal (regex-stripper false null)';
  }
  if (!vhits.some(h => h.file.endsWith('generator.ts') && h.value === GEN_VALUE)) {
    return 'missed the SECOND target value (first-target-only defect)';
  }
  if (vhits.some(h => h.file.endsWith('c.ts'))) return 'false positive on the clean file';
  if (vhits.some(h => h.file.endsWith('a.ts') && h.line === 3)) {
    return 'the comment mention on line 3 must not hit';
  }
  const thits = scanTokens(files, new Set([PLANTED_ENV]));
  if (!thits.some(h => h.file.endsWith('a.ts') && h.line === 2)) {
    return 'missed the aliased env access (prefix-anchored defect)';
  }
  return null;
}

function gate2CrossFile(scanValues: ValueScanner): string | null {
  const hits = scanValues(files, [GEN_VALUE, DET_VALUE]);
  const genOk = hits.some(h => h.file.endsWith('generator.ts') && h.value === GEN_VALUE);
  const detOk = hits.some(h => h.file.endsWith('detector.ts') && h.value === DET_VALUE);
  if (!genOk || !detOk) {
    return `handshake halves live in different files — got generator:${genOk} detector:${detOk}`;
  }
  if (!files.some(f => f.includes('nested'))) return 'listSourceFiles failed to recurse';
  return null;
}

describe('GATE 1 — known positives (real scanner passes)', () => {
  it('finds every planted violation: all occurrences, all values, strings-with-comment-markers, aliased tokens', () => {
    assert.equal(gate1KnownPositives(scanForInlineValues, scanForTokens), null);
  });
});

describe('GATE 2 — cross-file (real scanner passes)', () => {
  it('reports BOTH halves of a handshake split across files', () => {
    assert.equal(gate2CrossFile(scanForInlineValues), null);
  });
});

describe('GATE 3 — every defective variant FAILS a committed gate (mutation power)', () => {
  const rd = (f: string) => readFileSync(f, 'utf-8');

  const MUTANTS: Array<{ name: string; scanValues?: ValueScanner; scanTokens?: TokenScanner; failsGate: 1 | 2 }> = [
    {
      name: 'regex comment-stripper that eats string content (the incident false-null)',
      scanValues: (fs, vs) => scanForInlineValues(fs, vs, (f) =>
        rd(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1')),
      failsGate: 1,
    },
    {
      name: 'first-file-only scanner',
      scanValues: (fs, vs, r) => scanForInlineValues(fs.slice(0, 1), vs, r),
      failsGate: 2,
    },
    {
      name: 'first-target-only scanner',
      scanValues: (fs, vs, r) => scanForInlineValues(fs, vs.slice(0, 1), r),
      failsGate: 2,
    },
    {
      name: 'first-occurrence-only scanner',
      scanValues: (fs, vs, r) => {
        const seen = new Set<string>();
        return scanForInlineValues(fs, vs, r).filter(h => {
          const k = `${h.file}|${h.value}`;
          if (seen.has(k)) return false;
          seen.add(k); return true;
        });
      },
      failsGate: 1,
    },
    {
      name: 'non-recursive lister',
      scanValues: (fs, vs, r) => scanForInlineValues(fs.filter(f => !f.includes('nested')), vs, r),
      failsGate: 2,
    },
    {
      name: 'prefix-anchored token scanner (misses aliased access)',
      scanTokens: (fs, set) => scanForTokens(fs, set, /(?<=process\.env\.)[A-Z][A-Z0-9_]{2,}/g),
      failsGate: 1,
    },
    {
      name: 'empty-target scanner (vacuous instrument)',
      scanValues: (fs, _vs, r) => scanForInlineValues(fs, [], r),
      failsGate: 1,
    },
  ];

  for (const m of MUTANTS) {
    it(`${m.name} fails GATE ${m.failsGate}`, () => {
      const sv = m.scanValues ?? scanForInlineValues;
      const st = m.scanTokens ?? scanForTokens;
      const failure = m.failsGate === 1 ? gate1KnownPositives(sv, st) : gate2CrossFile(sv);
      assert.ok(failure !== null,
        'the mutant must fail the committed gate — a gate that cannot catch it is decorative');
    });
  }
});

describe('primitives — behavior the audits rely on', () => {
  it('stripComments preserves line numbers across block comments', () => {
    const text = 'a\n/* two\nlines */\nconst x = 1;';
    assert.equal(stripComments(text).split('\n').length, text.split('\n').length);
  });

  it("keeps 'https://' inside string literals while removing trailing comments", () => {
    const stripped = stripComments("const u = 'https://example.com'; // note");
    assert.ok(stripped.includes('https://example.com'));
    assert.ok(!stripped.includes('note'));
  });

  it('keeps comment-marker sequences INSIDE strings (the false-null fix)', () => {
    const stripped = stripComments(`const m = 'see // KEEP and /* ALSO */ end';`);
    assert.ok(stripped.includes('// KEEP'));
    assert.ok(stripped.includes('/* ALSO */'));
  });

  it('template literals are preserved whole', () => {
    const stripped = stripComments('const t = `a // b /* c */ d`; // gone');
    assert.ok(stripped.includes('a // b /* c */ d'));
    assert.ok(!stripped.includes('gone'));
  });

  it('scan output is deterministic: files are listed sorted', () => {
    const twice = listSourceFiles(dir);
    assert.deepEqual(twice, [...twice].sort());
  });

  it('hits carry usable locations', () => {
    const hits: ScanHit[] = scanForInlineValues(files, [PLANTED_VALUE]);
    for (const h of hits) assert.ok(h.line >= 1 && h.file.length > 0);
  });
});
