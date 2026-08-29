import type Database from 'better-sqlite3';
import {
  CONFIDENCE,
  SOURCE_AUTHORITY,
  DEDUP,
  type LearnableKind,
  type MemorySource,
  LIMITS
} from '../../constants/index.js';
import { CLIENT_CLAUDE } from '../../constants/clients.js';
import { generateId, now, sanitize, scrubSecrets, tokenOverlap, buildFtsQuery } from '../../utils/index.js';
import { getEmbeddingModelConfig } from '../../utils/embeddings.js';
import { cosineSimilarity } from '../../utils/similarity.js';
import type { Memory, MemoryRow, CreateMemoryInput, CreateResult, StoreMemoryInput } from './types.js';
import { rowToMemory, bufferToFloat32, hasEmbedding, findById } from './reads.js';
import { applyConflictDetection, contentsOppose } from './truth.js';

const RULE_GENERIC_WRITE_ERROR = 'rule memories require the governance repository';

/** Run non-destructive conflict detection on a freshly-inserted claim-bearing
 *  memory. Best-effort — a detection failure must never fail the write. */
function detectConflicts(db: Database.Database, id: string): Pick<CreateResult, 'supersededId' | 'contradictionWith' | 'conflictSignal'> {
  try {
    const inserted = findById(db, id);
    if (!inserted) return {};
    const r = applyConflictDetection(db, inserted);
    return { supersededId: r.supersededId, contradictionWith: r.contradictionWith, conflictSignal: r.signal };
  } catch {
    return {};
  }
}

/** Kind-specific default confidence for smart-merge gateway */
const GATEWAY_DEFAULT_CONFIDENCE: Record<string, number> = {
  decision: CONFIDENCE.LEARNED,
  pitfall: CONFIDENCE.AUTO_DETECTED,
};

/** Sanitize free-text context fields on write (M1). `content` is already
 *  sanitized; `why`/`how_to_apply` were stored verbatim and could carry
 *  control characters or ANSI into briefings. Strips them at the write layer. */
function sanitizeContext(
  ctx: { why?: string; how_to_apply?: string } | undefined,
): { why?: string; how_to_apply?: string } | undefined {
  if (!ctx) return undefined;
  const out: { why?: string; how_to_apply?: string } = { ...ctx };
  if (typeof out.why === 'string') out.why = scrubSecrets(sanitize(out.why)).text;
  if (typeof out.how_to_apply === 'string') out.how_to_apply = scrubSecrets(sanitize(out.how_to_apply)).text;
  return out;
}

export function create(db: Database.Database, input: CreateMemoryInput): CreateResult {
  if ((input as { kind: string }).kind === 'rule') throw new Error(RULE_GENERIC_WRITE_ERROR);
  const content = scrubSecrets(sanitize(input.content)).text;
  const tags = input.tags ?? [];
  const project = input.project ?? null;
  const source = input.source ?? 'learned';
  const confidence = input.confidence ?? defaultConfidence(input.kind);

  // Dedup check: search for similar existing memories in same scope
  const existing = input.skipDedup
    ? undefined
    : findSimilar(db, content, project, input.kind, input.embedding);
  if (existing) {
    // Merge: boost confidence (dedup = reinforcement) + prefer longer content
    const newConfidence = Math.min(existing.confidence + CONFIDENCE.BOOST_INCREMENT, 1.0);
    const newContent = content.length > existing.content.length ? content : existing.content;
    db.prepare(`
      UPDATE memories SET content = ?, confidence = ?, tags = ?, source = ?
      WHERE id = ?
    `).run(newContent, newConfidence,
      // Union BOUNDED, never shrunk: cap growth at MAX_TAGS, but a
      // pre-existing row already carrying more keeps everything it has —
      // a flat slice destroyed two tags of an unrelated 7-tag row on any
      // merge (review). Existing tags order first, so they survive.
      JSON.stringify([...new Set([...existing.tags, ...tags])].slice(0, Math.max(LIMITS.MAX_TAGS, existing.tags.length))),
      source, existing.id);

    return { id: existing.id, deduplicated: true };
  }

  const id = generateId();
  const tagsJson = JSON.stringify(tags);
  const timestamp = input.createdAt ?? now();

  const fpJson = input.fingerprint ? JSON.stringify(input.fingerprint) : null;
  const ctxJson = input.context ? JSON.stringify(sanitizeContext(input.context)) : null;
  const embeddingBlob = input.embedding ?? null;
  const embeddingModel = embeddingBlob ? getEmbeddingModelConfig().key : null;
  const anchorJson = input.anchor ?? null;

  db.prepare(`
    INSERT INTO memories (id, content, kind, project, tags, confidence, source, origin_client, created_at, updated_at, recall_count, invalidated, expires_at, fingerprint, context, embedding, embedding_model, anchor)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?)
  `).run(id, content, input.kind, project, tagsJson, confidence, source, input.originClient ?? CLIENT_CLAUDE, timestamp, timestamp, input.expiresAt ?? null, fpJson, ctxJson, embeddingBlob, embeddingModel, anchorJson);

  if (input.skipConflictDetection) {
    return { id, deduplicated: false };
  }
  return { id, deduplicated: false, ...detectConflicts(db, id) };
}

/** Smart-merge gateway shared by storeDecision/storePitfall.
 *  On dedup: source authority, confidence max, content length, tag union,
 *  context gap-fill, fingerprint enrichment, embedding backfill. */
export function storeMemory(db: Database.Database, input: StoreMemoryInput): CreateResult {
  const content = scrubSecrets(sanitize(input.content)).text;
  const tags = input.tags ?? [];
  const project = input.project;
  const kind = input.kind;
  const source: MemorySource = input.source ?? 'learned';
  const confidence = input.confidence ?? GATEWAY_DEFAULT_CONFIDENCE[kind] ?? CONFIDENCE.LEARNED;

  const existing = findSimilar(db, content, project, kind, input.embedding);
  if (existing) {
    // Source authority: never downgrade (e.g. user → learned)
    const existingAuth = SOURCE_AUTHORITY[existing.source] ?? 0;
    const incomingAuth = SOURCE_AUTHORITY[source] ?? 0;
    const newSource = incomingAuth >= existingAuth ? source : existing.source;

    // Confidence: max of boosted existing vs incoming
    const boosted = existing.confidence + CONFIDENCE.BOOST_INCREMENT;
    const newConfidence = Math.min(Math.max(boosted, confidence), 1.0);

    // Content: keep the longer version
    const newContent = content.length > existing.content.length ? content : existing.content;

    // Tags: union, bounded like create's — growth capped at MAX_TAGS,
    // pre-existing rows never shrunk (review).
    const newTags = [...new Set([...existing.tags, ...tags])].slice(0, Math.max(LIMITS.MAX_TAGS, existing.tags.length));

    // Context: incoming fills gaps, doesn't overwrite
    const existingCtx = existing.context ?? {};
    const incomingCtx = sanitizeContext(input.context) ?? {};
    const mergedCtx = {
      why: existingCtx.why ?? incomingCtx.why,
      how_to_apply: existingCtx.how_to_apply ?? incomingCtx.how_to_apply,
    };
    const hasCtx = mergedCtx.why || mergedCtx.how_to_apply;

    // Fingerprint: pick the one with more dimensions
    const existingFpDims = existing.fingerprint ? Object.values(existing.fingerprint).filter(v => v && v.length > 0).length : 0;
    const incomingFpDims = input.fingerprint ? Object.values(input.fingerprint).filter(v => v && (v as string[]).length > 0).length : 0;
    const newFp = incomingFpDims > existingFpDims ? input.fingerprint : existing.fingerprint;

    // Embedding: backfill if existing lacks one
    const newEmbedding = input.embedding && !hasEmbedding(db, existing.id) ? input.embedding : undefined;

    db.prepare(`
      UPDATE memories SET content = ?, confidence = ?, tags = ?, source = ?,
        context = ?, fingerprint = ?${newEmbedding ? ', embedding = ?, embedding_model = ?' : ''}
      WHERE id = ?
    `).run(
      newContent, newConfidence, JSON.stringify(newTags), newSource,
      hasCtx ? JSON.stringify(mergedCtx) : (existing.context ? JSON.stringify(existing.context) : null),
      newFp ? JSON.stringify(newFp) : null,
      ...(newEmbedding ? [newEmbedding, getEmbeddingModelConfig().key] : []),
      existing.id,
    );

    return { id: existing.id, deduplicated: true };
  }

  // New memory — insert
  const id = generateId();
  const timestamp = now();
  const fpJson = input.fingerprint ? JSON.stringify(input.fingerprint) : null;
  const ctxJson = input.context ? JSON.stringify(sanitizeContext(input.context)) : null;
  const anchorJson = input.anchor ?? null;

  db.prepare(`
    INSERT INTO memories (id, content, kind, project, tags, confidence, source, origin_client, created_at, recall_count, invalidated, expires_at, fingerprint, context, embedding, embedding_model, anchor)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, NULL, ?, ?, ?, ?, ?)
  `).run(id, content, kind, project, JSON.stringify(tags), confidence, source, input.originClient ?? CLIENT_CLAUDE, timestamp, fpJson, ctxJson, input.embedding ?? null, input.embedding ? getEmbeddingModelConfig().key : null, anchorJson);

  return { id, deduplicated: false, ...detectConflicts(db, id) };
}

function defaultConfidence(kind: LearnableKind): number {
  if (kind === 'correction') return CONFIDENCE.CORRECTION;
  if (kind === 'user_profile') return CONFIDENCE.USER_PROFILE;
  if (kind === 'reference') return CONFIDENCE.REFERENCE;
  return CONFIDENCE.LEARNED;
}

/** Import-probe: the row create() would merge this content into, after
 *  the same canonicalization create() applies. */
export function probeSimilar(db: Database.Database, content: string, project: string | null, kind: string): Memory | null {
  return findSimilar(db, scrubSecrets(sanitize(content)).text, project, kind);
}

export function findSimilar(db: Database.Database, content: string, project: string | null, kind: string, inputEmbedding?: Buffer): Memory | null {
  if (kind === 'rule') return null;
  // An EXACT row always wins over a near match: with both present
  // (restored/legacy stores have them), merging into the near-dup
  // overwrites the WRONG row and leaves two identical copies (closing
  // review, reproduced). The near-candidate query below stays UNORDERED:
  // ORDER BY rank forces bm25 scoring of every matching row before the
  // LIMIT (measured 22ms vs 0.15ms per query on a common-token 10k-row
  // store) on every gateway write, and with exactness guaranteed here it
  // bought only speculative merge-target quality.
  // Exact by CONSTRUCTION means NO FTS gate:
  // buildFtsQuery's tokenization is not the index's (unicode61 —
  // non-ASCII terms diverge), and all-stopword content produces no
  // query at all, so an FTS-gated "exact" lookup can miss byte-identical
  // rows and insert duplicates (delta review). The (project, kind)
  // partial active index narrows the scan before the content compare —
  // this is NOT the unindexed full-table probe removed in round 2.
  try {
    // Two statements, not an OR disjunction: the OR form defeats the
    // v31 partial index and full-scans every write (measured ~48ms per
    // write on a 10k-row single-scope store).
    const scopeClause = project === null ? 'project IS NULL' : 'project = ?';
    // INDEXED BY pins the v31 partial index (guaranteed by ensureSchema
    // at open): without stats the planner picked the one-column
    // invalidated index and scanned every active row per write —
    // measured ~5ms/probe on a 10k-row store with the target row last.
    const exact = db.prepare(`
      SELECT * FROM memories INDEXED BY idx_memories_exact_dedup
      WHERE kind = ? AND ${scopeClause}
        AND invalidated = 0
        AND superseded_by IS NULL
        AND content = ?
      LIMIT 1
    `).get(...(project === null ? [kind, content] : [kind, project, content])) as MemoryRow | undefined;
    if (exact) return rowToMemory(exact);
  } catch {
    // Fall THROUGH, never return: a missing index (impossible while
    // ensureSchema guarantees v31, but this is defense-in-depth) must
    // degrade to slower-but-correct near-candidate matching below —
    // returning null here silently disabled ALL dedup (review O1,
    // demonstrated: exact and near re-imports each inserted new rows).
  }

  // Scope-exact: merging across project/global scope would erase the
  // distinction (and the merge path overwrites content on the wrong row).
  // Quick FTS search for candidates
  const ftsQuery = buildFtsQuery(content);
  if (!ftsQuery) return null;

  let candidates: MemoryRow[];
  try {
    candidates = db.prepare(`
      SELECT m.*
      FROM memories_fts fts
      JOIN memories m ON m.rowid = fts.rowid
      WHERE memories_fts MATCH ?
        AND m.invalidated = 0
        AND m.superseded_by IS NULL
        AND m.kind = ?
        AND ((? IS NULL AND m.project IS NULL) OR m.project = ?)
      LIMIT 10
    `).all(ftsQuery, kind, project, project) as MemoryRow[];
  } catch {
    return null;
  }

  for (const row of candidates) {
    // Opposed content (divergent value, negation flip, antonym) is NOT a
    // duplicate — skip it here so the new row inserts and applyConflictDetection
    // handles it (retire on supersession, flag on standing contradiction).
    // Merging would silently erase the conflict ("Postgres 15"/"…16",
    // "always enable X"/"never enable X").
    if (contentsOppose(content, row.content)) continue;
    // Primary: token overlap (existing behavior)
    if (tokenOverlap(content, row.content) >= DEDUP.SIMILARITY_THRESHOLD) {
      return rowToMemory(row);
    }
    // Enhanced: cosine similarity when both embeddings available (catches
    // paraphrases). ACTIVE-model candidates only (v26): the incoming vector
    // is always active-model, and cross-model cosine is meaningless — a
    // foreign-tagged candidate must never trigger an embedding-only dedup.
    if (inputEmbedding && row.embedding && row.embedding_model === getEmbeddingModelConfig().key) {
      const sim = cosineSimilarity(bufferToFloat32(inputEmbedding), bufferToFloat32(row.embedding));
      if (sim >= 0.85) { // High threshold — only true semantic duplicates
        return rowToMemory(row);
      }
    }
  }
  return null;
}

export function update(db: Database.Database, id: string, newContent: string): boolean {
  // Corrections re-enter through the same gateway as create()/storeMemory():
  // scrub so a secret pasted into a fix never lands in content, memory_versions,
  // or the re-derived embedding.
  const content = scrubSecrets(sanitize(newContent)).text;

  // Atomic: version + update in single transaction to prevent orphaned version rows
  return db.transaction(() => {
    const existing = findById(db, id);
    if (existing && existing.content !== content) {
      storeVersion(db, id, existing.content, content);
    }

    const result = db.prepare(`
      UPDATE memories SET content = ?, confidence = ?, source = 'corrected'
      WHERE id = ? AND invalidated = 0 AND kind != 'rule'
    `).run(content, CONFIDENCE.CORRECTION, id);
    return result.changes > 0;
  })();
}

/** Store a version snapshot before updating memory content */
function storeVersion(db: Database.Database, memoryId: string, oldContent: string, newContent: string): void {
  try {
    db.prepare(`
      INSERT INTO memory_versions (memory_id, old_content, new_content, changed_at)
      VALUES (?, ?, ?, ?)
    `).run(memoryId, oldContent, newContent, now());
  } catch { /* table may not exist on older schemas — non-critical */ }
}

/** Get version history for a memory (most recent first) */
export function getVersionHistory(db: Database.Database, memoryId: string): Array<{ oldContent: string; newContent: string; changedAt: string }> {
  try {
    const rows = db.prepare(`
      SELECT old_content, new_content, changed_at
      FROM memory_versions WHERE memory_id = ?
      ORDER BY changed_at DESC LIMIT 10
    `).all(memoryId) as Array<{ old_content: string; new_content: string; changed_at: string }>;
    return rows.map(r => ({ oldContent: r.old_content, newContent: r.new_content, changedAt: r.changed_at }));
  } catch {
    return []; // table may not exist on older schemas
  }
}

/** Retractions must travel (v32): every effective invalidate/delete also
 *  writes the tombstone log in the same transaction — sync propagation
 *  later, forget-audit today. A refused mutation (rule kind, missing id)
 *  logs nothing. */
function retractWithTombstone(db: Database.Database, id: string, action: 'delete' | 'invalidate'): boolean {
  return db.transaction(() => {
    const row = db.prepare("SELECT project, kind, content FROM memories WHERE id = ? AND kind != 'rule'").get(id) as
      | { project: string | null; kind: string; content: string } | undefined;
    if (!row) return false;
    db.prepare(`
      INSERT OR IGNORE INTO memory_tombstones (memory_id, action, project, kind, content, deleted_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
    `).run(id, action, row.project, row.kind, row.content);
    const stmt = action === 'delete'
      ? "DELETE FROM memories WHERE id = ? AND kind != 'rule'"
      : "UPDATE memories SET invalidated = 1 WHERE id = ? AND kind != 'rule'";
    return db.prepare(stmt).run(id).changes > 0;
  })();
}

export function invalidate(db: Database.Database, id: string): boolean {
  return retractWithTombstone(db, id, 'invalidate');
}

export function deleteById(db: Database.Database, id: string): boolean {
  return retractWithTombstone(db, id, 'delete');
}

/** Promote a project-scoped memory to global scope */
export function promote(db: Database.Database, id: string): boolean {
  const result = db.prepare(
    "UPDATE memories SET project = NULL WHERE id = ? AND invalidated = 0 AND project IS NOT NULL AND kind != 'rule'"
  ).run(id);
  return result.changes > 0;
}
