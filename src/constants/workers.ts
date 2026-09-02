// ============================================================================
// Consolidation and MCP server background workers
// ============================================================================

// --- Consolidation ----------------------------------------------------------

export const CONSOLIDATION = {
  /** Minimum affinity score to merge two memories */
  AFFINITY_THRESHOLD: 0.7,
  /** Max memories to process per kind per consolidation run */
  MAX_PER_KIND: 50,
  /** Only consolidate kinds that benefit from merging */
  ELIGIBLE_KINDS: ['pitfall', 'decision', 'fact'] as readonly string[],
  /** Min age (days) before a memory is eligible for consolidation */
  MIN_AGE_DAYS: 7,
  /** Weight for embedding cosine similarity when both embeddings available */
  EMBEDDING_WEIGHT: 0.5,
  /** Weight for token overlap when embeddings are available (reduced from 0.7) */
  TOKEN_OVERLAP_WITH_EMBEDDING: 0.2,
  /** Weight for temporal proximity when embeddings are available */
  TEMPORAL_WEIGHT: 0.3,
  /** Max memories auto-promoted to global scope per maintenance run */
  MAX_AUTO_PROMOTIONS: 3,
  /** Age (days) past which co_occurred edges are pruned */
  CO_OCCURRENCE_PRUNE_DAYS: 90,
} as const;

// --- MCP Server Background Workers -------------------------------------------

export const EMBEDDING_BACKFILL = {
  /** Max wait for the embedding model to warm up before skipping backfill */
  MODEL_WARMUP_MAX_WAIT_MS: 30_000,
  /** Poll interval while waiting for model warmup */
  WARMUP_POLL_MS: 500,
  /** Memories embedded per backfill batch */
  BATCH_SIZE: 10,
  /** Pause between batches so backfill doesn't hog the event loop */
  BATCH_PAUSE_MS: 100,
} as const;

export const CONTEXT_VECTOR = {
  /** Rolling-context-vector worker tick interval */
  INTERVAL_MS: 5_000,
  /** Blend weight of the newest prompt embedding */
  BLEND_NEW: 0.7,
  /** Blend weight of the previous rolling vector */
  BLEND_PREV: 0.3,
  /** Drop a pending prompt after this many failed embedding attempts */
  MAX_RETRIES: 3,
} as const;
