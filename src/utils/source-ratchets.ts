/**
 * Source-hygiene ratchets: numeric literals outside src/constants/ and file
 * length. A baseline (tests/fixtures/*.json) records today's counts per file;
 * the test refuses any file that GROWS past its baseline or any new offender,
 * and `scripts/source-ratchets.mjs --write` re-pins the baseline after a
 * cleanup lowers it. Identity guards already exist for names; nothing
 * guarded tuning values or size until this (audit, 2026-09-02).
 */
import { readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { SOURCE_HYGIENE } from '../constants/limits.js';
import { listSourceFiles, stripComments } from './structural-scan.js';

type Mode = 'code' | 'single' | 'double' | 'template';

/**
 * Blank the BODIES of string literals (delimiters kept, so positions
 * survive), after comments are gone: a number inside a message is prose.
 * Template literals keep their `${…}` interpolations as CODE — a tuning
 * value in an interpolation is still a tuning value (Codex review) — so the
 * lexer tracks nesting: an interpolation may contain a nested template.
 * Comments INSIDE an interpolation are blanked here too: stripComments
 * treats a whole template as a string, so it never saw them (Codex review).
 * Regex literals are not lexed (the `/` division ambiguity needs a parser),
 * so a quote inside one — `/don'?t/` — would open string mode; a newline
 * closes single- and double-quoted modes, which confines that to one line
 * instead of the rest of the file (review).
 */
export function stripStringBodies(code: string): string {
  let out = '';
  // Enclosing contexts: entering `${` pushes the template and the brace depth
  // to return at; a nested template pushes again.
  const stack: Array<{ mode: Mode; depth: number }> = [];
  let mode: Mode = 'code';
  let depth = 0; // brace depth inside the current interpolation
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    const next = code[i + 1];
    if (mode === 'code') {
      if (c === '/' && next === '*') {
        const end = code.indexOf('*/', i + 2);
        const stop = end < 0 ? code.length : end + 2;
        out += code.slice(i, stop).replace(/[^\n]/g, ' ');
        i = stop - 1;
        continue;
      }
      if (c === '/' && next === '/') {
        const end = code.indexOf('\n', i);
        const stop = end < 0 ? code.length : end;
        out += ' '.repeat(stop - i);
        i = stop - 1;
        continue;
      }
      if (c === "'") mode = 'single';
      else if (c === '"') mode = 'double';
      else if (c === '`') mode = 'template';
      else if (c === '{') depth++;
      else if (c === '}') {
        if (depth === 0 && stack.length > 0) {
          const back = stack.pop()!;
          mode = back.mode;
          depth = back.depth;
          out += c;
          continue;
        }
        if (depth > 0) depth--;
      }
      out += c;
      continue;
    }
    if (c === '\\') { out += '  '; i++; continue; }
    if (c === '\n' && mode !== 'template') { mode = 'code'; out += c; continue; }
    if (mode === 'template' && c === '$' && next === '{') {
      stack.push({ mode, depth });
      mode = 'code';
      depth = 0;
      out += '${';
      i++;
      continue;
    }
    const closes = (mode === 'single' && c === "'") || (mode === 'double' && c === '"') || (mode === 'template' && c === '`');
    if (closes) { mode = 'code'; out += c; continue; }
    out += c === '\n' ? c : ' ';
  }
  return out;
}

/** Every JS numeric literal form: hex/octal/binary, decimals with an optional
 *  (possibly empty) fraction and exponent, leading-dot fractions, and the
 *  BigInt `n` suffix. A guard that only knew `\d+` let `0xFF`, `0o755`,
 *  `2e2`, `.75`, `3.` and `3n` through (Codex review). */
const NUMERIC_LITERAL = /(?<![\w.$])(?:0[xX][\da-fA-F_]+n?|0[oO][0-7_]+n?|0[bB][01_]+n?|\d[\d_]*(?:\.[\d_]*)?(?:[eE][+-]?[\d_]+)?n?|\.\d[\d_]*(?:[eE][+-]?[\d_]+)?)(?![\w.])/g;

/** Non-trivial numeric literals in a source text (comments and string bodies excluded). */
export function countNumericLiterals(code: string): number {
  const trivial = new Set<number>(SOURCE_HYGIENE.TRIVIAL_NUMERIC_LITERALS);
  const stripped = stripStringBodies(stripComments(code));
  let n = 0;
  for (const m of stripped.matchAll(NUMERIC_LITERAL)) {
    const value = Number(m[0].replace(/_/g, '').replace(/n$/, ''));
    if (!trivial.has(value)) n++;
  }
  return n;
}

/** Repo-relative POSIX path. */
const rel = (root: string, file: string): string => relative(root, file).split(sep).join('/');

/** src/ files the ratchets cover: everything but the constants directory. */
export function ratchetedSourceFiles(repoRoot: string): string[] {
  const src = join(repoRoot, 'src');
  const constants = join(src, 'constants') + sep;
  return listSourceFiles(src).filter(f => !f.startsWith(constants));
}

export function numericLiteralCounts(repoRoot: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of ratchetedSourceFiles(repoRoot)) {
    const n = countNumericLiterals(readFileSync(f, 'utf-8'));
    if (n > 0) out[rel(repoRoot, f)] = n;
  }
  return out;
}

/** Line counts of the files over the limit. */
export function oversizedFiles(repoRoot: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of listSourceFiles(join(repoRoot, 'src'))) {
    const lines = readFileSync(f, 'utf-8').split('\n').length;
    if (lines > SOURCE_HYGIENE.MAX_FILE_LINES) out[rel(repoRoot, f)] = lines;
  }
  return out;
}
