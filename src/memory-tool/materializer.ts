/**
 * Memory-tool materializer (W4 v3.1 §4, §5 grammar, §7 ordering) —
 * READ/RENDER ONLY: no command handlers, no mutations. A materialized file
 * is a deterministic ordered rendering of exact-scope ACTIVE records with
 * revision-bearing CAS tokens and canonical one-line JSON field values.
 *
 * plan is NOT a materializable category: it is PlanRepository-backed, its
 * rendering arrives with the command-handler slice, and this module throws
 * on it rather than silently rendering an empty memory-backed file.
 *
 * Failure containment: one malformed persisted row (bad tags JSON, invalid
 * id, wrong field types) excludes THAT row — counted in the visible
 * warning line and logged with id + reason through the injectable logger —
 * and never crashes the view.
 */
import type Database from 'better-sqlite3';
import type { Memory, MemoryRow } from '../db/memory-repository/types.js';
import { rowToMemory } from '../db/memory-repository/reads.js';
import { precisionRatio } from '../utils/scoring-primitives.js';
import { CATEGORY_KINDS, type Category } from './path-router.js';
import { RenderCache, type FrozenRendering } from './render-cache.js';
import { KIND_CODES } from './token-codes.js';

/** plan is repo-backed and deferred — the materializer refuses it. */
export type MaterializableCategory = Exclude<Category, 'plan'>;

export const FRESH_RENDERING_NOTICE =
  '[fresh rendering — line numbers may differ from any earlier view]';
export const RECORD_SANITY_LIMIT = 10_000;

export type Log = (message: string) => void;
const defaultLog: Log = (message) => console.error(`[cairn:materializer] ${message}`);

/** Identity contract: canonical LOWERCASE UUID ids only — the §5 grammar
 *  is lowercase-hex, so an uppercase id would render a token the parser
 *  rejects: a block that exists but can never be edited. Fail closed. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A record plus its SQL-computed julian day — chronology comes from
 *  SQLite julianday(created_at), NEVER Date.parse: local-timezone parsing
 *  of SQLite-format timestamps can invert ordering against ISO ones. */
export interface RenderableRecord extends Memory {
  jd: number | null;
}

function assertMaterializable(category: Category): asserts category is MaterializableCategory {
  if (category === 'plan') {
    throw new Error('plan is PlanRepository-backed — the materializer does not render it');
  }
}

// --- Exact-scope active-record loading (per-row failure containment) ----------

export interface LoadedRecords {
  records: RenderableRecord[];
  /** Rows that failed row→domain mapping (logged, counted in warnings). */
  failedRows: number;
}

/** Active records for one category in ONE exact scope — `project = ?` or
 *  `project IS NULL`, never the recall queries that blend global into
 *  project results. Matches the v27 partial-index predicate. A row whose
 *  mapping throws is excluded, logged, and counted — never fatal. */
export function loadActiveRecords(
  db: Database.Database,
  project: string | null,
  category: MaterializableCategory,
  log: Log = defaultLog,
): LoadedRecords {
  const kinds = CATEGORY_KINDS[category];
  const kindPlaceholders = kinds.map(() => '?').join(',');
  const scopeClause = project === null ? 'project IS NULL' : 'project = ?';
  const args = project === null ? [...kinds] : [project, ...kinds];
  const rows = db.prepare(`
    SELECT *, julianday(created_at) AS jd FROM memories
    WHERE ${scopeClause} AND kind IN (${kindPlaceholders})
      AND invalidated = 0 AND superseded_by IS NULL
  `).all(...args) as Array<MemoryRow & { jd: number | null }>;

  const records: RenderableRecord[] = [];
  let failedRows = 0;
  for (const row of rows) {
    try {
      records.push({ ...rowToMemory(row), jd: row.jd });
    } catch (err) {
      failedRows++;
      log(`row ${row.id} unrenderable: ${(err as Error).message}`);
    }
  }
  return { records, failedRows };
}

// --- Deterministic ordering (§7) ----------------------------------------------

const jdOf = (r: RenderableRecord): number => r.jd ?? 0;

/** Every key chain is total: it ends with full-id ASC. Chronology is the
 *  SQL julianday value (see RenderableRecord). */
export function compareForCategory(category: MaterializableCategory): (a: RenderableRecord, b: RenderableRecord) => number {
  if (category === 'pitfalls') {
    return (a, b) =>
      (precisionRatio(b.surface_count, b.impact_count, b.confidence)
        - precisionRatio(a.surface_count, a.impact_count, a.confidence))
      || (b.confidence - a.confidence)
      || (jdOf(b) - jdOf(a))
      || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  }
  return (a, b) =>
    (b.confidence - a.confidence)
    || (jdOf(b) - jdOf(a))
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

// --- Record validation (§4 identity contract) ---------------------------------

/** Returns null when renderable, else the reason it is not. Also guards
 *  every numeric field the ORDERING consumes — a NaN comparator can
 *  corrupt the sort of the whole array, valid records included. */
export function recordDefect(record: Memory): string | null {
  if (typeof record.id !== 'string' || !UUID_RE.test(record.id)) return 'non-canonical id';
  // Object.hasOwn: inherited keys (__proto__, constructor, toString) must
  // not resolve to "codes" — `in` would render function source as a code.
  if (typeof record.kind !== 'string' || !Object.hasOwn(KIND_CODES, record.kind)) {
    return `unsupported kind ${String(record.kind)}`;
  }
  if (!Number.isSafeInteger(record.revision) || record.revision < 1) return 'invalid revision';
  if (typeof record.content !== 'string') return 'non-string content';
  if (!Array.isArray(record.tags) || !record.tags.every(t => typeof t === 'string')) return 'invalid tags';
  if (typeof record.confidence !== 'number' || !Number.isFinite(record.confidence)) return 'invalid confidence';
  if (!Number.isSafeInteger(record.surface_count) || record.surface_count < 0) return 'invalid surface_count';
  if (!Number.isSafeInteger(record.impact_count) || record.impact_count < 0) return 'invalid impact_count';
  const ctx = record.context;
  if (ctx !== null && (typeof ctx !== 'object' || Array.isArray(ctx))) return 'invalid context';
  if (ctx && ctx.why !== undefined && typeof ctx.why !== 'string') return 'invalid context.why';
  if (ctx && ctx.how_to_apply !== undefined && typeof ctx.how_to_apply !== 'string') return 'invalid context.how_to_apply';
  return null;
}

/** Partition records into renderable and defective BEFORE any id-slicing
 *  or sorting touches them: a numeric id would crash prefix assignment,
 *  and a NaN confidence would destabilize the comparator for every
 *  record in the array. Defects are logged here. */
export function partitionRenderable(records: readonly Memory[], log: Log = defaultLog): { valid: Memory[]; defects: number } {
  const valid: Memory[] = [];
  let defects = 0;
  for (const record of records) {
    const defect = recordDefect(record);
    if (defect === null) {
      valid.push(record);
    } else {
      defects++;
      log(`record ${String((record as { id?: unknown }).id)} unrenderable: ${defect}`);
    }
  }
  return { valid, defects };
}

// --- Token construction with collision extension (§4) --------------------------

/** idPrefix lengths: 8 → 12 → 16 → … → full id. ALL colliding ids extend
 *  together; literal duplicate ids (defensive) map to null — fail closed. */
export function assignTokenPrefixes(records: readonly Memory[]): Map<string, string | null> {
  const result = new Map<string, string | null>();
  let unresolved = [...new Set(records.map(r => r.id))];
  const counts = new Map<string, number>();
  for (const r of records) counts.set(r.id, (counts.get(r.id) ?? 0) + 1);
  for (const [id, n] of counts) {
    if (n > 1) {
      result.set(id, null);
      unresolved = unresolved.filter(u => u !== id);
    }
  }
  let len = 8;
  while (unresolved.length > 0) {
    const groups = new Map<string, string[]>();
    for (const id of unresolved) {
      const prefix = id.slice(0, len);
      const group = groups.get(prefix);
      if (group) group.push(id);
      else groups.set(prefix, [id]);
    }
    const next: string[] = [];
    for (const [prefix, ids] of groups) {
      if (ids.length === 1) {
        result.set(ids[0], prefix);
      } else if (ids.every(id => prefix.length >= id.length)) {
        for (const id of ids) result.set(id, null);
      } else {
        next.push(...ids);
      }
    }
    unresolved = next;
    len += 4;
  }
  return result;
}

// --- Block rendering (§5 grammar) ---------------------------------------------

/** Canonical §5 block lines for one record — ALSO the reference form
 *  old_str blocks are verified against in str_replace. */
export function renderBlock(record: Memory, prefix: string): string[] {
  const code = KIND_CODES[record.kind];
  const lines = [`- [${code}:${prefix}@${record.revision}] content: ${JSON.stringify(record.content)}`];
  const why = record.context?.why?.trim();
  const how = record.context?.how_to_apply?.trim();
  if (why) lines.push(`  why: ${JSON.stringify(why)}`);
  if (how) lines.push(`  how: ${JSON.stringify(how)}`);
  if (record.tags.length > 0) lines.push(`  tags: ${JSON.stringify(record.tags)}`);
  // Out-of-band provenance (Codex m1s7 delta overturning its own
  // exemption): the VFS is a model-visible inspection surface. CAS
  // protects the CONTENT bytes (still raw JSON above); this metadata
  // line is read-only — the parser recognizes and drops it on
  // write-back, and it appears only on team rows so local-row goldens
  // are unchanged.
  if (record.author) {
    const client = record.origin_client ? ` via ${record.origin_client}` : '';
    lines.push(`  team: ${record.author}${client}`);
  }
  return lines;
}

export interface RenderedRecords {
  lines: string[];
  unrenderable: number;
}

/** Pure rendering over an ORDERED record list. Records failing validation
 *  or block construction are EXCLUDED, logged, and counted (together with
 *  `extraUnrenderable` upstream row failures) in ONE visible warning line
 *  — nothing is silently dropped (§4 fail-closed rule). */
export function renderRecords(
  records: readonly Memory[],
  extraUnrenderable: number = 0,
  log: Log = defaultLog,
): RenderedRecords {
  // Partition BEFORE prefix assignment: only validated records may enter
  // collision resolution (a non-string id would crash id.slice there).
  const { valid, defects } = partitionRenderable(records, log);
  const prefixes = assignTokenPrefixes(valid);
  const lines: string[] = [];
  let unrenderable = extraUnrenderable + defects;
  for (const record of valid) {
    const prefix = prefixes.get(record.id);
    if (prefix === null || prefix === undefined) {
      unrenderable++;
      log(`record ${record.id} unrenderable: no unambiguous token prefix`);
      continue;
    }
    try {
      lines.push(...renderBlock(record, prefix));
    } catch (err) {
      unrenderable++;
      log(`record ${record.id} unrenderable: ${(err as Error).message}`);
    }
  }
  if (records.length > RECORD_SANITY_LIMIT) {
    lines.unshift(`[cairn: ${records.length} records in this file — consider cleanup]`);
  }
  if (unrenderable > 0) {
    lines.unshift(`[cairn: ${unrenderable} records unrenderable — see logs]`);
  }
  return { lines, unrenderable };
}

// --- View materialization with frozen paging (§7) ------------------------------

export interface MaterializeResult {
  lines: readonly string[];
  renderingHash: string;
  /** True when a ranged request could not be served from the frozen
   *  rendering and fell back to a fresh one (notice line prepended). */
  fresh: boolean;
}

/** Render a materialized memory-category file. Full views freeze the
 *  rendering; ranged views serve the frozen lines so pages stay mutually
 *  consistent. A ranged view with no usable freeze re-renders and carries
 *  the visible fallback notice. Throws on the plan category. */
export function materializeView(
  db: Database.Database,
  path: string,
  project: string | null,
  category: Category,
  cache: RenderCache,
  ranged: boolean,
  log: Log = defaultLog,
): MaterializeResult {
  assertMaterializable(category);
  if (!ranged) {
    const frozen = cache.set(path, render(db, project, category, log));
    return { lines: frozen.lines, renderingHash: frozen.renderingHash, fresh: false };
  }
  const frozen: FrozenRendering | null = cache.get(path);
  if (frozen) {
    return { lines: frozen.lines, renderingHash: frozen.renderingHash, fresh: false };
  }
  const refrozen = cache.set(path, [FRESH_RENDERING_NOTICE, ...render(db, project, category, log)]);
  return { lines: refrozen.lines, renderingHash: refrozen.renderingHash, fresh: true };
}

function render(db: Database.Database, project: string | null, category: MaterializableCategory, log: Log): string[] {
  const { records, failedRows } = loadActiveRecords(db, project, category, log);
  // Partition BEFORE sorting: a NaN confidence in one defective record
  // makes the comparator inconsistent and can corrupt the order of VALID
  // records too. renderRecords re-partitions (idempotent for valid input).
  const { valid, defects } = partitionRenderable(records as Memory[], log);
  (valid as RenderableRecord[]).sort(compareForCategory(category));
  return renderRecords(valid, failedRows + defects, log).lines;
}
