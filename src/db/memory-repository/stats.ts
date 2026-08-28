import type Database from 'better-sqlite3';
import { HEALTH, type MemoryKind } from '../../constants/index.js';
import type { CleanupFilter, Memory, MemoryRow } from './types.js';
import { rowToMemory } from './reads.js';

/** Aggregate stats for cairn_stats summary */
export function getStats(db: Database.Database): {
  total: number;
  active: number;
  invalidated: number;
  byKind: Record<string, number>;
} {
  const total = (db.prepare("SELECT COUNT(*) as cnt FROM memories WHERE kind != 'rule'").get() as { cnt: number }).cnt;
  const active = (db.prepare("SELECT COUNT(*) as cnt FROM memories WHERE invalidated = 0 AND kind != 'rule'").get() as { cnt: number }).cnt;
  const invalidated = total - active;

  const kindRows = db.prepare(`
    SELECT kind, COUNT(*) as cnt FROM memories WHERE invalidated = 0 AND kind != 'rule' GROUP BY kind
  `).all() as Array<{ kind: string; cnt: number }>;
  const byKind: Record<string, number> = {};
  for (const r of kindRows) byKind[r.kind] = r.cnt;

  return { total, active, invalidated, byKind };
}

/** Health metrics for cairn_stats health */
export function getHealthMetrics(db: Database.Database): {
  confidenceDistribution: { high: number; medium: number; low: number };
  decayCandidates: number;
  neverRecalled: number;
  avgConfidence: number;
  oldestMemory: { id: string; content: string; created_at: string } | null;
  mostRecalled: { id: string; content: string; recall_count: number } | null;
} {
  const dist = db.prepare(`
    SELECT
      SUM(CASE WHEN confidence > ${HEALTH.CONFIDENCE_HIGH_THRESHOLD} THEN 1 ELSE 0 END) as high,
      SUM(CASE WHEN confidence BETWEEN ${HEALTH.CONFIDENCE_MEDIUM_THRESHOLD} AND ${HEALTH.CONFIDENCE_HIGH_THRESHOLD} THEN 1 ELSE 0 END) as medium,
      SUM(CASE WHEN confidence < ${HEALTH.CONFIDENCE_MEDIUM_THRESHOLD} THEN 1 ELSE 0 END) as low
    FROM memories WHERE invalidated = 0 AND kind != 'rule'
  `).get() as { high: number; medium: number; low: number };

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 30);
  const decayCandidates = (db.prepare(`
    SELECT COUNT(*) as cnt FROM memories
    WHERE invalidated = 0 AND kind != 'task_state' AND kind != 'rule'
      AND (last_recalled IS NULL OR last_recalled < ?)
  `).get(cutoff.toISOString()) as { cnt: number }).cnt;

  const neverRecalled = (db.prepare(`
    SELECT COUNT(*) as cnt FROM memories WHERE invalidated = 0 AND kind != 'rule' AND recall_count = 0
  `).get() as { cnt: number }).cnt;

  const avgRow = db.prepare(
    "SELECT AVG(confidence) as avg FROM memories WHERE invalidated = 0 AND kind != 'rule'"
  ).get() as { avg: number | null };

  const oldest = db.prepare(`
    SELECT id, content, created_at FROM memories
    WHERE invalidated = 0 AND kind != 'rule' ORDER BY created_at ASC LIMIT 1
  `).get() as { id: string; content: string; created_at: string } | undefined;

  const mostRecalledRow = db.prepare(`
    SELECT id, content, recall_count FROM memories
    WHERE invalidated = 0 AND kind != 'rule' ORDER BY recall_count DESC LIMIT 1
  `).get() as { id: string; content: string; recall_count: number } | undefined;

  return {
    confidenceDistribution: { high: dist.high ?? 0, medium: dist.medium ?? 0, low: dist.low ?? 0 },
    decayCandidates,
    neverRecalled,
    avgConfidence: avgRow.avg ?? 0,
    oldestMemory: oldest ?? null,
    mostRecalled: mostRecalledRow ?? null,
  };
}

/** Stats by kind */
export function getStatsByKind(db: Database.Database): Array<{ kind: string; count: number; avgConfidence: number; totalRecalls: number }> {
  return db.prepare(`
    SELECT kind, COUNT(*) as count, AVG(confidence) as avgConfidence, SUM(recall_count) as totalRecalls
    FROM memories WHERE invalidated = 0 AND kind != 'rule' GROUP BY kind
  `).all() as Array<{ kind: string; count: number; avgConfidence: number; totalRecalls: number }>;
}

/** Stats by project */
export function getStatsByProject(db: Database.Database): Array<{ project: string | null; count: number; avgConfidence: number; lastActivity: string | null }> {
  return db.prepare(`
    SELECT project, COUNT(*) as count, AVG(confidence) as avgConfidence,
      MAX(COALESCE(last_recalled, created_at)) as lastActivity
    FROM memories WHERE invalidated = 0 AND kind != 'rule' GROUP BY project
  `).all() as Array<{ project: string | null; count: number; avgConfidence: number; lastActivity: string | null }>;
}

/** Export memories matching filter criteria (for cairn_export) */
export function exportMemories(db: Database.Database, options: {
  project?: string | null;
  kind?: MemoryKind;
  minConfidence?: number;
} = {}): Memory[] {
  const minConf = options.minConfidence ?? 0;
  const conditions: string[] = ['invalidated = 0', "kind != 'task_state'", "kind != 'rule'"];
  const params: unknown[] = [];

  conditions.push('confidence >= ?');
  params.push(minConf);

  if (options.kind) {
    conditions.push('kind = ?');
    params.push(options.kind);
  }

  if (options.project !== undefined) {
    if (options.project === null) {
      conditions.push('project IS NULL');
    } else {
      conditions.push('(project = ? OR project IS NULL)');
      params.push(options.project);
    }
  }

  const rows = db.prepare(`
    SELECT * FROM memories
    WHERE ${conditions.join(' AND ')}
    ORDER BY kind, confidence DESC
  `).all(...params) as MemoryRow[];

  return rows.map(r => rowToMemory(r));
}

/** Count memories by project */
export function countByProject(db: Database.Database, project: string | null): number {
  const row = db.prepare(
    "SELECT COUNT(*) as cnt FROM memories WHERE project = ? AND invalidated = 0 AND kind != 'rule'"
  ).get(project) as { cnt: number };
  return row.cnt;
}

/** Find memories matching a cleanup filter (for preview/delete) */
export function findByFilter(db: Database.Database, filter: CleanupFilter, limit = 100): Memory[] {
  const conditions: string[] = ['invalidated = 0', "kind != 'rule'"];
  const params: unknown[] = [];

  if (filter.project !== undefined) {
    conditions.push('project = ?');
    params.push(filter.project);
  }
  if (filter.kind) {
    conditions.push('kind = ?');
    params.push(filter.kind);
  }
  if (filter.maxConfidence !== undefined) {
    conditions.push('confidence <= ?');
    params.push(filter.maxConfidence);
  }
  if (filter.olderThanDays !== undefined) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - filter.olderThanDays);
    conditions.push('created_at < ?');
    params.push(cutoff.toISOString());
  }
  if (filter.neverRecalled) {
    conditions.push('recall_count = 0');
  }

  const rows = db.prepare(`
    SELECT * FROM memories WHERE ${conditions.join(' AND ')}
    ORDER BY confidence ASC LIMIT ?
  `).all(...params, limit) as MemoryRow[];

  return rows.map(r => rowToMemory(r));
}

/** Delete memories matching a cleanup filter */
export function deleteByFilter(db: Database.Database, filter: CleanupFilter, limit = 100): number {
  const memories = findByFilter(db, filter, limit);
  if (memories.length === 0) return 0;

  const ids = memories.map(m => m.id);
  const placeholders = ids.map(() => '?').join(',');
  const result = db.prepare(`DELETE FROM memories WHERE id IN (${placeholders})`).run(...ids);
  return result.changes;
}
