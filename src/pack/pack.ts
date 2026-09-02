import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, unlinkSync, existsSync, openSync, fstatSync, closeSync, opendirSync, constants as fsConstants } from 'node:fs';
import { join } from 'node:path';

import type Database from 'better-sqlite3';
import { SHAREABLE_KINDS } from 'waykeep-contract';

import { LIMITS } from '../constants/index.js';
import { MemoryRepository } from '../db/memory-repository.js';
import { waykeepConfigSnapshot } from '../config/waykeep-config.js';
import { scrubSecrets, sanitize } from '../utils/index.js';
import { neutralizeMemoryText } from '../utils/validation.js';
import { writeFileAtomic, isRegularFile } from '../utils/atomic-write.js';
import { learnSections, type LearnSection } from '../importers/learn-pipeline.js';

/**
 * Free manual repo-pack (brief D8 item 8 / D12): a deterministic
 * one-record-per-file codec plus EXPLICIT `waykeep pack export/import`
 * to a user-chosen, normally-gitignored directory.
 *
 * The pack is OBSERVATIONS, not authority: records carry only the
 * observation fields (kind, content, tags, why, how) — no ids, no
 * confidence, no timestamps — and import rides the learn pipeline with
 * `reinforceExact: false`, so re-imports are true no-ops, imported
 * content is untrusted (neutralize + scrub + caps), and a pack can
 * NEVER edit or delete an existing row (D12: no edit/delete claims —
 * deleting a file deletes nothing; renaming a file changes nothing,
 * because identity is the CONTENT ADDRESS, not the name).
 *
 * Determinism: the filename is the content address (sha256 over the
 * canonical serialized bytes) and the bytes are a canonical fixed-order
 * serialization of already-scrubbed fields, so export → import into a
 * fresh store → export reproduces a byte-identical file set.
 *
 * Git: NO pack operation ever invokes git — not commit, not push, not
 * status. The location being gitignored is the USER'S arrangement; the
 * pack only prints a reminder. (R16b's no-git assertion tests this
 * module's imports.)
 */

export const PACK_EXT = '.waykeep.md';
export const PACK_MANIFEST = '.waykeep-pack.json';

interface PackManifest { version: 1; scopes: Record<string, string[]> }

/** Bounds for untrusted pack input (Codex pack #4): everything is
 *  capped BEFORE allocation. */
export const PACK_BOUNDS = {
  MAX_FILE_BYTES: 65_536,
  MAX_FILES: 10_000,
  MAX_LINES: 64,
  MAX_AUX_CHARS: 2_000,
} as const;

/** The directory is the FILESYSTEM BOUNDARY (Codex pack #3): only
 *  regular files are read, written, or pruned — a planted symlink can
 *  neither leak an outside file in nor route a write OUT (the probe
 *  overwrote a file outside --dir through a content-address symlink). */
/** Bounded symlink-race-free read (Codex pack delta Z4): the fd is
 *  opened O_NOFOLLOW, fstat'd for type+size ON THE OPEN FD, then read —
 *  no path-based stat-then-read window to swap a symlink or grow the
 *  file into. */
function readBoundedRegular(path: string, maxBytes: number): string {
  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ELOOP') {
      throw new Error('not a regular file (symlinks are outside the pack boundary)');
    }
    throw err;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error('not a regular file (symlinks are outside the pack boundary)');
    if (st.size > maxBytes) throw new Error(`exceeds ${maxBytes} bytes`);
    return readFileSync(fd, 'utf-8');
  } finally {
    closeSync(fd);
  }
}

const PACK_HEADER = '# waykeep pack record v1';

export interface PackRecord {
  kind: string;
  content: string;
  tags: string[];
  why?: string;
  how?: string;
}

const clean = (text: string): string =>
  scrubSecrets(sanitize(neutralizeMemoryText(text))).text.slice(0, LIMITS.MAX_CONTENT_CHARS);

/** Canonical serialized bytes — fixed field order, one-line JSON values,
 *  trailing newline. The determinism contract lives here. */
export function serializePackRecord(r: PackRecord): string {
  const lines = [PACK_HEADER, `kind: ${JSON.stringify(r.kind)}`, `content: ${JSON.stringify(r.content)}`];
  if (r.tags.length > 0) lines.push(`tags: ${JSON.stringify([...r.tags].sort())}`);
  if (r.why) lines.push(`why: ${JSON.stringify(r.why)}`);
  if (r.how) lines.push(`how: ${JSON.stringify(r.how)}`);
  return lines.join('\n') + '\n';
}

export function contentAddress(serialized: string): string {
  return createHash('sha256').update(serialized, 'utf8').digest('hex').slice(0, 24);
}

/** Untrusted parse: strict shape, bounded fields, unknown keys refused.
 *  Every failure names the problem — a malformed pack file is skipped
 *  loudly, never half-imported. */
export function parsePackRecord(text: string): PackRecord {
  // Interop tolerance (pack review C4): a Windows checkout with
  // core.autocrlf converts LF→CRLF and editors add BOMs — tolerate both
  // at PARSE time; the canonical write form stays LF-only, so
  // determinism is unaffected.
  const lines = text.replace(/^\uFEFF/, '').split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => l.length > 0);
  if (lines.length > PACK_BOUNDS.MAX_LINES) throw new Error(`record exceeds ${PACK_BOUNDS.MAX_LINES} lines`);
  if (lines[0] !== PACK_HEADER) throw new Error('missing pack record header');
  const fields = new Map<string, unknown>();
  for (const line of lines.slice(1)) {
    const m = /^(kind|content|tags|why|how): (.+)$/.exec(line);
    if (!m) throw new Error(`unrecognized line: ${line.slice(0, 60)}`);
    if (fields.has(m[1])) throw new Error(`duplicate field ${m[1]}`);
    let value: unknown;
    try {
      value = JSON.parse(m[2]);
    } catch {
      throw new Error(`${m[1]} is not one-line JSON`);
    }
    fields.set(m[1], value);
  }
  const kind = fields.get('kind');
  if (typeof kind !== 'string' || !(SHAREABLE_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`kind must be one of ${SHAREABLE_KINDS.join('/')}`);
  }
  const content = fields.get('content');
  if (typeof content !== 'string' || content.length === 0 || content.length > LIMITS.MAX_CONTENT_CHARS) {
    throw new Error('content must be a non-empty bounded string');
  }
  const tags = fields.get('tags') ?? [];
  if (!Array.isArray(tags) || tags.length > LIMITS.MAX_TAGS || !tags.every((t) => typeof t === 'string' && t.length <= LIMITS.MAX_TAG_CHARS)) {
    throw new Error('tags must be a bounded array of bounded strings');
  }
  const why = fields.get('why');
  const how = fields.get('how');
  if (why !== undefined && (typeof why !== 'string' || why.length > PACK_BOUNDS.MAX_AUX_CHARS)) throw new Error('why must be a bounded string');
  if (how !== undefined && (typeof how !== 'string' || how.length > PACK_BOUNDS.MAX_AUX_CHARS)) throw new Error('how must be a bounded string');
  return { kind, content, tags: tags as string[], why: why as string | undefined, how: how as string | undefined };
}

export interface PackExportResult {
  written: number;
  unchanged: number;
  pruned: number;
  /** Rows whose stored bytes changed under the export re-scrub — loud:
   *  a redaction happening NOW means a secret was resting in the DB. */
  redactions: Array<{ file: string; excerpt: string }>;
}

export function packExport(db: Database.Database, dir: string, project: string | null | 'all-shared'): PackExportResult {
  mkdirSync(dir, { recursive: true });
  // ONE policy snapshot, fail closed (Codex pack #6): bulk export
  // refuses to run on an unhealthy config — a malformed privacy file
  // must never widen what leaves the store — and per-row checks read
  // this snapshot, never the file again.
  const snapshot = waykeepConfigSnapshot();
  if (project === 'all-shared' && !snapshot.health.healthy) {
    throw new Error(`config at ${snapshot.health.path} is unhealthy (${snapshot.health.problem}) — bulk export refuses fail-closed; fix the config or name a project explicitly`);
  }
  const where = project === 'all-shared'
    ? "project IS NOT NULL AND invalidated = 0 AND superseded_by IS NULL"
    : project === null
      ? 'project IS NULL AND invalidated = 0 AND superseded_by IS NULL'
      : 'project = ? AND invalidated = 0 AND superseded_by IS NULL';
  const kindPlaceholders = SHAREABLE_KINDS.map(() => '?').join(',');
  const sql = `SELECT content, kind, project, tags, context FROM memories WHERE ${where} AND kind IN (${kindPlaceholders}) ORDER BY id`;
  const args = project === 'all-shared' || project === null ? [...SHAREABLE_KINDS] : [project, ...SHAREABLE_KINDS];
  const rows = db.prepare(sql).all(...args) as Array<{ content: string; kind: string; project: string | null; tags: string | null; context: string | null }>;

  const result: PackExportResult = { written: 0, unchanged: 0, pruned: 0, redactions: [] };
  const current = new Set<string>();
  for (const row of rows) {
    // Private projects never leave through the bulk form; an explicitly
    // named private project is the user's deliberate choice.
    if (project === 'all-shared' && row.project !== null && snapshot.config.scope.privateProjects.has(row.project)) continue;
    const scrubbed = clean(row.content);
    if (scrubbed.length === 0) continue; // cleaning emptied it — nothing to observe
    const ctx = row.context ? (JSON.parse(row.context) as { why?: string; how_to_apply?: string }) : {};
    const cleanedTags = row.tags
      ? (JSON.parse(row.tags) as string[]).map((t) => clean(t).slice(0, LIMITS.MAX_TAG_CHARS)).filter((t) => t.length > 0).slice(0, LIMITS.MAX_TAGS)
      : [];
    const cleanedWhy = ctx.why ? clean(ctx.why).slice(0, PACK_BOUNDS.MAX_AUX_CHARS) : undefined;
    const cleanedHow = ctx.how_to_apply ? clean(ctx.how_to_apply).slice(0, PACK_BOUNDS.MAX_AUX_CHARS) : undefined;
    const rec: PackRecord = { kind: row.kind, content: scrubbed, tags: cleanedTags, why: cleanedWhy || undefined, how: cleanedHow || undefined };
    const serialized = serializePackRecord(rec);
    // Every emitted record must pass its own parser (Codex pack #2b —
    // over-cap legacy tags exported bytes the import refused).
    parsePackRecord(serialized);
    const file = `${contentAddress(serialized)}${PACK_EXT}`;
    // Redactions are loud for EVERY serialized field, not content alone
    // (Codex pack #6): a secret resting in tags or context matters the
    // same.
    const rawTags = row.tags ? (JSON.parse(row.tags) as string[]) : [];
    const fieldChanged = scrubbed !== row.content
      || rawTags.slice(0, LIMITS.MAX_TAGS).some((t, i) => cleanedTags[i] !== undefined && cleanedTags[i] !== t.slice(0, LIMITS.MAX_TAG_CHARS))
      || (ctx.why !== undefined && cleanedWhy !== ctx.why.slice(0, PACK_BOUNDS.MAX_AUX_CHARS))
      || (ctx.how_to_apply !== undefined && cleanedHow !== ctx.how_to_apply.slice(0, PACK_BOUNDS.MAX_AUX_CHARS));
    if (fieldChanged) {
      result.redactions.push({ file, excerpt: scrubbed.slice(0, 60) });
    }
    current.add(file);
    const path = join(dir, file);
    let existingBytes: string | null = null;
    if (isRegularFile(path)) {
      try { existingBytes = readBoundedRegular(path, PACK_BOUNDS.MAX_FILE_BYTES); } catch { existingBytes = null; }
    }
    if (existingBytes === serialized) {
      result.unchanged++;
    } else {
      writeFileAtomic(path, serialized, { refuseNonRegular: true });
      result.written++;
    }
  }
  // Prune with a SCOPED manifest guard (pack review C3): the prune owns
  // only files THIS scope's previous export wrote — a foreign pack, a
  // sibling project's pack in the same directory, or hand-added files
  // are never touched. Files still listed under another scope survive
  // even when this scope drops them.
  const manifestPath = join(dir, PACK_MANIFEST);
  let manifest: PackManifest = { version: 1, scopes: {} };
  if (existsSync(manifestPath)) {
    try {
      const parsed = JSON.parse(readBoundedRegular(manifestPath, PACK_BOUNDS.MAX_FILE_BYTES * 4)) as PackManifest;
      if (parsed && parsed.version === 1 && parsed.scopes && typeof parsed.scopes === 'object') manifest = parsed;
    } catch { /* unreadable manifest: prune nothing this pass */ }
  }
  const scopeKey = project === 'all-shared' ? '(all-shared)' : project === null ? '(global)' : project;
  const owned = new Set(manifest.scopes[scopeKey] ?? []);
  const listedElsewhere = new Set(
    Object.entries(manifest.scopes).filter(([k]) => k !== scopeKey).flatMap(([, files]) => files),
  );
  for (const entry of owned) {
    // Manifest paths are validated: bare *.waykeep.md names only —
    // never separators — and only REGULAR files are unlinked.
    if (!/^[A-Za-z0-9._-]+$/.test(entry) || !entry.endsWith(PACK_EXT)) continue;
    const p = join(dir, entry);
    if (!current.has(entry) && !listedElsewhere.has(entry) && isRegularFile(p)) {
      unlinkSync(p);
      result.pruned++;
    }
  }
  manifest.scopes[scopeKey] = [...current].sort();
  writeFileAtomic(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { refuseNonRegular: true });
  return result;
}

export interface PackImportResult {
  ingested: number;
  exactDuplicates: number;
  merged: number;
  errors: string[];
}

export function packImport(db: Database.Database, dir: string, project: string | null): PackImportResult {
  const repo = new MemoryRepository(db);
  const sections: LearnSection[] = [];
  const errors: string[] = [];
  // Bounded enumeration BEFORE any bulk allocation (Codex pack delta
  // Z4): the directory iterator bails at the cap instead of listing an
  // arbitrary directory whole.
  const entries: string[] = [];
  const dh = opendirSync(dir);
  try {
    let ent = dh.readSync();
    while (ent !== null) {
      if (ent.name.endsWith(PACK_EXT)) {
        entries.push(ent.name);
        if (entries.length > PACK_BOUNDS.MAX_FILES) {
          return { ingested: 0, exactDuplicates: 0, merged: 0, errors: [`directory holds over ${PACK_BOUNDS.MAX_FILES} pack files — the cap refuses the whole import`] };
        }
      }
      ent = dh.readSync();
    }
  } finally {
    dh.closeSync();
  }
  entries.sort();
  for (const entry of entries) {
    try {
      const path = join(dir, entry);
      const rec = parsePackRecord(readBoundedRegular(path, PACK_BOUNDS.MAX_FILE_BYTES));
      sections.push({
        kind: rec.kind as LearnSection['kind'],
        content: rec.content,
        tags: rec.tags,
        context: rec.why || rec.how ? { why: rec.why, how_to_apply: rec.how } : undefined,
      });
    } catch (err) {
      errors.push(`${entry}: ${(err as Error).message}`);
    }
  }
  const learned = learnSections(repo, sections, project, { reinforceExact: false, insertOnly: true });
  return {
    ingested: learned.ingested,
    exactDuplicates: learned.exactDuplicates,
    merged: learned.merged.length,
    errors: [...errors, ...learned.errors],
  };
}
