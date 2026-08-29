import type Database from 'better-sqlite3';
import { RELEVANCE, FINGERPRINT } from '../../constants/index.js';
import { type ContextFingerprint, fingerprintOverlap } from '../../utils/fingerprint.js';
import type { Memory, MemoryRow } from './types.js';
import { rowToMemory } from './reads.js';
import { isMemoryEligibleForInjection } from '../../utils/memory-injection.js';

/** Find top pitfalls for briefing. When queryFp is provided, uses context-aware ranking. */
export function topPitfalls(db: Database.Database, project: string | null, limit: number, queryFp?: ContextFingerprint): Memory[] {
  // Fetch extra candidates when doing fingerprint re-ranking
  const fetchLimit = limit * FINGERPRINT.CANDIDATE_MULTIPLIER;
  const rows = db.prepare(`
    SELECT * FROM memories
    WHERE invalidated = 0 AND superseded_by IS NULL
      AND kind = 'pitfall'
      AND (project = ? OR project IS NULL)
    ORDER BY (confidence * (1 + recall_count)) DESC
    LIMIT ?
  `).all(project, fetchLimit) as MemoryRow[];

  const memories = rows.map(r => rowToMemory(r)).filter(isMemoryEligibleForInjection);

  if (!queryFp) return memories.slice(0, limit);

  // Re-rank by fingerprint relevance. When the query is task-specific
  // (non-empty module dim), a stored fingerprint with empty module provides
  // no topical signal — its lang+framework overlap is ambient noise that
  // ties with genuinely relevant memories. Score such memories at 0 so the
  // downstream same-project relevance gate isn't competing with them for
  // briefing slots.
  const queryHasModule = queryFp.module.length > 0;
  const scored = memories.map(m => {
    if (!m.fingerprint) return { memory: m, score: 0 };
    if (queryHasModule && m.fingerprint.module.length === 0) {
      return { memory: m, score: 0 };
    }
    return { memory: m, score: fingerprintOverlap(m.fingerprint, queryFp) };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map(s => s.memory);
}

/** Find top decisions for briefing fallback when no plan decisions exist.
 *  Recency-weighted with capped recall influence to prevent feedback loops.
 *  - recall_count capped at 5 (prevents old decisions from dominating via 35x multiplier)
 *  - Aggressive recency decay: 0.5/day (half-value at 2 days, ~10% at 2 weeks)
 *  - 24h session-recency boost: decisions from current session get 2x priority */
export function topDecisions(db: Database.Database, project: string | null, limit: number): Memory[] {
  const rows = db.prepare(`
    SELECT * FROM memories
    WHERE invalidated = 0 AND superseded_by IS NULL
      AND kind = 'decision'
      AND confidence >= ${RELEVANCE.MIN_CONFIDENCE_FOR_PITFALL}
      AND (project = ? OR project IS NULL)
    ORDER BY (
      confidence
      * (1.0 + MIN(recall_count, 5))
      * CASE WHEN julianday('now') - julianday(created_at) < 1.0 THEN 2.0 ELSE 1.0 END
      / (1.0 + 0.5 * (julianday('now') - julianday(created_at)))
    ) DESC
    LIMIT ?
  `).all(project, limit) as MemoryRow[];
  return rows.map(r => rowToMemory(r));
}

/** Find top decisions ranked by impact, confidence, and recency for tier-based briefing.
 *  Returns more candidates than needed so the caller can apply effectiveness filtering.
 *  Ranking: composite score with temporal decay — recent high-impact decisions win. */
export function topDecisionsRanked(db: Database.Database, project: string | null, limit: number): Memory[] {
  const rows = db.prepare(`
    SELECT * FROM memories
    WHERE invalidated = 0 AND superseded_by IS NULL
      AND kind = 'decision'
      AND confidence >= ${RELEVANCE.MIN_CONFIDENCE_FOR_FACT}
      AND (project = ? OR project IS NULL)
    ORDER BY (
      (1.0 + impact_count) * confidence
      / (1.0 + 0.15 * (julianday('now') - julianday(COALESCE(last_recalled, created_at))))
    ) DESC
    LIMIT ?
  `).all(project, limit * 2) as MemoryRow[];
  return rows.map(r => rowToMemory(r));
}

/** Find active corrections (global + project) */
export function activeCorrections(db: Database.Database, project: string | null, limit: number): Memory[] {
  const rows = db.prepare(`
    SELECT * FROM memories
    WHERE invalidated = 0 AND superseded_by IS NULL
      AND kind = 'correction'
      AND (project = ? OR project IS NULL)
    ORDER BY confidence DESC
    LIMIT ?
  `).all(project, limit) as MemoryRow[];
  return rows.map(r => rowToMemory(r));
}

/** Find high-impact pitfalls not in a given set.
 *  Used by correction pass to recover dropped pitfalls from briefing reduction. */
export function highImpactPitfalls(
  db: Database.Database,
  project: string | null,
  excludeIds: string[],
  minImpact: number,
  limit: number,
): Memory[] {
  const excludePlaceholders = excludeIds.length > 0
    ? excludeIds.map(() => '?').join(',')
    : "'__none__'";
  const rows = db.prepare(`
    SELECT * FROM memories
    WHERE invalidated = 0 AND superseded_by IS NULL
      AND kind = 'pitfall'
      AND (project = ? OR project IS NULL)
      AND impact_count >= ?
      AND id NOT IN (${excludePlaceholders})
    ORDER BY impact_count DESC, confidence DESC
    LIMIT ?
  `).all(
    project,
    minImpact,
    ...excludeIds,
    limit * FINGERPRINT.CANDIDATE_MULTIPLIER,
  ) as MemoryRow[];
  return rows
    .map(r => rowToMemory(r))
    .filter(isMemoryEligibleForInjection)
    .slice(0, limit);
}

/** Find top user profiles for briefing (global scope only) */
export function topUserProfiles(db: Database.Database, limit: number): Memory[] {
  const rows = db.prepare(`
    SELECT * FROM memories
    WHERE invalidated = 0 AND superseded_by IS NULL
      AND kind = 'user_profile'
      AND project IS NULL
    ORDER BY confidence DESC
    LIMIT ?
  `).all(limit) as MemoryRow[];
  return rows.map(r => rowToMemory(r));
}
