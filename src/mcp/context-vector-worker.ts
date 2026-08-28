/**
 * Rolling context-vector worker. Hooks write pending_prompt rows; this
 * worker (MCP server only — hooks never load the model) embeds each prompt
 * query-side and blends it into a per-project rolling vector
 * (0.7 new + 0.3 previous).
 *
 * Model isolation (schema v26): the stored vector carries embedding_model.
 * A previous vector from a DIFFERENT model is discarded, not blended —
 * cross-model blending is meaningless and a dim mismatch would corrupt the
 * buffer. Every write stamps the active model.
 */
import type Database from 'better-sqlite3';
import { CONTEXT_VECTOR } from '../constants/index.js';
import {
  embed, embeddingToBuffer, getEmbeddingModelConfig, isEmbeddingReady,
} from '../utils/embeddings.js';

interface PendingRow {
  project: string;
  pending_prompt: string;
  embedding: Buffer | null;
  embedding_model: string | null;
}

/** Injection seam for tests — production always uses the real model. */
export interface WorkerDeps {
  embedQueryText?: (text: string) => Promise<Float32Array>;
  isReady?: () => boolean;
}

/** One worker pass over all pending prompts. Exported for tests; production
 *  runs it on the startContextVectorWorker interval. */
export async function processContextVectors(
  db: Database.Database,
  failCounts: Map<string, number> = new Map(),
  deps: WorkerDeps = {},
): Promise<void> {
  const ready = deps.isReady ?? isEmbeddingReady;
  const embedQueryText = deps.embedQueryText ?? ((text: string) => embed(text, 'query'));
  if (!ready()) return;
  const config = getEmbeddingModelConfig();

  const pending = db.prepare(
    'SELECT project, pending_prompt, embedding, embedding_model FROM context_vectors WHERE pending_prompt IS NOT NULL'
  ).all() as PendingRow[];

  for (const row of pending) {
    try {
      const newEmb = await embedQueryText(row.pending_prompt);
      let blended: Float32Array;

      if (row.embedding && row.embedding_model === config.key) {
        // Blend with existing same-model context vector
        const prev = new Float32Array(
          row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4,
        );
        blended = new Float32Array(config.dim);
        for (let i = 0; i < config.dim; i++) {
          blended[i] = CONTEXT_VECTOR.BLEND_NEW * newEmb[i] + CONTEXT_VECTOR.BLEND_PREV * prev[i];
        }
        // Normalize
        let norm = 0;
        for (let i = 0; i < config.dim; i++) norm += blended[i] * blended[i];
        norm = Math.sqrt(norm);
        if (norm > 0) for (let i = 0; i < config.dim; i++) blended[i] /= norm;
      } else {
        // No previous vector, or a stale-model one — start fresh
        blended = newEmb;
      }

      // Optimistic update: only clear if prompt hasn't changed (avoids dropping newer prompt)
      db.prepare(`
        UPDATE context_vectors
        SET embedding = ?, embedding_model = ?, pending_prompt = NULL, updated_at = datetime('now')
        WHERE project = ? AND pending_prompt = ?
      `).run(embeddingToBuffer(blended), config.key, row.project, row.pending_prompt);
      failCounts.delete(row.project);
    } catch {
      // Retry up to CONTEXT_VECTOR.MAX_RETRIES before discarding — handles transient model failures
      const count = (failCounts.get(row.project) ?? 0) + 1;
      failCounts.set(row.project, count);
      if (count >= CONTEXT_VECTOR.MAX_RETRIES) {
        db.prepare('UPDATE context_vectors SET pending_prompt = NULL WHERE project = ? AND pending_prompt = ?')
          .run(row.project, row.pending_prompt);
        failCounts.delete(row.project);
      }
    }
  }
}

/** Start the periodic worker (every CONTEXT_VECTOR.INTERVAL_MS). */
export function startContextVectorWorker(db: Database.Database): void {
  const failCounts = new Map<string, number>();
  setInterval(() => { processContextVectors(db, failCounts).catch(() => {}); }, CONTEXT_VECTOR.INTERVAL_MS);
}
