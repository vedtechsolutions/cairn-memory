/**
 * Session-end consolidation ("dream"): strengthen proven memories, weaken
 * unproven ones, merge near-duplicates per cluster atomically. Split from
 * session-end.ts (phase 4).
 */
import type { HookDbClient } from '../db-client.js';
import { CONFIDENCE, CONSOLIDATION } from '../../../constants/index.js';
import { journalUpsertForId, retireIdsByInvalidation, syncBoundIds } from '../../../db/memory-repository/journal.js';
import { findConsolidationCandidates, mergedConfidence, mergedTags } from '../../../utils/consolidation.js';

/** Session-end consolidation — lightweight "dream" pass.
 *  1. Strengthen memories that were surfaced AND led to successful outcomes
 *  2. Weaken memories surfaced many times with zero impact (noise)
 *  3. Merge near-duplicate memories within same kind+project */
export function runSessionConsolidation(
  client: HookDbClient,
  project: string,
): void {
  const UNPROVEN_THRESHOLD = 5;

  // 1. Strengthen proven memories (surfaced + impacted this project)
  client.db.prepare(`
    UPDATE memories SET confidence = MIN(1.0, confidence + ?)
    WHERE project = ? AND invalidated = 0
      AND kind != 'rule'
      AND impact_count > 0 AND surface_count > 0
      AND confidence < 1.0
  `).run(CONFIDENCE.STRENGTHEN_INCREMENT, project);

  // 2. Weaken unproven memories (surfaced many times, zero impact)
  client.db.prepare(`
    UPDATE memories SET confidence = confidence * ?
    WHERE project = ? AND invalidated = 0
      AND kind != 'rule'
      AND surface_count >= ? AND impact_count = 0
      AND confidence > ?
  `).run(CONFIDENCE.WEAKEN_FACTOR, project, UNPROVEN_THRESHOLD, CONFIDENCE.DELETE_THRESHOLD);

  // 3. Merge near-duplicate memories (same kind, same project, high affinity)
  for (const kind of CONSOLIDATION.ELIGIBLE_KINDS) {
    const candidates = client.db.prepare(`
      SELECT * FROM memories
      WHERE project = ? AND kind = ? AND invalidated = 0
        AND julianday('now') - julianday(created_at) >= ?
      ORDER BY confidence DESC
      LIMIT ?
    `).all(project, kind, CONSOLIDATION.MIN_AGE_DAYS, CONSOLIDATION.MAX_PER_KIND) as Array<{
      id: string; content: string; kind: string; project: string | null;
      tags: string | null; confidence: number; source: string; created_at: string;
      last_recalled: string | null; recall_count: number; invalidated: number;
      surface_count: number; impact_count: number; fingerprint: string | null;
      context: string | null; anchor: string | null; revision: number;
    }>;

    // Convert rows to Memory objects for consolidation
    const memories = candidates.map(row => ({
      id: row.id,
      content: row.content,
      kind: row.kind as import('../../../constants/index.js').MemoryKind,
      project: row.project,
      tags: JSON.parse(row.tags ?? '[]') as string[],
      confidence: row.confidence,
      source: row.source as import('../../../constants/index.js').MemorySource,
      created_at: row.created_at,
      last_recalled: row.last_recalled,
      recall_count: row.recall_count,
      invalidated: row.invalidated,
      surface_count: row.surface_count,
      impact_count: row.impact_count,
      fingerprint: row.fingerprint ? JSON.parse(row.fingerprint) : null,
      context: row.context ? JSON.parse(row.context) : null,
      anchor: row.anchor ?? null,
      author: (row as { author?: string | null }).author ?? null,
      revision: row.revision,
    }));

    const clusters = findConsolidationCandidates(memories, CONSOLIDATION.AFFINITY_THRESHOLD);

    // Atomic per cluster like maintenance.ts's applyClusterMerge: a crash
    // between member retirement and the representative rewrite must not
    // strand half a merge, and no journal write may commit outside its
    // mutation's transaction (journal.ts invariant). The bound check runs
    // INSIDE the write transaction — a pre-computed set is a stale
    // snapshot a concurrent binder can defeat (review) — and the
    // transaction is taken immediate so that check is authoritative.
    const applyClusterMerge = client.db.transaction(
      (repId: string, newConf: number, newTagsJson: string, memberIds: string[]) => {
        // Autonomous semantic compression never touches team-visible
        // rows: a cluster containing ANY sync-bound row is skipped whole.
        if (syncBoundIds(client.db, [repId, ...memberIds]).size > 0) return false;
        client.db.prepare('UPDATE memories SET confidence = ?, tags = ? WHERE id = ?')
          .run(newConf, newTagsJson, repId);
        journalUpsertForId(client.db, repId);
        retireIdsByInvalidation(client.db, memberIds);
        return true;
      },
    );

    for (const cluster of clusters) {
      const rep = cluster.representative;
      const newConf = mergedConfidence(cluster);
      const newTags = mergedTags(cluster);

      const memberIds = cluster.members.filter(m => m.id !== rep.id).map(m => m.id);
      if (!applyClusterMerge.immediate(rep.id, newConf, JSON.stringify(newTags), memberIds)) continue;
      for (const memberId of memberIds) {
        // Create supersedes edge: source=OLD(invalidated), target=NEW(representative)
        // Convention: "target replaces source" (edge-repository.ts:9)
        try {
          client.db.prepare(`
            INSERT OR IGNORE INTO memory_edges (source_id, target_id, relation, weight, created_at)
            VALUES (?, ?, 'supersedes', 1.0, datetime('now'))
          `).run(memberId, rep.id);
        } catch { /* edge creation is best-effort */ }
      }
    }
  }
}
