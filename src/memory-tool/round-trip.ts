/**
 * Round-trip format v2 (W4 v3.1 §6) — PURE format code. Each section
 * pairs a human heading with one line of canonical JSON:
 *
 *   ## Pitfall: heading preview [confidence: 0.85]
 *   data: {"anchor":…,"confidence":0.85,…}
 *
 * `data:` is canonical JSON (recursively sorted keys) — delimiter-safe
 * and lossless for multiline strings, `##`-bearing content, fenced
 * bodies, and full fingerprint arrays. Free-form files export as
 * `## File:` sections. Sections WITHOUT a `data:` line are v1 — their
 * raw markdown is returned for the legacy parser (backward compatible).
 *
 * The portable contract is the ENUMERATED twelve fields. Out of scope by
 * design: revision (restarts at 1), telemetry, embeddings, graph edges,
 * inactive/superseded records.
 */
import { LEARNABLE_KINDS } from '../constants/index.js';
import { routeMemoryPath } from './path-router.js';

/** The twelve portable fields — the exact restore guarantee (§6). */
export const PORTABLE_FIELDS = [
  'id', 'kind', 'content', 'confidence', 'source', 'tags', 'context',
  'fingerprint', 'project', 'expires_at', 'anchor', 'created_at',
] as const;

export interface PortableRecord {
  /** Optional in learn mode; REQUIRED by restore mode. */
  id?: string;
  kind: string;
  content: string;
  confidence: number;
  source: string;
  tags: string[];
  context: { why?: string; how_to_apply?: string } | null;
  fingerprint: Record<string, unknown> | null;
  project: string | null;
  expires_at: string | null;
  anchor: string | null;
  created_at: string;
}

export interface PortableFile {
  path: string;
  content: string;
  revision: number;
}

export interface ParsedExport {
  records: PortableRecord[];
  files: PortableFile[];
  /** Raw markdown of v1 sections (no data: line), for the legacy parser. */
  v1Markdown: string | null;
  errors: Array<{ section: number; heading: string; error: string }>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SOURCES = new Set(['user', 'learned', 'corrected', 'confirmed']);
const KINDS = new Set<string>(LEARNABLE_KINDS);
const HEADING_PREVIEW_CHARS = 60;

/** Canonical JSON: recursively sorted object keys, standard escaping. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

const headingPreview = (content: string): string => {
  const first = content.split('\n')[0].replace(/[#[\]]/g, '').trim();
  return first.length > HEADING_PREVIEW_CHARS ? `${first.slice(0, HEADING_PREVIEW_CHARS)}…` : first;
};

export function buildRecordSection(record: PortableRecord): string[] {
  const kindLabel = record.kind.charAt(0).toUpperCase() + record.kind.slice(1);
  return [
    `## ${kindLabel}: ${headingPreview(record.content)} [confidence: ${record.confidence.toFixed(2)}]`,
    `data: ${canonicalJson(record)}`,
  ];
}

export function buildFileSection(file: PortableFile): string[] {
  return [`## File: ${file.path}`, `data: ${canonicalJson(file)}`];
}

const isStringOrNull = (v: unknown): v is string | null => v === null || typeof v === 'string';

/** VFS boundary for imported files: only an EXACT canonical free-form
 *  path may be written. Root, directories, materialized/read-only files,
 *  traversal (raw or encoded), and noncanonical spellings all reject —
 *  the same router every command uses is the authority. */
export function assertPortableFilePath(path: string): void {
  const route = routeMemoryPath(path); // throws the router's message on invalid/traversal paths
  if (route.type !== 'free-form') {
    throw new Error(`path ${path} is not a free-form file — ${route.type} paths are reserved`);
  }
  if (route.path !== path) {
    throw new Error(`path ${path} is not canonical — use ${route.path}`);
  }
}

/** Shape gate for context: object, why/how_to_apply strings when present
 *  (unknown keys pass through losslessly — they are data, not schema). */
export function validateContextShape(value: unknown, label: string): void {
  if (value === null) return;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object or null`);
  const ctx = value as Record<string, unknown>;
  if (ctx.why !== undefined && typeof ctx.why !== 'string') throw new Error(`${label}.why must be a string`);
  if (ctx.how_to_apply !== undefined && typeof ctx.how_to_apply !== 'string') throw new Error(`${label}.how_to_apply must be a string`);
}

const REQUIRED_FINGERPRINT_FACETS = ['lang', 'framework', 'module'] as const;

/** Shape gate for fingerprints: lang, framework, and module are REQUIRED
 *  OWN properties (consumers index them directly — a {} or partial
 *  fingerprint crashes fingerprintOverlap), each an array of strings;
 *  future facets are allowed when similarly typed. Object.hasOwn keeps
 *  inherited properties from satisfying the requirement. */
export function validateFingerprintShape(value: unknown, label: string): void {
  if (value === null) return;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object or null`);
  const fp = value as Record<string, unknown>;
  for (const [key, facet] of Object.entries(fp)) {
    if (!Array.isArray(facet) || !facet.every(x => typeof x === 'string')) {
      throw new Error(`${label}.${key} must be an array of strings`);
    }
  }
  for (const facet of REQUIRED_FINGERPRINT_FACETS) {
    if (!Object.hasOwn(fp, facet)) {
      throw new Error(`${label}.${facet} is required — an own array of strings`);
    }
  }
}

/** Validate a record payload's shape and the eleven non-id portable
 *  fields; id, when present, must be a canonical lowercase UUID. Throws
 *  with a field-naming message. */
export function validateRecordPayload(raw: unknown): PortableRecord {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('payload is not an object');
  const p = raw as Record<string, unknown>;
  if (p.id !== undefined && (typeof p.id !== 'string' || !UUID_RE.test(p.id))) {
    throw new Error('id must be a canonical lowercase UUID');
  }
  if (typeof p.kind !== 'string' || !KINDS.has(p.kind)) throw new Error(`unsupported kind ${String(p.kind)}`);
  if (typeof p.content !== 'string' || p.content.length === 0) throw new Error('content must be a non-empty string');
  if (typeof p.confidence !== 'number' || !Number.isFinite(p.confidence) || p.confidence < 0 || p.confidence > 1) {
    throw new Error('confidence must be a number in [0, 1]');
  }
  if (typeof p.source !== 'string' || !SOURCES.has(p.source)) throw new Error(`unsupported source ${String(p.source)}`);
  if (!Array.isArray(p.tags) || !p.tags.every(t => typeof t === 'string')) throw new Error('tags must be an array of strings');
  validateContextShape(p.context, 'context');
  validateFingerprintShape(p.fingerprint, 'fingerprint');
  if (!isStringOrNull(p.project)) throw new Error('project must be a string or null');
  if (!isStringOrNull(p.expires_at)) throw new Error('expires_at must be a string or null');
  if (!isStringOrNull(p.anchor)) throw new Error('anchor must be a string or null');
  if (typeof p.created_at !== 'string' || p.created_at.length === 0) throw new Error('created_at must be a string');
  return {
    id: p.id as string | undefined,
    kind: p.kind,
    content: p.content,
    confidence: p.confidence,
    source: p.source,
    tags: p.tags as string[],
    context: p.context as PortableRecord['context'],
    fingerprint: p.fingerprint as PortableRecord['fingerprint'],
    project: p.project,
    expires_at: p.expires_at,
    anchor: p.anchor,
    created_at: p.created_at,
  };
}

function validateFilePayload(raw: unknown): PortableFile {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('payload is not an object');
  const p = raw as Record<string, unknown>;
  if (typeof p.path !== 'string') throw new Error('path must be a string');
  assertPortableFilePath(p.path);
  if (typeof p.content !== 'string') throw new Error('content must be a string');
  const revision = p.revision === undefined ? 1 : p.revision;
  if (!Number.isSafeInteger(revision) || (revision as number) < 1) throw new Error('revision must be a positive integer');
  return { path: p.path, content: p.content, revision: revision as number };
}

/** Split an export document into v2 records/files and v1 remainder.
 *  A malformed v2 payload is an ERROR for its section — never silently
 *  reinterpreted as v1 content. */
export function parseExportDocument(text: string): ParsedExport {
  const records: PortableRecord[] = [];
  const files: PortableFile[] = [];
  const errors: ParsedExport['errors'] = [];
  const v1Lines: string[] = [];

  const lines = text.split('\n');
  let section = 0;
  let heading = '';
  let sectionLines: string[] = [];

  const flush = (): void => {
    if (section === 0) return;
    const dataLine = sectionLines.find(l => l.startsWith('data: '));
    if (dataLine === undefined) {
      v1Lines.push(heading, ...sectionLines);
      return;
    }
    try {
      const payload: unknown = JSON.parse(dataLine.slice('data: '.length));
      if (/^## File: /.test(heading)) files.push(validateFilePayload(payload));
      else records.push(validateRecordPayload(payload));
    } catch (err) {
      errors.push({ section, heading, error: (err as Error).message });
    }
  };

  for (const line of lines) {
    if (line.startsWith('## ')) {
      flush();
      section++;
      heading = line;
      sectionLines = [];
    } else if (section > 0) {
      sectionLines.push(line);
    }
    // Preamble lines before the first section (# Cairn Export …) drop.
  }
  flush();

  const v1Markdown = v1Lines.some(l => l.trim().length > 0) ? v1Lines.join('\n') : null;
  return { records, files, v1Markdown, errors };
}
