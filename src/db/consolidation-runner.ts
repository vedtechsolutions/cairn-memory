/**
 * Consolidation and auto-promotion sweeps: embedding similarity over the
 * candidate set, per-cluster atomic merges that respect sync-bound rows, and
 * the guarded cross-project promotion. Split from maintenance.ts (phase 4).
 */
import type Database from 'better-sqlite3';
import { CONSOLIDATION } from '../constants/index.js';
import { buildFtsQuery, tokenOverlap } from '../utils/index.js';
import { MemoryRepository, type Memory } from './memory-repository.js';
import { EdgeRepository } from './edge-repository.js';
import { findConsolidationCandidates, mergedConfidence, mergedTags, type EmbeddingSimilarityMap } from '../utils/consolidation.js';
import { bufferToEmbedding, getEmbeddingModelConfig } from '../utils/embeddings.js';
import { cosineSimilarity } from '../utils/similarity.js';
import {
  journalUpsertForId, retireIdsByInvalidation, syncBoundIds,
} from './memory-repository/journal.js';
import { promote as promoteToGlobal } from './memory-repository/writes.js';

/** Build a map of pre-computed embedding cosine similarities between memory pairs.
 *  Reads embedding BLOBs from the DB (no model needed — works in hook processes).
 *  Only computes similarities for pairs where BOTH memories have ACTIVE-model
 *  embeddings (v26 isolation). Exported for the isolation test suite. */
export function buildEmbeddingSimilarityMap(
  db: Database.Database,
  memories: Memory[],
): EmbeddingSimilarityMap {
  const map: EmbeddingSimilarityMap = new Map();
  if (memories.length < 2) return map;

  // Batch-fetch embeddings for all memory IDs. Model isolation (v26): only
  // active-model vectors are pairwise-comparable — a stale-model row simply
  // has no embedding similarity, same as a missing embedding.
  const ids = memories.map(m => m.id);
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT id, embedding FROM memories
    WHERE id IN (${placeholders}) AND embedding IS NOT NULL AND embedding_model = ?
  `).all(...ids, getEmbeddingModelConfig().key) as Array<{ id: string; embedding: Buffer }>;

  // Convert to Float32Array lookup
  const embeddings = new Map<string, Float32Array>();
  for (const row of rows) {
    try {
      embeddings.set(row.id, bufferToEmbedding(row.embedding));
    } catch { /* malformed embedding — skip */ }
  }

  // Compute cosine similarity for all pairs that have embeddings
  for (let i = 0; i < memories.length; i++) {
    const embA = embeddings.get(memories[i].id);
    if (!embA) continue;
    for (let j = i + 1; j < memories.length; j++) {
      const embB = embeddings.get(memories[j].id);
      if (!embB) continue;
      const key = memories[i].id < memories[j].id
        ? `${memories[i].id}:${memories[j].id}`
        : `${memories[j].id}:${memories[i].id}`;
      map.set(key, cosineSimilarity(embA, embB));
    }
  }

  return map;
}

/** Memory consolidation: cluster similar memories within each kind and merge.
 *  Creates 'refines' edges from cluster members to the merged representative. */
export function runConsolidation(db: Database.Database): { merged: number; clustersFound: number } {
  const repo = new MemoryRepository(db);
  const edgeRepo = new EdgeRepository(db);

  // One transaction per cluster merge (better-sqlite3 uses savepoints when
  // nested, so this is safe if a caller ever wraps runConsolidation itself).
  // Returns false when the cluster touched a bound row. The bound check
  // is INSIDE the write transaction (taken immediate at the call sites):
  // a pre-computed set is a stale snapshot another connection can defeat
  // between check and mutation (review: check/use race).
  const applyClusterMerge = db.transaction(
    (repId: string, newConf: number, newTagsJson: string, memberIds: string[]) => {
      if (syncBoundIds(db, [repId, ...memberIds]).size > 0) return false;
      db.prepare('UPDATE memories SET confidence = ?, tags = ? WHERE id = ?')
        .run(newConf, newTagsJson, repId);
      // Members are retired, not flag-flipped: consolidation is semantic
      // compression, so retirements tombstone-log + journal (journal.ts).
      retireIdsByInvalidation(db, memberIds);
      journalUpsertForId(db, repId);
      for (const memberId of memberIds) {
        edgeRepo.createEdge(memberId, repId, 'refines');
      }
      return true;
    },
  );

  let totalMerged = 0;
  let totalClusters = 0;

  // Process each eligible kind separately
  for (const kind of CONSOLIDATION.ELIGIBLE_KINDS) {
    // Get old-enough memories for this kind
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - CONSOLIDATION.MIN_AGE_DAYS);

    const rows = db.prepare(`
      SELECT id FROM memories
      WHERE invalidated = 0
        AND kind = ?
        AND created_at < ?
      ORDER BY confidence DESC
      LIMIT ?
    `).all(kind, cutoff.toISOString(), CONSOLIDATION.MAX_PER_KIND) as Array<{ id: string }>;

    // Batch-convert to Memory objects — one query, not one findById per row
    const memories: Memory[] = repo.findByIds(rows.map(r => r.id));
    if (memories.length < 2) continue;

    // Group by project for within-project consolidation
    const byProject = new Map<string | null, Memory[]>();
    for (const m of memories) {
      const key = m.project;
      const group = byProject.get(key) ?? [];
      group.push(m);
      byProject.set(key, group);
    }

    for (const [, projectMemories] of byProject) {
      if (projectMemories.length < 2) continue;

      // Pre-compute embedding cosine similarities for all pairs that have embeddings
      const embeddingSimilarities = buildEmbeddingSimilarityMap(db, projectMemories);

      const clusters = findConsolidationCandidates(projectMemories, CONSOLIDATION.AFFINITY_THRESHOLD, embeddingSimilarities);
      totalClusters += clusters.length;

      for (const cluster of clusters) {
        const rep = cluster.representative;
        const newConf = mergedConfidence(cluster);
        const newTags = mergedTags(cluster);
        const memberIds = cluster.members.filter(m => m.id !== rep.id).map(m => m.id);

        // Atomic per cluster: a crash between member invalidation and the
        // representative update would otherwise strand invalidated members
        // whose merged confidence/tags were never written. Immediate: the
        // in-transaction bound check must be authoritative, and a deferred
        // upgrade could deadlock against a concurrent binder. A cluster
        // touching ANY sync-bound row is skipped whole — invalidating a
        // bound member or rewriting a bound representative is exactly the
        // authority journal.ts bars (slice-3 review).
        if (applyClusterMerge.immediate(rep.id, newConf, JSON.stringify(newTags), memberIds)) {
          totalMerged += memberIds.length;
        }
      }
    }
  }

  // Step 7 (M5): co-recall→edge promotion REMOVED. memory_corecall's only
  // production feeder was the (diagnostic) MCP recall handler, so promoting
  // its pairs manufactured persistent co_occurred edges from contamination.
  // Step 8 re-sourced co-recall from genuine injection — promotion stays
  // removed anyway, DELIBERATELY: the pre-remediation pair data is still in
  // the table, and re-enabling over a mixed corpus is a future decision the
  // plan records, not a default.

  // Prune old co_occurred edges while we're at it
  edgeRepo.pruneOldCoOccurrences();

  return { merged: totalMerged, clustersFound: totalClusters };
}

/** Auto-promote memories that recur across multiple projects.
 *  Criteria: confidence >= 0.7, impact > 0, exists in 2+ projects, age > 60 days. */
export function runAutoPromotion(db: Database.Database): { promoted: number } {

  // Find high-confidence, high-impact, project-scoped memories old enough to promote
  const candidates = db.prepare(`
    SELECT id, content, kind, project, confidence, surface_count, impact_count
    FROM memories
    WHERE invalidated = 0
      AND project IS NOT NULL
      AND kind != 'rule'
      AND confidence >= 0.7
      AND impact_count > 0
      AND julianday('now') - julianday(created_at) > 60
    ORDER BY impact_count DESC, confidence DESC
    LIMIT 20
  `).all() as Array<{
    id: string; content: string; kind: string; project: string;
    confidence: number; surface_count: number; impact_count: number;
  }>;

  let promoted = 0;

  for (const candidate of candidates) {
    if (promoted >= CONSOLIDATION.MAX_AUTO_PROMOTIONS) break;

    // Check for cross-project near-duplicates via FTS
    const ftsQuery = buildFtsQuery(candidate.content);
    if (!ftsQuery) continue;

    let crossProjectRows: Array<{ project: string; content: string }>;
    try {
      crossProjectRows = db.prepare(`
        SELECT DISTINCT m.project, m.content FROM memories m
        JOIN memories_fts fts ON m.rowid = fts.rowid
        WHERE memories_fts MATCH ?
          AND m.invalidated = 0
          AND m.project IS NOT NULL
          AND m.project != ?
          AND m.kind = ?
        LIMIT 5
      `).all(ftsQuery, candidate.project, candidate.kind) as Array<{ project: string; content: string }>;
    } catch { continue; }

    // Verify with token overlap (FTS may have false positives)
    const confirmedProjects = crossProjectRows.filter(
      r => tokenOverlap(candidate.content, r.content) >= 0.4
    );

    if (confirmedProjects.length === 0) continue;

    // Content doesn't reference project-specific paths (simple heuristic)
    if (candidate.content.includes('/src/') || candidate.content.includes('/opt/')) continue;

    // Autonomous scope departure is barred for sync-bound rows — only the
    // user may pull a row out of the team's view (journal.ts). The check
    // runs INSIDE an immediate transaction with the promote so a
    // concurrent binder cannot slip between check and mutation.
    const guardedPromote = db.transaction((id: string): boolean => {
      if (syncBoundIds(db, [id]).size > 0) return false;
      // Journal-owning repository path (tombstone under the departing
      // project). No marker edge — a self-referential edge pollutes
      // graph-neighbor enrichment, where the promoted memory would
      // surface itself as its own neighbor on every recall.
      return promoteToGlobal(db, id);
    });
    if (guardedPromote.immediate(candidate.id)) promoted++;
  }

  return { promoted };
}
