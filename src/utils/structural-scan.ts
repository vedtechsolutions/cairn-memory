/**
 * Structural-scan primitives (remediation plan, step 8).
 *
 * The incident's root operational failure was UNVALIDATED INSTRUMENTS: ad
 * hoc scans that could not find known positives were trusted to prove
 * absence. The structural audits (namespace-centralization guards) run on
 * these shared primitives, and `tests/structural-scanner-validation.test.ts`
 * proves the three gates the plan demands — known-positive, cross-file,
 * mutation/red-baseline — each catch a deliberately defective scanner.
 * A scan built on private primitives is an unvalidated instrument.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface ScanHit {
  file: string;
  value: string;
  /** 1-based line of the occurrence in the comment-stripped text. */
  line: number;
}

/** Recursively list source files under a directory (default: TypeScript).
 *  Sorted for deterministic scan output across platforms. */
export function listSourceFiles(dir: string, extension = '.ts'): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listSourceFiles(full, extension));
    else if (entry.endsWith(extension)) out.push(full);
  }
  return out;
}

/**
 * Strip comments WITHOUT touching string literals — a real lexer pass, not
 * regexes. The earlier regex version created false NULLS: an owned name
 * inside a string that happened to contain `//` or `/*` (e.g. an error
 * message `"see // WAYKEEP_DB_PATH"`) was stripped along with the "comment",
 * so the scan could not find a planted positive (codex step-8 review).
 * Tracks ' " ` string states (with backslash escapes; template literals
 * conservatively treated as strings including their interpolations), strips
 * `//` and `/* … *​/` only OUTSIDE strings, and replaces stripped comment
 * text with spaces so line numbers survive.
 */
export function stripComments(text: string): string {
  let out = '';
  let i = 0;
  type Mode = 'code' | 'line' | 'block' | 'single' | 'double' | 'template';
  let mode: Mode = 'code';
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    switch (mode) {
      case 'code':
        if (c === '/' && next === '/') { mode = 'line'; out += '  '; i += 2; continue; }
        if (c === '/' && next === '*') { mode = 'block'; out += '  '; i += 2; continue; }
        if (c === "'") { mode = 'single'; out += c; i++; continue; }
        if (c === '"') { mode = 'double'; out += c; i++; continue; }
        if (c === '`') { mode = 'template'; out += c; i++; continue; }
        out += c; i++; continue;
      case 'line':
        if (c === '\n') { mode = 'code'; out += c; i++; continue; }
        out += ' '; i++; continue;
      case 'block':
        if (c === '*' && next === '/') { mode = 'code'; out += '  '; i += 2; continue; }
        out += c === '\n' ? '\n' : ' '; i++; continue;
      case 'single':
        if (c === '\\') { out += c + (next ?? ''); i += 2; continue; }
        if (c === "'" || c === '\n') { mode = 'code'; out += c; i++; continue; }
        out += c; i++; continue;
      case 'double':
        if (c === '\\') { out += c + (next ?? ''); i += 2; continue; }
        if (c === '"' || c === '\n') { mode = 'code'; out += c; i++; continue; }
        out += c; i++; continue;
      case 'template':
        if (c === '\\') { out += c + (next ?? ''); i += 2; continue; }
        if (c === '`') { mode = 'code'; out += c; i++; continue; }
        out += c; i++; continue;
    }
  }
  return out;
}

/**
 * Find EVERY occurrence of EVERY value across EVERY file (comment-stripped).
 * A scan that stops at the first file, first value, or first occurrence is
 * precisely the defective shape the validation harness exists to catch.
 */
export function scanForInlineValues(
  files: readonly string[],
  values: readonly string[],
  read: (file: string) => string = (f) => readFileSync(f, 'utf-8'),
): ScanHit[] {
  const hits: ScanHit[] = [];
  for (const file of files) {
    const text = stripComments(read(file));
    for (const value of values) {
      if (value.length === 0) continue;
      let idx = text.indexOf(value);
      while (idx >= 0) {
        hits.push({ file, value, line: text.slice(0, idx).split('\n').length });
        idx = text.indexOf(value, idx + value.length);
      }
    }
  }
  return hits;
}

/**
 * Find every WHOLE-token occurrence from the given set across every file
 * (comment-stripped). Whole-token matching against an explicit set — rather
 * than prefix pattern-matching — catches `process.env.X`, aliased access
 * (`const e = process.env; e.X`), destructuring, object-literal keys and
 * bare strings, while ignoring identifiers that merely share a prefix.
 */
export function scanForTokens(
  files: readonly string[],
  ownedTokens: ReadonlySet<string>,
  tokenPattern: RegExp = /\b[A-Z][A-Z0-9_]{2,}\b/g,
  read: (file: string) => string = (f) => readFileSync(f, 'utf-8'),
): ScanHit[] {
  const hits: ScanHit[] = [];
  for (const file of files) {
    const text = stripComments(read(file));
    const re = new RegExp(tokenPattern.source, tokenPattern.flags.includes('g') ? tokenPattern.flags : tokenPattern.flags + 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (ownedTokens.has(m[0])) {
        hits.push({ file, value: m[0], line: text.slice(0, m.index).split('\n').length });
      }
    }
  }
  return hits;
}
