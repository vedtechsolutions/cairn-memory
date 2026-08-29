/**
 * Portable export/restore (W4 v3.1 §6) — the twelve enumerated fields
 * only. Export selects ACTIVE rows (invalidated = 0, not superseded,
 * never task_state). Restore is a strict upsert-by-FULL-id: no merge, no
 * confidence boost, no conflict detection, id-preserving. Out of scope
 * by contract: revision (restarts at 1 via column default), telemetry
 * (zeroed), embeddings (re-derived by the backfill worker), graph edges,
 * and origin_client (v29 — restored rows default to 'claude'; existing
 * rows keep their value via ON CONFLICT. Joins the portable set when the
 * round-trip format next revs, alongside Phase-2 sync provenance).
 *
 * Secret scanning boundary: restore is byte-exact by design and does NOT
 * re-run the secret scanner — it reconstructs an already-scanned export
 * (content is scrubbed at every capture path before it can be exported).
 * The residual risk is narrow: a pre-scanner or hand-crafted export can
 * reintroduce a raw secret through this one path. Accepted deliberately to
 * preserve round-trip fidelity; capture-path scrubbing is the guarantee.
 */
import type Database from 'better-sqlite3';
import { isPrivateProject } from '../../config/cairn-config.js';
import { writeFreeForm } from '../../memory-tool/free-form-store.js';
import { journalUpsertForId, type JournalOptions } from './journal.js';
import {
  assertPortableFilePath, validateRecordPayload,
  type PortableFile, type PortableRecord,
} from '../../memory-tool/round-trip.js';

export interface PortableExportOptions {
  project?: string | null;
  kind?: string;
  minConfidence?: number;
}

interface PortableRow {
  id: string;
  kind: string;
  content: string;
  confidence: number;
  source: string;
  tags: string | null;
  context: string | null;
  fingerprint: string | null;
  project: string | null;
  expires_at: string | null;
  anchor: string | null;
  created_at: string;
}

/** Fidelity boundary: corrupt stored JSON must FAIL the export with the
 *  record id and field name — silently coercing it to []/null would
 *  round-trip a lie about what the store contains. */
const parseStoredJson = (raw: string | null, id: string, field: string): unknown => {
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`record ${id}: stored ${field} is corrupt JSON — repair the row before exporting`);
  }
};

/** ACTIVE rows carrying exactly the twelve portable fields. */
export function exportPortableRecords(db: Database.Database, options: PortableExportOptions = {}): PortableRecord[] {
  const conditions = [
    'invalidated = 0', 'superseded_by IS NULL',
    "kind != 'task_state'", "kind != 'rule'",
  ];
  const params: unknown[] = [];
  // Only an EXPLICIT confidence filter may exclude rows in SQL — on an
  // unfiltered export, a corrupt confidence (NULL never satisfies >=)
  // must reach candidate validation and fail VISIBLY, not vanish.
  if (options.minConfidence !== undefined) {
    conditions.push('confidence >= ?');
    params.push(options.minConfidence);
  }
  if (options.kind !== undefined) {
    conditions.push('kind = ?');
    params.push(options.kind);
  }
  if (options.project !== undefined) {
    if (options.project === null) {
      conditions.push('project IS NULL');
    } else {
      conditions.push('(project = ? OR project IS NULL)');
      params.push(options.project);
    }
  }
  const rows = db.prepare(`
    SELECT id, kind, content, confidence, source, tags, context, fingerprint,
           project, expires_at, anchor, created_at
    FROM memories
    WHERE ${conditions.join(' AND ')}
    ORDER BY kind, confidence DESC, id
  `).all(...params) as PortableRow[];

  return rows.map(r => {
    // Build the COMPLETE candidate and validate it through the SAME gate
    // the parser applies on import — export must never emit a section its
    // own parser rejects (NULL source, out-of-range confidence, …).
    const candidate = {
      id: r.id,
      kind: r.kind,
      content: r.content,
      confidence: r.confidence,
      source: r.source,
      tags: r.tags === null ? [] : parseStoredJson(r.tags, r.id, 'tags'),
      context: parseStoredJson(r.context, r.id, 'context'),
      fingerprint: parseStoredJson(r.fingerprint, r.id, 'fingerprint'),
      project: r.project,
      expires_at: r.expires_at,
      anchor: r.anchor,
      created_at: r.created_at,
    };
    try {
      return validateRecordPayload(candidate);
    } catch (err) {
      throw new Error(`record ${r.id}: ${(err as Error).message} — repair the row before exporting`);
    }
  });
}

export function exportPortableFiles(db: Database.Database): PortableFile[] {
  return db.prepare('SELECT path, content, revision FROM memory_files ORDER BY path')
    .all() as PortableFile[];
}

/** Strict restore of ONE record by FULL id. Insert-or-replace of the
 *  eleven non-id portable fields; telemetry and revision take column
 *  defaults on insert and are NEVER copied from the payload. Returns
 *  whether the row was created or an existing id was overwritten. */
/** Thrown when a restore record would touch an existing PRIVATE row
 *  without standing (any overwrite) or acknowledgment (a scope change).
 *  Restore is a WHOLE-DOCUMENT transaction, so this aborts everything —
 *  a partial commit would silently break the all-or-nothing contract. */
export class PrivateScopeChangeError extends Error {
  constructor(public readonly recordId: string, public readonly fromProject: string, reason: 'standing' | 'ack') {
    super(reason === 'standing'
      ? `record ${recordId} would overwrite a memory in private project "${fromProject}"`
      : `record ${recordId} would change the scope of a memory in private project "${fromProject}"`);
  }
}

export function restoreRecord(
  db: Database.Database,
  record: PortableRecord & { id: string },
  opts: { allowPrivateScopeChange?: boolean; sessionProjectId?: string | null; journal?: JournalOptions } = {},
): 'inserted' | 'updated' {
  if ((record as { kind: string }).kind === 'rule') {
    throw new Error('rule memories are not portable');
  }
  const existing = db.prepare('SELECT kind, project FROM memories WHERE id = ?').get(record.id) as { kind: string; project: string | null } | undefined;
  if (existing?.kind === 'rule') throw new Error('rule memories are not portable');
  // Scope-policy invariant, enforced at the REPOSITORY boundary so no
  // restore caller can bypass it. Mutation follows readability: ANY
  // overwrite of an existing private row requires standing (the session
  // runs inside that project — cairn_correct refuses the same row from
  // the same session, and restore must not be the workaround). A SCOPE
  // change additionally requires the explicit acknowledgment. Either
  // throw aborts the whole document (all-or-nothing preserved). A fresh
  // INSERT into a private project is deliberately allowed — content
  // flowing IN leaks nothing (documented seeding path).
  if (existing && existing.project !== null && isPrivateProject(existing.project)) {
    if (opts.sessionProjectId !== existing.project) {
      throw new PrivateScopeChangeError(record.id, existing.project, 'standing');
    }
    if (record.project !== existing.project && opts.allowPrivateScopeChange !== true) {
      throw new PrivateScopeChangeError(record.id, existing.project, 'ack');
    }
  }
  db.prepare(`
    INSERT INTO memories (id, content, kind, project, tags, confidence, source, created_at,
                          updated_at, expires_at, fingerprint, context, anchor,
                          recall_count, invalidated, surface_count, impact_count)
    VALUES (@id, @content, @kind, @project, @tags, @confidence, @source, @created_at,
            @created_at, @expires_at, @fingerprint, @context, @anchor, 0, 0, 0, 0)
    ON CONFLICT(id) DO UPDATE SET
      content = excluded.content, kind = excluded.kind, project = excluded.project,
      tags = excluded.tags, confidence = excluded.confidence, source = excluded.source,
      created_at = excluded.created_at, expires_at = excluded.expires_at,
      fingerprint = excluded.fingerprint, context = excluded.context, anchor = excluded.anchor,
      invalidated = 0, superseded_by = NULL, superseded_at = NULL,
      -- The old vector described the OLD content: clear both columns so
      -- the backfill worker re-embeds the restored text.
      embedding = NULL, embedding_model = NULL
  `).run({
    id: record.id,
    content: record.content,
    kind: record.kind,
    project: record.project,
    tags: JSON.stringify(record.tags),
    confidence: record.confidence,
    source: record.source,
    created_at: record.created_at,
    expires_at: record.expires_at,
    fingerprint: record.fingerprint === null ? null : JSON.stringify(record.fingerprint),
    context: record.context === null ? null : JSON.stringify(record.context),
    anchor: record.anchor,
  });
  // A restore is a user-invoked semantic write — including the deliberate
  // resurrection of a retired row — so it journals an upsert at the
  // resulting revision like any other explicit edit (journal.ts). The
  // future replicated apply passes `suppressed` (D13).
  journalUpsertForId(db, record.id, opts.journal);
  return existing ? 'updated' : 'inserted';
}

/** Validated free-form file restore: the VFS path gate runs before any
 *  write, then the adapter's caps apply. */
export function restoreFile(db: Database.Database, file: PortableFile): void {
  assertPortableFilePath(file.path);
  writeFreeForm(db, file.path, file.content);
}

export interface RestoreCounts {
  restored: number;
  overwritten: number;
  files: number;
}

/** Strict-restore a WHOLE document in ONE immediate transaction: every
 *  record and file write commits together or not at all — a constraint,
 *  path, or cap failure anywhere rolls everything back. */
export function restoreDocument(
  db: Database.Database,
  records: ReadonlyArray<PortableRecord & { id: string }>,
  files: readonly PortableFile[],
  opts: { allowPrivateScopeChange?: boolean; sessionProjectId?: string | null; journal?: JournalOptions } = {},
): RestoreCounts {
  let restored = 0;
  let overwritten = 0;
  const run = db.transaction(() => {
    for (const record of records) {
      if (restoreRecord(db, record, opts) === 'inserted') restored++;
      else overwritten++;
    }
    for (const file of files) restoreFile(db, file);
  });
  run.immediate();
  return { restored, overwritten, files: files.length };
}
