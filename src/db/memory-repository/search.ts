import type Database from 'better-sqlite3';
import { RELEVANCE, FINGERPRINT } from '../../constants/index.js';
import { now, buildFtsQuery, escapeLikePattern } from '../../utils/index.js';
import { type ContextFingerprint, fingerprintLikeConditions } from '../../utils/fingerprint.js';
import type { Memory, MemoryRow, RecallOptions, RecallResult } from './types.js';
import { rowToMemory } from './reads.js';
import { computeScore, multiSignalScore } from './scoring.js';

/** Search memories — read-only, does NOT update recall stats */
export function search(db: Database.Database, query: string, options: RecallOptions = {}): RecallResult[] {
  const maxResults = options.maxResults ?? 5;
  const minConfidence = options.minConfidence ?? 0;

  // FTS5 search for candidate memories
  const ftsQuery = buildFtsQuery(query);
  if (!ftsQuery) return [];

  const candidates = db.prepare(`
    SELECT m.*, rank
    FROM memories_fts fts
    JOIN memories m ON m.rowid = fts.rowid
    WHERE memories_fts MATCH ?
      AND m.invalidated = 0 AND m.superseded_by IS NULL
      AND m.kind != 'rule'
      AND m.confidence >= ?
      AND (m.expires_at IS NULL OR m.expires_at > datetime('now'))
      ${options.kind ? 'AND m.kind = ?' : ''}
      AND (m.project = ? OR m.project IS NULL ${options.project ? 'OR 1=0' : ''})
    ORDER BY rank
    LIMIT ?
  `).all(
    ftsQuery,
    minConfidence,
    ...(options.kind ? [options.kind] : []),
    options.project ?? null,
    maxResults * 3, // fetch extra for re-ranking
  ) as MemoryRow[];

  // Re-rank with composite score
  const scored = candidates.map(row => {
    const memory = rowToMemory(row);
    const score = computeScore(memory, query);
    return { memory, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, maxResults);
}

/** Search + track — updates recall stats for returned memories
 *  (unless options.readOnly). */
export function recall(db: Database.Database, query: string, options: RecallOptions = {}): RecallResult[] {
  const results = search(db, query, options);
  if (options.readOnly) return results;

  // Side effect: update recall stats
  const updateStmt = db.prepare(
    "UPDATE memories SET last_recalled = ?, recall_count = recall_count + 1 WHERE id = ? AND kind != 'rule'"
  );
  const timestamp = now();
  const updateAll = db.transaction(() => {
    for (const { memory } of results) {
      updateStmt.run(timestamp, memory.id);
    }
  });
  updateAll();

  return results;
}

/** Recall by tags — lightweight query for hooks (no FTS) */
export function recallByTags(db: Database.Database, tags: string[], options: RecallOptions = {}): Memory[] {
  if (tags.length === 0) return [];

  const maxResults = options.maxResults ?? 5;
  const minConfidence = options.minConfidence ?? RELEVANCE.MIN_CONFIDENCE_FOR_PITFALL;

  // Build tag matching condition using JSON (escape LIKE wildcards and quotes in tag values)
  const tagConditions = tags.map(() => "m.tags LIKE ? ESCAPE '\\'").join(' OR ');
  const tagParams = tags.map(t => `%"${t.replace(/[%_\\"]/g, '\\$&')}"%`);

  const rows = db.prepare(`
    SELECT * FROM memories m
    WHERE m.invalidated = 0 AND m.superseded_by IS NULL
      AND m.kind != 'rule'
      AND m.confidence >= ?
      ${options.kind ? 'AND m.kind = ?' : ''}
      AND (m.project = ? OR m.project IS NULL)
      AND (${tagConditions})
    ORDER BY m.confidence DESC
    LIMIT ?
  `).all(
    minConfidence,
    ...(options.kind ? [options.kind] : []),
    options.project ?? null,
    ...tagParams,
    maxResults,
  ) as MemoryRow[];

  return rows.map(r => rowToMemory(r));
}

/** Multi-signal retrieval using context fingerprints + content FTS.
 *  Fetches candidates via fingerprint LIKE + FTS, then re-ranks with multi-signal scoring. */
export function recallByFingerprint(
  db: Database.Database,
  queryFp: ContextFingerprint,
  queryText: string,
  options: RecallOptions = {},
): RecallResult[] {
  const maxResults = options.maxResults ?? 5;
  const minConfidence = options.minConfidence ?? RELEVANCE.MIN_CONFIDENCE_FOR_PITFALL;
  const candidateLimit = maxResults * FINGERPRINT.CANDIDATE_MULTIPLIER;

  // Build LIKE conditions from fingerprint dimensions
  const fpTerms = fingerprintLikeConditions(queryFp);
  const ftsQuery = buildFtsQuery(queryText);

  if (fpTerms.length === 0 && !ftsQuery) return [];

  // Build dynamic WHERE clause: fingerprint LIKE OR FTS match
  const orConditions: string[] = [];
  const orParams: unknown[] = [];

  for (const term of fpTerms) {
    orConditions.push('m.fingerprint LIKE ?');
    orParams.push(`%"${term}"%`);
  }

  if (ftsQuery) {
    orConditions.push('m.rowid IN (SELECT rowid FROM memories_fts WHERE memories_fts MATCH ?)');
    orParams.push(ftsQuery);
  }

  const rows = db.prepare(`
    SELECT * FROM memories m
    WHERE m.invalidated = 0 AND m.superseded_by IS NULL
      AND m.kind != 'rule'
      AND m.confidence >= ?
      ${options.kind ? 'AND m.kind = ?' : ''}
      AND (m.project = ? OR m.project IS NULL)
      AND (${orConditions.join(' OR ')})
    ORDER BY m.confidence DESC
    LIMIT ?
  `).all(
    minConfidence,
    ...(options.kind ? [options.kind] : []),
    options.project ?? null,
    ...orParams,
    candidateLimit,
  ) as MemoryRow[];

  // Multi-signal scoring
  const scored = rows.map(row => {
    const memory = rowToMemory(row);
    const score = multiSignalScore(memory, queryFp, queryText);
    return { memory, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, maxResults);
}

/** Recall memories anchored to a specific file path.
 *  Used by pitfall-check for file-specific memory surfacing. */
export function recallByAnchor(db: Database.Database, filePath: string, options: RecallOptions = {}): Memory[] {
  const maxResults = options.maxResults ?? 3;
  const minConfidence = options.minConfidence ?? RELEVANCE.MIN_CONFIDENCE_FOR_PITFALL;

  // Match file path in anchor JSON — search for basename and full path
  const base = filePath.split('/').pop() ?? filePath;

  const rows = db.prepare(`
    SELECT * FROM memories
    WHERE invalidated = 0 AND superseded_by IS NULL
      AND kind != 'rule'
      AND anchor IS NOT NULL
      AND confidence >= ?
      ${options.kind ? 'AND kind = ?' : ''}
      AND (project = ? OR project IS NULL)
      AND (anchor LIKE ? ESCAPE '\\' OR anchor LIKE ? ESCAPE '\\')
    ORDER BY confidence DESC
    LIMIT ?
  `).all(
    minConfidence,
    ...(options.kind ? [options.kind] : []),
    options.project ?? null,
    `%${escapeLikePattern(base)}%`,
    `%${escapeLikePattern(filePath)}%`,
    maxResults,
  ) as MemoryRow[];

  return rows.map(r => rowToMemory(r));
}
