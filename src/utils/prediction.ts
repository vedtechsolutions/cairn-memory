/**
 * Predictive pre-fetching — co-recall tracking and context-based prediction.
 * Tracks which memories are recalled together and predicts related memories.
 */
import type Database from 'better-sqlite3';
import { now } from './index.js';

/**
 * Record that a set of memories were recalled together in a session.
 * Updates both session_memories and memory_corecall tables.
 */
export function trackCoRecall(
  db: Database.Database,
  sessionId: string,
  memoryIds: string[],
): void {
  if (memoryIds.length === 0) return;

  // Record session-memory associations
  const insertSession = db.prepare(`
    INSERT OR IGNORE INTO session_memories (session_id, memory_id, recalled_at)
    VALUES (?, ?, ?)
  `);
  const timestamp = now();

  db.transaction(() => {
    for (const id of memoryIds) {
      insertSession.run(sessionId, id, timestamp);
    }

    // Update co-recall counts for all unique pairs
    if (memoryIds.length >= 2) {
      const upsertCorecall = db.prepare(`
        INSERT INTO memory_corecall (memory_a, memory_b, co_count, last_co_recall)
        VALUES (?, ?, 1, ?)
        ON CONFLICT(memory_a, memory_b) DO UPDATE
        SET co_count = co_count + 1, last_co_recall = ?
      `);

      for (let i = 0; i < memoryIds.length; i++) {
        for (let j = i + 1; j < memoryIds.length; j++) {
          // Sort IDs for consistent key ordering
          const [a, b] = [memoryIds[i], memoryIds[j]].sort();
          upsertCorecall.run(a, b, timestamp, timestamp);
        }
      }
    }
  })();
}

/**
 * Predict related memories based on co-recall history.
 * Returns memory IDs that have been frequently recalled alongside the given ones.
 * @param minCoCount - minimum co-occurrence count to include (filters noise from single co-recalls)
 */
export function predictRelated(
  db: Database.Database,
  recentlyRecalled: string[],
  limit: number = 3,
  minCoCount: number = 1,
): string[] {
  if (recentlyRecalled.length === 0) return [];

  const placeholders = recentlyRecalled.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT
      CASE WHEN memory_a IN (${placeholders}) THEN memory_b ELSE memory_a END AS related_id,
      SUM(co_count) AS score
    FROM memory_corecall
    WHERE (memory_a IN (${placeholders}) OR memory_b IN (${placeholders}))
    GROUP BY related_id
    HAVING related_id NOT IN (${placeholders})
      AND score >= ?
    ORDER BY score DESC
    LIMIT ?
  `).all(
    ...recentlyRecalled,
    ...recentlyRecalled,
    ...recentlyRecalled,
    ...recentlyRecalled,
    minCoCount,
    limit,
  ) as Array<{ related_id: string; score: number }>;

  return rows.map(r => r.related_id);
}

/**
 * Mark that a recalled memory led to a successful outcome.
 * Called from success-tracker when surfaced pitfalls lead to success.
 */
export function markRecallSuccess(
  db: Database.Database,
  sessionId: string,
  memoryId: string,
): void {
  db.prepare(`
    UPDATE session_memories SET led_to_success = 1
    WHERE session_id = ? AND memory_id = ?
  `).run(sessionId, memoryId);
}

/**
 * Compute recall precision for a session.
 * Returns the ratio of recalled memories that led to success.
 */
export function computeRecallPrecision(
  db: Database.Database,
  sessionId: string,
): { recalled: number; successful: number; precision: number } {
  const row = db.prepare(`
    SELECT
      COUNT(*) AS recalled,
      SUM(CASE WHEN led_to_success = 1 THEN 1 ELSE 0 END) AS successful
    FROM session_memories
    WHERE session_id = ?
  `).get(sessionId) as { recalled: number; successful: number };

  const recalled = row?.recalled ?? 0;
  const successful = row?.successful ?? 0;
  const precision = recalled > 0 ? successful / recalled : 0;

  return { recalled, successful, precision };
}
