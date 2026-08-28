import type Database from 'better-sqlite3';
import type { Memory, MemoryRow, RecallResult } from './types.js';
import { rowToMemory } from './reads.js';

/** Enrich recall results with 1-hop graph neighbors.
 *  Appends related memories (via memory_edges) that aren't already in results. */
export function enrichWithGraphNeighbors(
  db: Database.Database,
  results: RecallResult[],
  maxExtra: number,
): RecallResult[] {
  if (results.length === 0) return results;

  const existingIds = new Set(results.map(r => r.memory.id));
  const extras: RecallResult[] = [];

  for (const { memory } of results) {
    if (extras.length >= maxExtra) break;

    // Get 1-hop neighbors via edge table. Shared suppression policy: never
    // rehydrate a superseded (retired) memory, and never expand across a
    // 'contradicts' edge — doing so would resurface the exact memory the
    // conflict machinery is flagging/retiring as a "related" neighbor.
    const neighborRows = db.prepare(`
      SELECT DISTINCT m.* FROM memory_edges e
      JOIN memories m ON (m.id = e.target_id OR m.id = e.source_id)
      WHERE (e.source_id = ? OR e.target_id = ?)
        AND e.relation != 'contradicts'
        AND m.id != ?
        AND m.invalidated = 0
        AND m.superseded_by IS NULL
        AND m.kind != 'rule'
      LIMIT ?
    `).all(memory.id, memory.id, memory.id, maxExtra - extras.length) as MemoryRow[];

    for (const row of neighborRows) {
      if (!existingIds.has(row.id) && extras.length < maxExtra) {
        existingIds.add(row.id);
        extras.push({ memory: rowToMemory(row), score: 0.01 }); // low score — supplemental
      }
    }
  }

  return [...results, ...extras];
}

/** Filter out memories that have been superseded by newer ones (via memory_edges). */
export function filterSuperseded(db: Database.Database, memories: Memory[]): Memory[] {
  if (memories.length === 0) return memories;
  const ids = memories.map(m => m.id);
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT source_id FROM memory_edges
    WHERE relation = 'supersedes'
      AND source_id IN (${placeholders})
  `).all(...ids) as Array<{ source_id: string }>;
  const superseded = new Set(rows.map(r => r.source_id));
  return memories.filter(m => !superseded.has(m.id));
}
