/**
 * Strict §5 block grammar parser (W4 v3.1) — PURE. Two block forms:
 *
 *   TOKENED   `- [<code>:<idPrefix>@<rev>] content: <JSON string>`
 *   TOKENLESS `- content: <JSON string>`
 *
 * Continuation lines in FIXED ORDER `why:` then `how:` then `tags:`, each
 * at most once: why/how take a one-line JSON string or null (null = clear
 * on update); tags takes a JSON array of strings ([] = clear). Any other
 * line shape, ordering violation, duplicate field, `confidence:` label,
 * or invalid JSON fails the WHOLE parse — fail closed, nothing partial.
 * Thrown messages carry no `Error: ` prefix (§9 — the SDK wrapper owns
 * prefixing).
 */

import { ERR } from './errors.js';

export interface BlockToken {
  code: string;
  idPrefix: string;
  revision: number;
}

export interface ParsedBlock {
  /** Absent on token-less (create) blocks. */
  token?: BlockToken;
  content: string;
  /** undefined = omitted (preserve on update); null = explicit clear. */
  why?: string | null;
  how?: string | null;
  /** undefined = omitted; [] = explicit clear. */
  tags?: string[];
  /** The block's source lines verbatim — str_replace verifies tokened
   *  old_str blocks against the canonical rendered form. */
  raw: string[];
}

const TOKEN_CODES = new Set(['pit', 'dec', 'cor', 'fac', 'usr', 'ref', 'pat', 'gol']);

const TOKENED_START = /^- \[([a-z]{3}):([0-9a-f][0-9a-f-]{7,35})@(\d{1,15})\] content: (.+)$/;
const TOKENLESS_START = /^- content: (.+)$/;
const CONTINUATION = /^ {2}(why|how|tags): (.+)$/;
const FIELD_ORDER: Record<string, number> = { why: 0, how: 1, tags: 2 };

const malformed = (detail: string): Error => new Error(ERR.malformedBlock(detail));

function parseJsonStringOrNull(raw: string, field: string): string | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw malformed(`${field} is not one-line JSON`);
  }
  if (value === null) return null;
  if (typeof value !== 'string') throw malformed(`${field} must be a JSON string or null`);
  return value;
}

function parseTags(raw: string): string[] {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw malformed('tags is not one-line JSON');
  }
  if (!Array.isArray(value) || !value.every(t => typeof t === 'string')) {
    throw malformed('tags must be a JSON array of strings');
  }
  return value as string[];
}

/** Parse a complete blocks text (old_str, new_str, or insert_text).
 *  Every line must belong to exactly one well-formed block. */
export function parseBlocks(text: string): ParsedBlock[] {
  if (typeof text !== 'string' || text.length === 0) {
    throw malformed('empty input');
  }
  const lines = text.split('\n');
  const blocks: ParsedBlock[] = [];
  let current: ParsedBlock | null = null;
  let lastFieldOrder = -1;

  for (const line of lines) {
    if (line.trim().length === 0) throw malformed('blank lines are not part of any block');

    const tokened = TOKENED_START.exec(line);
    if (tokened) {
      const [, code, idPrefix, revisionRaw, contentRaw] = tokened;
      if (!TOKEN_CODES.has(code)) throw malformed(`unknown kind code "${code}"`);
      if (idPrefix.length < 8) throw malformed('token id prefix shorter than 8 chars');
      const revision = Number(revisionRaw);
      if (!Number.isSafeInteger(revision) || revision < 1) throw malformed('token revision must be a positive integer');
      const content = parseJsonStringOrNull(contentRaw, 'content');
      if (content === null) throw malformed('content cannot be null');
      current = { token: { code, idPrefix, revision }, content, raw: [line] };
      blocks.push(current);
      lastFieldOrder = -1;
      continue;
    }

    const tokenless = TOKENLESS_START.exec(line);
    if (tokenless) {
      const content = parseJsonStringOrNull(tokenless[1], 'content');
      if (content === null) throw malformed('content cannot be null');
      current = { content, raw: [line] };
      blocks.push(current);
      lastFieldOrder = -1;
      continue;
    }

    // Read-only provenance metadata (Codex m1s7 delta): renderBlock
    // emits `  team: <author> via <client>` on team rows; the parser
    // recognizes and DROPS it — provenance is server-stamped, never
    // written back through the VFS.
    if (/^  team: \S/.test(line)) {
      if (current === null) throw malformed('continuation line before any block start');
      current.raw.push(line);
      continue;
    }

    const cont = CONTINUATION.exec(line);
    if (cont) {
      if (current === null) throw malformed('continuation line before any block start');
      current.raw.push(line);
      const [, field, raw] = cont;
      const order = FIELD_ORDER[field];
      if (order <= lastFieldOrder) {
        throw malformed(`${field} out of order or duplicated (fields are why, how, tags — each at most once)`);
      }
      lastFieldOrder = order;
      if (field === 'tags') {
        current.tags = parseTags(raw);
      } else {
        const value = parseJsonStringOrNull(raw, field);
        if (field === 'why') current.why = value;
        else current.how = value;
      }
      continue;
    }

    if (/^ {2}confidence:/.test(line)) {
      throw new Error(ERR.confidenceImmutable());
    }
    throw malformed(`unrecognized line ${JSON.stringify(line.slice(0, 60))}`);
  }

  if (blocks.length === 0) throw malformed('no blocks found');
  return blocks;
}
