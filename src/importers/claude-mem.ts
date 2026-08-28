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
 * vectors (derived — Cairn re-embeds), FTS mirrors, sync_* tables,
 * user_prompts (raw prompt text is noise, not lessons), archives/.
 *
 * Safety: the worker daemon may be LIVE against this DB — we snapshot-
 * copy db + -wal + -shm to a temp dir and open the copy readonly.
 * Column sets vary across their schema_versions 4-49, so every read
 * selects defensively via PRAGMA table_info.
 *
 * Mapping: observations → one memory each (title — subtitle: text|
 * narrative), kind from wording (their `type` travels as a tag);
 * summaries → the `learned` field (the distilled gold), kind fact.
 * Their `project` is a NAME, not a Cairn project id — it becomes a
 * `src-project:` tag; --project scopes the batch if wanted.
 */
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import DatabaseCtor from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';
import { LIMITS, IMPORT } from '../constants/index.js';
import type { LearnSection } from './learn-pipeline.js';

export interface ClaudeMemImport {
  sections: LearnSection[];
  excluded?: Array<{ name: string; reason: string }>;
  notes: string[];
}

function slugTag(prefix: string, value: string): string {
  return `${prefix}:${value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)}`;
}

function inferKind(text: string): LearnSection['kind'] {
  if (/\b(never|avoid|don'?t|broke|breaks|fails?|error|race|leak|crash|bug)\b/i.test(text)) return 'pitfall';
  if (/\b(chose|decided|prefer(red)?|opted|instead of)\b/i.test(text)) return 'decision';
  return 'fact';
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
  return text.replace(/\s+/g, ' ').trim().slice(0, LIMITS.MAX_CONTENT_CHARS);
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
  // Server-beta unified shape mirrors observations closely.
  if (row.kind === 'prompt') return null; // raw prompts are noise
  return fromObservationRow(row);
}

/** Snapshot-copy a possibly-live WAL database and open the copy. */
function openSnapshot(dbPath: string, scratch: string): DatabaseType {
  const copy = join(scratch, 'claude-mem-snapshot.db');
  copyFileSync(dbPath, copy);
  for (const suffix of ['-wal', '-shm']) {
    if (existsSync(dbPath + suffix)) copyFileSync(dbPath + suffix, copy + suffix);
  }
  return new DatabaseCtor(copy, { readonly: false }); // WAL replay needs write on the COPY
}

export function transformClaudeMem(path?: string): ClaudeMemImport {
  const root = path ?? join(homedir(), '.claude-mem');
  const sections: LearnSection[] = [];
  const excluded: Array<{ name: string; reason: string }> = [];
  const notes: string[] = [];

  const dbPath = existsSync(root) && statSync(root).isFile() ? root : join(root, 'claude-mem.db');
  if (!existsSync(dbPath)) {
    throw new Error(`claude-mem database not found at ${dbPath} (pass --path to the db or its directory)`);
  }

  const scratch = mkdtempSync(join(tmpdir(), 'cairn-claude-mem-'));
  try {
    const db = openSnapshot(dbPath, scratch);
    try {
      const tables = tableNames(db);
      const rowsOf = (table: string): Array<Record<string, unknown>> =>
        db.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>;

      // Server-beta unified table wins when populated (their importer
      // rule); memory_sources dedupe is unnecessary here because we then
      // skip the worker tables entirely.
      const memoryItems = tables.has('memory_items') ? rowsOf('memory_items') : [];
      if (memoryItems.length > 0) {
        let count = 0;
        for (const row of memoryItems) {
          const section = fromMemoryItemRow(row);
          if (section) { sections.push(section); count++; }
        }
        notes.push(`memory_items (server-beta schema): ${count} of ${memoryItems.length} imported`);
        notes.push('worker tables skipped (memory_items supersedes them)');
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
    excluded.push({ name: 'chroma/', reason: 'derived vectors — Cairn re-embeds' });
  }

  return { sections, excluded, notes };
}
