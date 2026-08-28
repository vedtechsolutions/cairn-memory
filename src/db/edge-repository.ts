/**
 * Memory edge repository — manages relationships between memories.
 * Edges form a knowledge graph: supersedes, refines, contradicts, caused_by, etc.
 */
import type Database from 'better-sqlite3';
import { now } from '../utils/index.js';
import { CONSOLIDATION } from '../constants/index.js';

export const EDGE_RELATIONS = [
  'supersedes',   // target replaces source (evolution)
  'refines',      // target adds detail to source
  'contradicts',  // target conflicts with source
  'caused_by',    // target was caused by source (error → pitfall)
  'informs',      // source provides context for target
  'co_occurred',  // appeared in same session/context
  'generalizes',  // target is a cross-project generalization of source
] as const;

export type EdgeRelation = (typeof EDGE_RELATIONS)[number];

export interface MemoryEdge {
  source_id: string;
  target_id: string;
  relation: EdgeRelation;
  weight: number;
  created_at: string;
}

export class EdgeRepository {
  constructor(private db: Database.Database) {}

  /** Create an edge between two memories */
  createEdge(sourceId: string, targetId: string, relation: EdgeRelation, weight: number = 1.0): boolean {
    try {
      this.db.prepare(`
        INSERT OR IGNORE INTO memory_edges (source_id, target_id, relation, weight, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(sourceId, targetId, relation, weight, now());
      return true;
    } catch {
      return false; // FK constraint or other error
    }
  }

  /** Get all edges from a memory */
  edgesFrom(memoryId: string): MemoryEdge[] {
    return this.db.prepare(`
      SELECT * FROM memory_edges WHERE source_id = ?
    `).all(memoryId) as MemoryEdge[];
  }

  /** Get all edges to a memory */
  edgesTo(memoryId: string): MemoryEdge[] {
    return this.db.prepare(`
      SELECT * FROM memory_edges WHERE target_id = ?
    `).all(memoryId) as MemoryEdge[];
  }

  /** Get 1-hop neighbor IDs (both directions) */
  neighbors(memoryId: string): string[] {
    const rows = this.db.prepare(`
      SELECT target_id AS id FROM memory_edges WHERE source_id = ?
      UNION
      SELECT source_id AS id FROM memory_edges WHERE target_id = ?
    `).all(memoryId, memoryId) as Array<{ id: string }>;
    return rows.map(r => r.id);
  }

  /** Get N-hop neighbors via recursive CTE (max depth 2, cycle-safe).
   *  SQLite forbids referencing the recursive table in a subquery, so the
   *  cycle guard tracks the visited path as a delimited string. instr() on
   *  a comma-wrapped path is delimiter-exact — the previous substring LIKE
   *  would treat an id containing a LIKE wildcard (or any id that happens
   *  to be a substring of the path) as already-visited. */
  reachable(memoryId: string, maxDepth: number = 2): Array<{ id: string; relation: string; depth: number }> {
    return this.db.prepare(`
      WITH RECURSIVE reachable AS (
        SELECT target_id AS id, relation, 1 AS depth,
               ',' || source_id || ',' || target_id || ',' AS path
        FROM memory_edges WHERE source_id = ?
        UNION ALL
        SELECT e.target_id, e.relation, r.depth + 1, r.path || e.target_id || ','
        FROM reachable r
        JOIN memory_edges e ON e.source_id = r.id
        WHERE r.depth < ?
          AND instr(r.path, ',' || e.target_id || ',') = 0
      )
      SELECT DISTINCT id, relation, depth FROM reachable
      ORDER BY depth ASC
    `).all(memoryId, maxDepth) as Array<{ id: string; relation: string; depth: number }>;
  }

  /** Count edges for a memory (both directions) */
  edgeCount(memoryId: string): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) as cnt FROM memory_edges
      WHERE source_id = ? OR target_id = ?
    `).get(memoryId, memoryId) as { cnt: number };
    return row.cnt;
  }

  /** Delete all edges involving a memory */
  deleteEdgesFor(memoryId: string): number {
    const result = this.db.prepare(`
      DELETE FROM memory_edges WHERE source_id = ? OR target_id = ?
    `).run(memoryId, memoryId);
    return result.changes;
  }

  /** Delete a specific edge */
  deleteEdge(sourceId: string, targetId: string, relation: EdgeRelation): boolean {
    const result = this.db.prepare(`
      DELETE FROM memory_edges WHERE source_id = ? AND target_id = ? AND relation = ?
    `).run(sourceId, targetId, relation);
    return result.changes > 0;
  }

  /** Get IDs of memories that have been superseded by newer ones.
   *  In a 'supersedes' edge, source is the OLD memory, target is the NEW one. */
  supersededIds(memoryIds: string[]): Set<string> {
    if (memoryIds.length === 0) return new Set();
    const placeholders = memoryIds.map(() => '?').join(',');
    const rows = this.db.prepare(`
      SELECT source_id FROM memory_edges
      WHERE relation = 'supersedes'
        AND source_id IN (${placeholders})
    `).all(...memoryIds) as Array<{ source_id: string }>;
    return new Set(rows.map(r => r.source_id));
  }

  /** Prune old co_occurred edges (keep only recent ones) */
  pruneOldCoOccurrences(maxAgeDays: number = CONSOLIDATION.CO_OCCURRENCE_PRUNE_DAYS): number {
    const result = this.db.prepare(`
      DELETE FROM memory_edges
      WHERE relation = 'co_occurred'
        AND julianday('now') - julianday(created_at) > ?
    `).run(maxAgeDays);
    return result.changes;
  }
}
