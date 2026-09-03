/**
 * Memory consolidation — clusters similar memories and merges them.
 * Uses affinity-based agglomerative clustering (SimpleMem-inspired).
 * When embeddings are available, blends cosine similarity with token overlap
 * for better semantic matching of paraphrased content.
 */
import type { Memory } from '../db/memory-repository.js';
import { tokenOverlap } from './similarity.js';
import { CONSOLIDATION } from '../constants/index.js';
import { MS_PER_DAY } from '../constants/time.js';

export interface MemoryCluster {
  /** The memory with the highest confidence / longest content */
  representative: Memory;
  /** All cluster members (including the representative) */
  members: Memory[];
}

/**
 * Compute affinity between two memories.
 * When embeddingSimilarity is provided (both memories have embeddings):
 *   embedding cosine (50%) + token overlap (20%) + temporal (30%)
 * Without embeddings (fallback):
 *   token overlap (70%) + temporal (30%)
 */
export function computeAffinity(a: Memory, b: Memory, embeddingSimilarity?: number): number {
  const LAMBDA = 0.05; // Temporal decay per day

  // Content similarity via token overlap (bigram + unigram Jaccard)
  const tokenSim = tokenOverlap(a.content, b.content);

  // Temporal proximity — memories created close together are more related
  const daysBetween = Math.abs(
    (new Date(a.created_at).getTime() - new Date(b.created_at).getTime()) / MS_PER_DAY,
  );
  const temporal = Math.exp(-LAMBDA * daysBetween);

  // Blend embedding cosine when available — catches semantically similar but lexically different content
  if (embeddingSimilarity !== undefined) {
    return CONSOLIDATION.EMBEDDING_WEIGHT * embeddingSimilarity
      + CONSOLIDATION.TOKEN_OVERLAP_WITH_EMBEDDING * tokenSim
      + CONSOLIDATION.TEMPORAL_WEIGHT * temporal;
  }

  return 0.7 * tokenSim + 0.3 * temporal;
}

/** Pre-computed embedding similarity lookup keyed by "idA:idB" (sorted) */
export type EmbeddingSimilarityMap = Map<string, number>;

/** Build a canonical key for two memory IDs (sorted for consistency) */
function embeddingKey(idA: string, idB: string): string {
  return idA < idB ? `${idA}:${idB}` : `${idB}:${idA}`;
}

/**
 * Find clusters of similar memories using single-pass agglomerative clustering.
 * Only returns clusters with 2+ members (merge candidates).
 *
 * @param memories - memories to cluster (should be same kind + project)
 * @param threshold - minimum affinity to join a cluster (default: 0.7)
 * @param embeddingSimilarities - optional pre-computed cosine similarities between memory pairs
 */
export function findConsolidationCandidates(
  memories: Memory[],
  threshold: number = 0.7,
  embeddingSimilarities?: EmbeddingSimilarityMap,
): MemoryCluster[] {
  const clusters: MemoryCluster[] = [];

  for (const mem of memories) {
    let bestCluster: MemoryCluster | null = null;
    let bestScore = 0;

    for (const cluster of clusters) {
      const embSim = embeddingSimilarities?.get(embeddingKey(mem.id, cluster.representative.id));
      const score = computeAffinity(mem, cluster.representative, embSim);
      if (score > threshold && score > bestScore) {
        bestCluster = cluster;
        bestScore = score;
      }
    }

    if (bestCluster) {
      bestCluster.members.push(mem);
      // Update representative: prefer longer content or higher confidence
      if (
        mem.content.length > bestCluster.representative.content.length ||
        (mem.content.length === bestCluster.representative.content.length &&
          mem.confidence > bestCluster.representative.confidence)
      ) {
        bestCluster.representative = mem;
      }
    } else {
      clusters.push({ representative: mem, members: [mem] });
    }
  }

  // Only return clusters with 2+ members (actual merge candidates)
  return clusters.filter(c => c.members.length > 1);
}

/**
 * Compute merged confidence for a cluster.
 * Base = max confidence + 0.05 per additional member, capped at 1.0.
 */
export function mergedConfidence(cluster: MemoryCluster): number {
  const maxConf = Math.max(...cluster.members.map(m => m.confidence));
  const bonus = 0.05 * (cluster.members.length - 1);
  return Math.min(1.0, maxConf + bonus);
}

/**
 * Merge tags from all cluster members into a deduplicated set.
 */
export function mergedTags(cluster: MemoryCluster): string[] {
  const allTags = new Set<string>();
  for (const m of cluster.members) {
    for (const t of m.tags) allTags.add(t);
  }
  return [...allTags];
}
