import type Database from 'better-sqlite3';
import type { MemoryKind, MemorySource } from '../../constants/index.js';
import { getEmbeddingModelConfig } from '../../utils/embeddings.js';
import { now } from '../../utils/index.js';
import type { Memory, MemoryRow } from './types.js';

// --- Row mapping --------------------------------------------------------------

export function rowToMemory(row: MemoryRow): Memory {
  return {
    id: row.id,
    content: row.content,
    author: (row as { author?: string | null }).author ?? null,
    origin_client: (row as { origin_client?: string }).origin_client,
    share_state: (row as { share_state?: string | null }).share_state ?? null,
    kind: row.kind as MemoryKind,
    project: row.project,
    tags: row.tags ? JSON.parse(row.tags) : [],
    confidence: row.confidence,
    source: row.source as MemorySource,
    created_at: row.created_at,
    last_recalled: row.last_recalled,
    recall_count: row.recall_count,
    invalidated: row.invalidated,
    surface_count: row.surface_count ?? 0,
    impact_count: row.impact_count ?? 0,
    fingerprint: row.fingerprint ? JSON.parse(row.fingerprint) : null,
    context: row.context ? JSON.parse(row.context) : null,
    anchor: row.anchor,
    superseded_by: row.superseded_by ?? null,
    superseded_at: row.superseded_at ?? null,
    // No fallback: v27 guarantees the column — a missing value means an
    // incomplete SELECT or schema drift, which must surface, not be masked
    // (a manufactured revision would silently defeat the CAS contract).
    revision: row.revision,
  };
}

/** Convert a SQLite BLOB Buffer to Float32Array */
export function bufferToFloat32(buf: Buffer): Float32Array {
  const copy = new ArrayBuffer(buf.length);
  const view = new Uint8Array(copy);
  for (let i = 0; i < buf.length; i++) view[i] = buf[i];
  return new Float32Array(copy);
}

// --- Lookups -------------------------------------------------------------------

export function findById(db: Database.Database, id: string): Memory | null {
  const row = db.prepare("SELECT * FROM memories WHERE id = ? AND kind != 'rule'").get(id) as MemoryRow | undefined;
  return row ? rowToMemory(row) : null;
}

/** Batch lookup — one query instead of N findById round-trips.
 *  Ordered by confidence DESC to match consolidation's candidate ordering. */
export function findByIds(db: Database.Database, ids: string[]): Memory[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT * FROM memories WHERE id IN (${placeholders}) AND kind != 'rule' ORDER BY confidence DESC`
  ).all(...ids) as MemoryRow[];
  return rows.map(r => rowToMemory(r));
}

/** Resolve a memory by its short-id prefix (first N chars of the full id).
 *  Used by waykeep_expand to map briefing index entries like "pit:a1b2c3d4"
 *  back to full memory rows. Returns null if zero or multiple rows match
 *  the prefix — short-id collisions are rare at 8 chars over thousands of
 *  memories but the caller should treat ambiguous results as "not found"
 *  rather than guessing. */
export function findByShortId(db: Database.Database, shortId: string): Memory | null {
  if (!shortId || shortId.length < 4) return null;
  const rows = db.prepare(
    "SELECT * FROM memories WHERE id LIKE ? AND kind != 'rule' LIMIT 2"
  ).all(`${shortId}%`) as MemoryRow[];
  if (rows.length !== 1) return null;
  return rowToMemory(rows[0]);
}

// --- Embedding accessors ---------------------------------------------------------

/** True only when the memory has an ACTIVE-model embedding (v26 isolation).
 *  A foreign-model vector counts as absent — callers that gate "should I
 *  write the incoming embedding?" must overwrite stale vectors, and callers
 *  that gate "can I compare?" must not compare cross-model. */
export function hasEmbedding(db: Database.Database, memoryId: string): boolean {
  const row = db.prepare(
    "SELECT 1 AS has FROM memories WHERE id = ? AND kind != 'rule' AND embedding IS NOT NULL AND embedding_model = ?"
  ).get(memoryId, getEmbeddingModelConfig().key) as { has: number } | undefined;
  return row?.has === 1;
}

/** Get a memory's raw embedding buffer for cosine comparison (no model
 *  load). ACTIVE-model only (v26): a foreign-model vector returns null —
 *  cross-model cosine is meaningless. */
export function getEmbedding(db: Database.Database, id: string): Buffer | null {
  const row = db.prepare(
    "SELECT embedding FROM memories WHERE id = ? AND kind != 'rule' AND invalidated = 0 AND embedding_model = ?"
  ).get(id, getEmbeddingModelConfig().key) as { embedding: Buffer | null } | undefined;
  return row?.embedding ?? null;
}

/** Bump recall stats for exactly these ids — used by the rerank path,
 *  which fetches a wide candidate pool read-only and must apply recall
 *  side effects only to the memories actually returned to the caller. */
export function markRecalled(db: Database.Database, ids: string[]): void {
  if (ids.length === 0) return;
  const stmt = db.prepare("UPDATE memories SET last_recalled = ?, recall_count = recall_count + 1 WHERE id = ? AND kind != 'rule'");
  const timestamp = now();
  const run = db.transaction(() => {
    for (const id of ids) stmt.run(timestamp, id);
  });
  run();
}

/** Store embedding for an existing memory (used by backfill) — stamps the
 *  active model so vector reads can enforce model isolation (schema v26). */
export function storeEmbedding(db: Database.Database, id: string, embedding: Buffer): boolean {
  const result = db.prepare(
    "UPDATE memories SET embedding = ?, embedding_model = ? WHERE id = ? AND invalidated = 0 AND kind != 'rule'"
  ).run(embedding, getEmbeddingModelConfig().key, id);
  return result.changes > 0;
}

/** Get memories needing (re-)embedding for backfill: no embedding at all, OR
 *  an embedding produced by a different model — a model switch re-embeds the
 *  store in batches while FTS+RRF carry retrieval during the transition. */
export function memoriesWithoutEmbeddings(db: Database.Database, limit: number): Array<{ id: string; content: string }> {
  return db.prepare(`
    SELECT id, content FROM memories
    WHERE invalidated = 0
      AND kind != 'rule'
      AND (embedding IS NULL OR COALESCE(embedding_model, '') != ?)
    ORDER BY confidence DESC
    LIMIT ?
  `).all(getEmbeddingModelConfig().key, limit) as Array<{ id: string; content: string }>;
}
