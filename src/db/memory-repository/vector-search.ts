import type Database from 'better-sqlite3';
import { RELEVANCE, HYBRID_SEARCH } from '../../constants/index.js';
import { now } from '../../utils/index.js';
import { getEmbeddingModelConfig } from '../../utils/embeddings.js';
import { cosineSimilarity } from '../../utils/similarity.js';
import { isSqliteVecAvailable } from '../connection.js';
import type { Memory, RecallOptions, RecallResult } from './types.js';
import { bufferToFloat32, findById } from './reads.js';
import { search } from './search.js';

/** Hybrid search: combines FTS5 keyword search + vector cosine search using RRF.
 *  queryEmbedding is optional — falls back to FTS-only if not provided. */
export function recallHybrid(
  db: Database.Database,
  queryText: string,
  queryEmbedding: Buffer | null,
  options: RecallOptions = {},
): RecallResult[] {
  const maxResults = options.maxResults ?? 5;
  const minConfidence = options.minConfidence ?? 0;
  const k = HYBRID_SEARCH.CANDIDATES_PER_RETRIEVER;

  // Stage 1: FTS candidates
  const ftsResults = search(db, queryText, { ...options, maxResults: k });

  // Stage 2: Vector candidates (if embedding available)
  const vecRanking = new Map<string, number>(); // id → rank
  if (queryEmbedding) {
    const vecIds = vectorSearch(db, queryEmbedding, options, k);
    vecIds.forEach((id, rank) => vecRanking.set(id, rank));
  }

  // Stage 3: RRF fusion
  const rrf_k = HYBRID_SEARCH.RRF_K;
  const scores = new Map<string, number>();
  const memoryMap = new Map<string, Memory>();

  // FTS contribution
  ftsResults.forEach(({ memory }, rank) => {
    const current = scores.get(memory.id) ?? 0;
    scores.set(memory.id, current + 1.0 / (rrf_k + rank + 1));
    memoryMap.set(memory.id, memory);
  });

  // Vector contribution
  for (const [id, rank] of vecRanking) {
    const current = scores.get(id) ?? 0;
    scores.set(id, current + 1.0 / (rrf_k + rank + 1));
    // Fetch memory if not already in map (came from vector-only)
    if (!memoryMap.has(id)) {
      const mem = findById(db, id);
      if (mem && mem.confidence >= minConfidence) memoryMap.set(id, mem);
    }
  }

  // Stage 4: Sort by fused score
  const results: RecallResult[] = [];
  for (const [id, score] of scores) {
    const memory = memoryMap.get(id);
    if (memory) results.push({ memory, score });
  }
  results.sort((a, b) => b.score - a.score);

  // Update recall stats for returned results (skipped in readOnly mode so
  // benchmark queries stay order-independent)
  const sliced = results.slice(0, maxResults);
  if (options.readOnly) return sliced;

  const updateStmt = db.prepare(
    "UPDATE memories SET last_recalled = ?, recall_count = recall_count + 1 WHERE id = ? AND kind != 'rule'"
  );
  const timestamp = now();
  db.transaction(() => {
    for (const { memory } of sliced) {
      updateStmt.run(timestamp, memory.id);
    }
  })();

  return sliced;
}

/** Vector-only search: returns memory IDs ordered by cosine similarity.
 *  Uses sqlite-vec if available, otherwise JS fallback. */
export function vectorSearch(
  db: Database.Database,
  queryEmbedding: Buffer,
  options: RecallOptions,
  limit: number,
): string[] {
  const minConfidence = options.minConfidence ?? 0;
  // Model isolation (schema v26): only vectors produced by the ACTIVE model
  // are comparable — cross-model cosine is meaningless and mixed dims make
  // vec_distance_cosine a per-row runtime error.
  const modelKey = getEmbeddingModelConfig().key;

  if (isSqliteVecAvailable()) {
    // SQL-based vector search using sqlite-vec extension
    const rows = db.prepare(`
      SELECT id, vec_distance_cosine(embedding, ?) as distance
      FROM memories
      WHERE invalidated = 0 AND superseded_by IS NULL
        AND kind != 'rule'
        AND embedding IS NOT NULL
        AND embedding_model = ?
        AND confidence >= ?
        ${options.kind ? 'AND kind = ?' : ''}
        AND (project = ? OR project IS NULL)
      ORDER BY distance ASC
      LIMIT ?
    `).all(
      queryEmbedding,
      modelKey,
      minConfidence,
      ...(options.kind ? [options.kind] : []),
      options.project ?? null,
      limit,
    ) as Array<{ id: string; distance: number }>;
    return rows.map(r => r.id);
  }

  // JS fallback: load embeddings and compute cosine similarity.
  // Capped — an unbounded scan decodes every stored embedding in JS and
  // blocks the event loop as the store grows.
  const rows = db.prepare(`
    SELECT id, embedding FROM memories
    WHERE invalidated = 0 AND superseded_by IS NULL
      AND kind != 'rule'
      AND embedding IS NOT NULL
      AND embedding_model = ?
      AND confidence >= ?
      ${options.kind ? 'AND kind = ?' : ''}
      AND (project = ? OR project IS NULL)
    ORDER BY confidence DESC
    LIMIT ?
  `).all(
    modelKey,
    minConfidence,
    ...(options.kind ? [options.kind] : []),
    options.project ?? null,
    RELEVANCE.VECTOR_FALLBACK_SCAN_LIMIT,
  ) as Array<{ id: string; embedding: Buffer }>;

  const queryEmb = bufferToFloat32(queryEmbedding);
  const scored = rows.map(r => ({
    id: r.id,
    similarity: cosineSimilarity(queryEmb, bufferToFloat32(r.embedding)),
  }));
  scored.sort((a, b) => b.similarity - a.similarity);
  return scored.slice(0, limit).map(r => r.id);
}

/** Proxy vector search: use a stored memory's embedding to find semantically related memories.
 *  Designed for hook processes that can't compute new embeddings (no model loaded).
 *  Returns memories similar to the proxy, excluding already-known IDs. */
export function searchByProxyEmbedding(
  db: Database.Database,
  proxyMemoryId: string,
  excludeIds: Set<string>,
  options: RecallOptions = {},
): RecallResult[] {
  const maxResults = options.maxResults ?? 3;

  // Get the proxy memory's embedding — it must belong to the ACTIVE model,
  // or the comparison against current-model vectors is meaningless.
  const proxyRow = db.prepare(
    "SELECT embedding FROM memories WHERE id = ? AND kind != 'rule' AND embedding IS NOT NULL AND embedding_model = ?"
  ).get(proxyMemoryId, getEmbeddingModelConfig().key) as { embedding: Buffer } | undefined;
  if (!proxyRow) return [];

  // Use vectorSearch (works with sqlite-vec or JS fallback)
  const candidateIds = vectorSearch(db, proxyRow.embedding, options, maxResults + excludeIds.size);

  // Fetch and filter
  const results: RecallResult[] = [];
  for (const id of candidateIds) {
    if (excludeIds.has(id) || id === proxyMemoryId) continue;
    if (results.length >= maxResults) break;
    const mem = findById(db, id);
    if (mem && !mem.invalidated) {
      results.push({ memory: mem, score: 0.5 }); // Normalized proxy score
    }
  }
  return results;
}
