/**
 * Importer: the community `claude-mem` archive.
 *
 * Format (verified against thedotmack/claude-mem v13.x source): ONE
 * global SQLite DB at ~/.claude-mem/claude-mem.db, WAL mode, worker
 * tables `observations` (the main memory record: title/subtitle/text/
 * narrative + facts/concepts as JSON-encoded TEXT arrays, per-record
 * `project` name) and `session_summaries` (request/learned/completed/
 * next_steps). A server-beta schema (v13+, opt-in) unifies them into
 * `memory_items` — preferred when present with rows. v3-era leftovers
 * (index/*.jsonl) are read best-effort. Skipped by design: chroma/
 * vectors (derived — Waykeep re-embeds), FTS mirrors, sync_* tables,
 * user_prompts (raw prompt text is noise, not lessons), archives/.
 *
 * Safety: the worker daemon may be LIVE against this DB — the importer
 * takes a single atomic VACUUM INTO snapshot (readonly source
 * connection) and reads the copy readonly.
 * Column sets vary across their schema_versions 4-49, so every read
 * selects defensively via PRAGMA table_info.
 *
 * Mapping: observations → one memory each (title — subtitle: text|
 * narrative), kind from wording (their `type` travels as a tag);
 * summaries → the `learned` field (the distilled gold), kind fact.
 * Their `project` is a NAME, not a Waykeep project id — it becomes a
 * `src-project:` tag; --project scopes the batch if wanted.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import DatabaseCtor from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';
import { LIMITS, IMPORT } from '../constants/index.js';
import { scrubSecrets } from '../utils/secret-scanner.js';
import type { LearnSection } from './learn-pipeline.js';
import { inferKind, slugTag } from './shared.js';
import { robustHomedir } from '../constants/paths.js';

export interface ClaudeMemImport {
  sections: LearnSection[];
  excluded?: Array<{ name: string; reason: string }>;
  notes: string[];
}

function parseJsonArray(raw: unknown): string[] {
  if (typeof raw !== 'string' || raw.length === 0) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function columnsOf(db: DatabaseType, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name));
}

function tableNames(db: DatabaseType): Set<string> {
  return new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((t) => t.name));
}

function clip(text: string): string {
  // Scrub BEFORE the cap — a clip of raw text can leave a partial
  // credential the scrubber no longer matches (closing review).
  return scrubSecrets(text.replace(/\s+/g, ' ').trim()).text.slice(0, LIMITS.MAX_CONTENT_CHARS);
}

function fromObservationRow(row: Record<string, unknown>): LearnSection | null {
  const title = typeof row.title === 'string' ? row.title.trim() : '';
  const subtitle = typeof row.subtitle === 'string' ? row.subtitle.trim() : '';
  const body = [row.text, row.narrative].find((v): v is string => typeof v === 'string' && v.trim().length > 0)?.trim()
    ?? parseJsonArray(row.facts).join('; ');
  const headline = [title, subtitle].filter(Boolean).join(' — ');
  const content = clip([headline, body].filter(Boolean).join(': '));
  if (content.length < IMPORT.MIN_SECTION_CHARS) return null;
  const tags = ['import:claude-mem'];
  if (typeof row.type === 'string' && row.type) tags.push(slugTag('type', row.type));
  if (typeof row.project === 'string' && row.project) tags.push(slugTag('src-project', row.project));
  tags.push(...parseJsonArray(row.concepts).slice(0, IMPORT.MAX_KEYWORD_TAGS));
  return { kind: inferKind(content), content, tags };
}

function fromSummaryRow(row: Record<string, unknown>): LearnSection | null {
  const learned = typeof row.learned === 'string' ? row.learned.trim() : '';
  if (learned.length < IMPORT.MIN_SECTION_CHARS) return null;
  const tags = ['import:claude-mem', 'session-summary'];
  if (typeof row.project === 'string' && row.project) tags.push(slugTag('src-project', row.project));
  return { kind: 'fact', content: clip(learned), tags };
}

function fromMemoryItemRow(row: Record<string, unknown>): LearnSection | null {
  // Server-beta unified shape mirrors observations closely, but carries
  // project_id where the worker schema carries project — normalize so
  // provenance is not dropped (review).
  if (row.kind === 'prompt') return null; // raw prompts are noise
  const normalized = { ...row, project: row.project ?? row.project_id };
  return fromObservationRow(normalized);
}

/** Consistent snapshot of a possibly-live WAL database. Sequential file
 *  copies RACE the writer's checkpointer — a TRUNCATE between the db and
 *  -wal copies yields a snapshot with ZERO tables, read as an empty
 *  archive and reported as success (review, reproduced). VACUUM INTO on
 *  a READONLY source connection is a single atomic database-level
 *  statement; the copy then opens readonly. */
function openSnapshot(dbPath: string, scratch: string): DatabaseType {
  const copy = join(scratch, 'claude-mem-snapshot.db');
  const source = new DatabaseCtor(dbPath, { readonly: true, fileMustExist: true });
  try {
    source.prepare('VACUUM INTO ?').run(copy);
  } finally {
    source.close();
  }
  return new DatabaseCtor(copy, { readonly: true });
}

export function transformClaudeMem(path?: string): ClaudeMemImport {
  const root = path ?? join(robustHomedir(), '.claude-mem');
  const sections: LearnSection[] = [];
  const excluded: Array<{ name: string; reason: string }> = [];
  const notes: string[] = [];

  const dbPath = existsSync(root) && statSync(root).isFile() ? root : join(root, 'claude-mem.db');
  if (!existsSync(dbPath)) {
    throw new Error(`claude-mem database not found at ${dbPath} (pass --path to the db or its directory)`);
  }

  const scratch = mkdtempSync(join(tmpdir(), 'waykeep-claude-mem-'));
  try {
    const db = openSnapshot(dbPath, scratch);
    try {
      const tables = tableNames(db);
      // A non-trivial source snapshotting to NOTHING recognizable is a
      // failure, never a quiet 'Nothing to import' (review) — UNLESS a
      // v3-era index/ exists beside it, in which case the JSONL reader
      // below is the legitimate path and must stay reachable (review
      // round 2: the loud check made the documented best-effort path
      // unreachable).
      if (![...tables].some((t) => ['observations', 'session_summaries', 'memory_items', 'sessions', 'memories'].includes(t))) {
        const v3Index = statSync(root).isDirectory() && existsSync(join(root, 'index'));
        if (!v3Index) {
          throw new Error(`no recognizable claude-mem tables in ${dbPath} (found: ${[...tables].join(', ') || 'none'}) — is this really a claude-mem database?`);
        }
        notes.push('database has no recognizable tables — falling through to the v3 index/ JSONL reader');
      }
      const rowsOf = (table: string): Array<Record<string, unknown>> =>
        db.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>;

      // Server-beta unified table wins when populated (their importer
      // rule); memory_sources dedupe is unnecessary here because we then
      // skip the worker tables entirely.
      const memoryItems = tables.has('memory_items') ? rowsOf('memory_items') : [];
      // Preference keys on USABLE (non-prompt) rows: a memory_items
      // holding only prompt rows must not shadow the real worker archive
      // (review). Partial population is covered by memory_sources: worker
      // rows already represented there are skipped, the rest still import.
      const usableItems = memoryItems.filter((r) => r.kind !== 'prompt');
      if (usableItems.length > 0) {
        let count = 0;
        for (const row of memoryItems) {
          const section = fromMemoryItemRow(row);
          if (section) { sections.push(section); count++; }
        }
        notes.push(`memory_items (server-beta schema): ${count} of ${memoryItems.length} imported`);
        // Guard the diff on the columns actually existing — keying on a
        // renamed column would silently produce 'undefined:undefined'
        // keys, match nothing, and DOUBLE-import every worker row
        // (review). Case-normalized both sides (review).
        const sourcesUsable = tables.has('memory_sources')
          && ['legacy_table', 'legacy_id'].every((c) => columnsOf(db, 'memory_sources').has(c));
        const migrated = sourcesUsable
          ? new Set((rowsOf('memory_sources')).map((r) => `${String(r.legacy_table).toLowerCase()}:${String(r.legacy_id)}`))
          : null;
        if (migrated) {
          let extra = 0;
          if (tables.has('observations')) {
            for (const row of rowsOf('observations')) {
              if (migrated.has(`observations:${String(row.id)}`)) continue;
              const section = fromObservationRow(row);
              if (section) { sections.push(section); extra++; }
            }
          }
          if (tables.has('session_summaries') && columnsOf(db, 'session_summaries').has('learned')) {
            for (const row of rowsOf('session_summaries')) {
              if (migrated.has(`session_summaries:${String(row.id)}`)) continue;
              const section = fromSummaryRow(row);
              if (section) { sections.push(section); extra++; }
            }
          }
          notes.push(`worker tables: ${extra} not-yet-migrated row(s) imported via memory_sources diff`);
        } else {
          notes.push('worker tables skipped (memory_items populated, no memory_sources to diff — gateway dedup covers overlap)');
        }
      } else {
        if (tables.has('observations')) {
          let count = 0;
          for (const row of rowsOf('observations')) {
            const section = fromObservationRow(row);
            if (section) { sections.push(section); count++; }
          }
          notes.push(`observations: ${count} imported`);
        }
        if (tables.has('session_summaries') && columnsOf(db, 'session_summaries').has('learned')) {
          let count = 0;
          for (const row of rowsOf('session_summaries')) {
            const section = fromSummaryRow(row);
            if (section) { sections.push(section); count++; }
          }
          notes.push(`session_summaries: ${count} learned-field summaries imported`);
        }
      }
      if (tables.has('user_prompts')) excluded.push({ name: 'user_prompts', reason: 'raw prompt text — not lessons' });
      if (tables.has('sync_state') || [...tables].some((t) => t.startsWith('sync_'))) {
        excluded.push({ name: 'sync_* tables', reason: 'sync bookkeeping' });
      }
    } finally {
      db.close();
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  // v3-era JSONL leftovers (best-effort extras).
  const indexDir = statSync(root).isDirectory() ? join(root, 'index') : null;
  if (indexDir && existsSync(indexDir)) {
    for (const name of readdirSync(indexDir).filter((n) => n.endsWith('.jsonl'))) {
      let count = 0;
      for (const line of readFileSync(join(indexDir, name), 'utf-8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const record = JSON.parse(line) as Record<string, unknown>;
          const text = [record.content, record.summary, record.text].find((v): v is string => typeof v === 'string') ?? '';
          const content = clip(text);
          if (content.length >= IMPORT.MIN_SECTION_CHARS) {
            sections.push({ kind: inferKind(content), content, tags: ['import:claude-mem', 'v3-index'] });
            count++;
          }
        } catch { /* tolerant: unrecognized lines skipped */ }
      }
      notes.push(`index/${basename(name)} (v3 era): ${count} record(s)`);
    }
  }
  if (statSync(root).isDirectory() && existsSync(join(root, 'chroma'))) {
    excluded.push({ name: 'chroma/', reason: 'derived vectors — Waykeep re-embeds' });
  }

  return { sections, excluded, notes };
}
