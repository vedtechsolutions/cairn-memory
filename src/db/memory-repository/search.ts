import type Database from 'better-sqlite3';
import { RELEVANCE, FINGERPRINT } from '../../constants/index.js';
import { buildFtsQuery, escapeLikePattern } from '../../utils/index.js';
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

  // Re-rank with composite score. FTS5's BM25 rank (negative, more negative
  // = stronger) was previously discarded here — step 6 folds it in as each
  // row's share of the set's best lexical strength.
  const bestRank = candidates.reduce((m, r) => Math.min(m, (r as MemoryRow & { rank?: number }).rank ?? 0), 0);
  const scored = candidates.map(row => {
    const memory = rowToMemory(row);
    const rank = (row as MemoryRow & { rank?: number }).rank ?? 0;
    const bm25Share = bestRank < 0 && rank < 0 ? rank / bestRank : 1;
    const score = computeScore(memory, query, bm25Share);
    return { memory, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, maxResults);
}

/** Search — retrieval NEVER stamps recall stats (step 6; the step-7 fold
 *  left the mutate-on-return default with zero production callers, a loaded
 *  gun). Exposure is recorded solely by markRecalled at injection
 *  boundaries. `options.readOnly` is retained as an accepted no-op for
 *  source compatibility. */
export function recall(db: Database.Database, query: string, options: RecallOptions = {}): RecallResult[] {
  return search(db, query, options);
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
/** The RAW bounded SQL candidate scan behind recallByFingerprint —
 *  post-SQL, PRE-scoring, PRE-slicing (step 6, codex review): the pitfall
 *  warning cache freezes exactly this membership for its TTL and replays
 *  everything downstream (eligibility, live multiSignalScore, sort, slice)
 *  identically on hits and misses. Cache anything later in the pipeline and
 *  live-field promotion from just outside the cached slice diverges. */
export function recallByFingerprintCandidates(
  db: Database.Database,
  queryFp: ContextFingerprint,
  queryText: string,
  options: RecallOptions = {},
): Memory[] {
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

  return rows.map(row => rowToMemory(row));
}

export function recallByFingerprint(
  db: Database.Database,
  queryFp: ContextFingerprint,
  queryText: string,
  options: RecallOptions = {},
): RecallResult[] {
  const maxResults = options.maxResults ?? 5;
  const candidates = recallByFingerprintCandidates(db, queryFp, queryText, options);
  const scored = candidates.map(memory => ({
    memory,
    score: multiSignalScore(memory, queryFp, queryText),
  }));
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
