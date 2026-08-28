/**
 * Variant runners (roadmap W1 slice 3): per-question retrieval loop over
 * isolated in-memory stores, read-only, deterministic. No wall-clock, no
 * live store, no custom store paths (':memory:' is the strongest isolation).
 *
 * Variants:
 *   - fts    — repository search() (FTS5 + composite re-rank; read-only by design)
 *   - hybrid — recallHybrid() with readOnly: true. Without embeddings it is
 *              NOT identical to the fts runner (recallHybrid caps candidates
 *              at HYBRID_SEARCH.CANDIDATES_PER_RETRIEVER per leg, below the
 *              fts pool), so reports label it "hybrid-fts-fallback".
 */
import { HYBRID_SEARCH } from '../../constants/index.js';
import { RERANK } from '../../constants/reranker-models.js';
import { buildContextualEmbedText } from '../../utils/contextual-embed.js';
import { embeddingToBuffer, getEmbeddingModelConfig } from '../../utils/embeddings.js';
import { type LmeQuestion, isAbstention } from './data.js';
import {
  buildQuestionStore, LME_PROJECT,
  type CorpusMode, type QuestionStore, type TurnRef,
} from './ingest.js';
import {
  aggregate, ndcgAnyAtK, recallAllAtK, uniqueStable,
  type AggregateMetrics, type NamespaceScores, type QuestionMetrics, type ScoreByK,
} from './metrics.js';
import { evaluateRetrieval, evaluateTurn2Session, turnDocId } from './official-metrics.js';

export type Variant = 'fts' | 'hybrid';

/** Memory pool fetched per query before collapsing — must be comfortably
 *  larger than max(k) × typical turns-per-session. */
export const DEFAULT_POOL_SIZE = 50;
export const DEFAULT_KS = [5, 10];

/** Role is REQUIRED: asymmetric-prefix models embed queries and documents
 *  differently, and a role-less fn would silently embed the benchmark query
 *  as a document — invalidating any challenger A/B. */
export type EmbedFn = (text: string, role: 'query' | 'document') => Promise<Float32Array>;

/** Rerank hook: reorders the given candidate window (score desc, original
 *  rank on ties) or returns null when the reranker is unavailable — the
 *  runner then THROWS rather than score a mislabeled run. */
export type RerankFn = (
  query: string,
  candidates: Array<{ id: string; text: string; rank: number }>,
) => Promise<Array<{ id: string }> | null>;

export interface RunnerOptions {
  variant: Variant;
  ks?: number[];
  maxQuestions?: number;
  poolSize?: number;
  corpusMode?: CorpusMode;
  /** When provided, memories are embedded at ingest and the query at retrieval
   *  (real hybrid). Absent in CI — no model download. */
  embedFn?: EmbedFn;
  /** When provided, the RRF top-RERANK.CANDIDATES window is cross-encoded
   *  and reordered; the pool tail keeps its order. */
  rerankFn?: RerankFn;
  /** Embed structured document text ([kind] content | …) instead of raw
   *  content (roadmap W2 item 5). Document-side only; queries stay raw. */
  contextualEmbed?: boolean;
  /** Include per-question evidence/ranked id lists for auditability (default
   *  true; lists capped at max(ks)). */
  audit?: boolean;
}

export interface BenchmarkRun {
  variant: Variant;
  /** What actually ran — 'hybrid-fts-fallback' when hybrid had no embeddings */
  variantLabel: string;
  contextualEmbed: boolean;
  corpusMode: CorpusMode;
  ks: number[];
  poolSize: number;
  candidatesPerRetriever: number;
  embedded: boolean;
  perQuestion: QuestionMetrics[];
  aggregates: AggregateMetrics;
}

async function embedStore(store: QuestionStore, embedFn: EmbedFn, contextualEmbed: boolean): Promise<void> {
  const rows = store.db.prepare('SELECT id, content, kind FROM memories').all() as Array<{ id: string; content: string; kind: string }>;
  // Stamp the active model (v26): vector reads filter on it — an unstamped
  // benchmark corpus would be invisible to the vector leg entirely.
  const stmt = store.db.prepare('UPDATE memories SET embedding = ?, embedding_model = ? WHERE id = ?');
  const modelKey = getEmbeddingModelConfig().key;
  for (const row of rows) {
    // Contextual mode embeds the structured document text; on this corpus
    // (kind-only, no context/fingerprints) it degenerates to a "[kind] "
    // prefix — see utils/contextual-embed.ts. Queries always embed raw.
    const docText = contextualEmbed ? buildContextualEmbedText({ kind: row.kind, content: row.content }) : row.content;
    stmt.run(embeddingToBuffer(await embedFn(docText, 'document')), modelKey, row.id);
  }
}

function retrieve(store: QuestionStore, question: string, variant: Variant, poolSize: number, queryEmbedding: Buffer | null): Array<{ id: string; content: string }> {
  const options = { project: LME_PROJECT, maxResults: poolSize, minConfidence: 0, readOnly: true };
  const results = variant === 'fts'
    ? store.repo.search(question, options)
    : store.repo.recallHybrid(question, queryEmbedding, options);
  return results.map(r => ({ id: r.memory.id, content: r.memory.content }));
}

/** Rerank the RRF top-RERANK.CANDIDATES window; the pool tail keeps its
 *  order. A null rerankFn result is a hard failure — a "hybrid+rerank"
 *  report whose rerank silently fell back would be mislabeled. The
 *  returned ids must be an EXACT one-to-one permutation of the input
 *  window: an omitted, duplicated, or injected id would silently corrupt
 *  the ranking the report is scored on. */
async function applyRerank(question: string, ranked: Array<{ id: string; content: string }>, rerankFn: RerankFn): Promise<string[]> {
  const window = ranked.slice(0, RERANK.CANDIDATES).map((r, i) => ({ id: r.id, text: r.content, rank: i }));
  const reordered = await rerankFn(question, window);
  if (reordered === null) {
    throw new Error('rerank requested but reranker unavailable — refusing to score a mislabeled run');
  }
  const windowIds = new Set(window.map(w => w.id));
  const returnedIds = new Set(reordered.map(c => c.id));
  if (reordered.length !== window.length || returnedIds.size !== reordered.length) {
    throw new Error(`rerank result is not a permutation of its window (${window.length} in, ${reordered.length} out, ${returnedIds.size} unique)`);
  }
  for (const c of reordered) {
    if (!windowIds.has(c.id)) {
      throw new Error(`rerank result contains id "${c.id}" that was not in its window`);
    }
  }
  return [...reordered.map(c => c.id), ...ranked.slice(RERANK.CANDIDATES).map(r => r.id)];
}

const turnKey = (t: TurnRef): string => turnDocId(t.sessionId, t.turnIdx);
/** Distinguishes occurrences of duplicated sessions (turn doc ids collide). */
const occurrenceKey = (t: TurnRef): string => `${t.sessionId}#${t.occurrence}#${t.turnIdx}`;

function scoreQuestion(q: LmeQuestion, store: QuestionStore, rankedMemoryIds: string[], ks: number[], auditCap: number): QuestionMetrics {
  // Collapse split chunks of ONE turn occurrence; PRESERVE separate
  // occurrences of duplicated sessions — upstream keeps every corpus copy,
  // so duplicates consume ranking positions in official_compat.
  const rankedOccurrences = uniqueStable(
    rankedMemoryIds.map(id => store.memoryToTurn.get(id)).filter((t): t is TurnRef => t !== undefined),
    occurrenceKey,
  );
  /** official_compat ranking: one entry per retrieved occurrence — duplicate
   *  doc ids stay in the list, exactly as in the upstream flat corpus. */
  const officialRankedTurnIds = rankedOccurrences.map(turnKey);
  // unique_session ranking: fully deduplicated by doc id / session id
  const rankedTurns = uniqueStable(rankedOccurrences, turnKey);
  const rankedTurnIds = rankedTurns.map(turnKey);
  const rankedSessions = uniqueStable(rankedOccurrences.map(t => t.sessionId), s => s);
  const evidenceSessions = [...new Set(q.answer_session_ids)];

  // Official semantics: only evidence turns whose session is in the answer
  // set count; a question whose evidence has no labeled turns in this corpus
  // is excluded from official_compat entirely (upstream renames those
  // sessions out of the answer id space).
  const answerSet = new Set(evidenceSessions);
  const officialEvidenceTurns = store.evidenceTurns.filter(t => answerSet.has(t.sessionId));
  const noEvidenceTurns = officialEvidenceTurns.length === 0;

  const row: QuestionMetrics = {
    questionId: q.question_id,
    questionType: q.question_type,
    abstention: false,
  };
  if (noEvidenceTurns) row.noEvidenceTurns = true;

  // unique_session namespace — session metrics always; turn metrics only
  // when labeled evidence turns exist in this corpus
  const unique: NamespaceScores = { sessionRecallAll: {}, sessionNdcg: {} };
  for (const k of ks) {
    unique.sessionRecallAll[k] = recallAllAtK(evidenceSessions, rankedSessions, k);
    unique.sessionNdcg[k] = ndcgAnyAtK(evidenceSessions, rankedSessions, k);
  }
  if (!noEvidenceTurns) {
    // unique namespace dedups evidence ids too — a duplicated evidence
    // session (none in the pinned data, but possible) must not inflate the
    // ideal-DCG hit count.
    const evidenceTurnIds = [...new Set(officialEvidenceTurns.map(turnKey))];
    const tr: ScoreByK = {}, tn: ScoreByK = {};
    for (const k of ks) {
      tr[k] = recallAllAtK(evidenceTurnIds, rankedTurnIds, k);
      tn[k] = ndcgAnyAtK(evidenceTurnIds, rankedTurnIds, k);
    }
    unique.turnRecallAll = tr;
    unique.turnNdcg = tn;
  }
  row.unique = unique;

  // official_compat namespace — skipped entirely without labeled evidence.
  // Ranked AND corpus lists keep one entry per occurrence (duplicate doc ids
  // included), mirroring the upstream flat corpus.
  if (!noEvidenceTurns) {
    const corpusTurnIds = store.corpusTurns.map(turnKey);
    const correctTurnIds = officialEvidenceTurns.map(turnKey);
    const official: NamespaceScores = {
      sessionRecallAll: {}, sessionNdcg: {}, turnRecallAll: {}, turnNdcg: {},
    };
    for (const k of ks) {
      const turn = evaluateRetrieval(officialRankedTurnIds, correctTurnIds, corpusTurnIds, k);
      official.turnRecallAll![k] = turn.recallAll;
      official.turnNdcg![k] = turn.ndcg;
      const session = evaluateTurn2Session(officialRankedTurnIds, correctTurnIds, corpusTurnIds, k);
      official.sessionRecallAll[k] = session.recallAll;
      official.sessionNdcg[k] = session.ndcg;
    }
    row.official = official;
  }

  if (auditCap > 0) {
    row.audit = {
      evidenceSessions,
      evidenceTurnIds: officialEvidenceTurns.map(turnKey),
      rankedSessions: rankedSessions.slice(0, auditCap),
      // occurrence-preserving (official_compat) form — duplicate ids visible
      rankedTurnIds: officialRankedTurnIds.slice(0, auditCap),
    };
  }
  return row;
}

export async function runBenchmark(questions: LmeQuestion[], options: RunnerOptions): Promise<BenchmarkRun> {
  const ks = options.ks ?? DEFAULT_KS;
  const poolSize = options.poolSize ?? DEFAULT_POOL_SIZE;
  const corpusMode = options.corpusMode ?? 'user-only';
  // Fail closed HERE, not only in the CLI: contextual mode changes the
  // embedded document text, which is meaningless without real hybrid
  // embeddings — a programmatic caller must not get a silently-raw run
  // labeled +ctx.
  if (options.contextualEmbed && (options.variant !== 'hybrid' || !options.embedFn)) {
    throw new Error('contextualEmbed requires variant "hybrid" with an embedFn — it changes the embedded document text');
  }
  const auditCap = options.audit === false ? 0 : Math.max(...ks);
  const subset = options.maxQuestions ? questions.slice(0, options.maxQuestions) : questions;
  const perQuestion: QuestionMetrics[] = [];

  for (const q of subset) {
    if (isAbstention(q)) {
      perQuestion.push({ questionId: q.question_id, questionType: q.question_type, abstention: true });
      continue;
    }
    const store = buildQuestionStore(q, { corpusMode });
    try {
      if (options.embedFn) await embedStore(store, options.embedFn, options.contextualEmbed === true);
      const queryEmbedding = options.variant === 'hybrid' && options.embedFn
        ? embeddingToBuffer(await options.embedFn(q.question, 'query'))
        : null;
      const ranked = retrieve(store, q.question, options.variant, poolSize, queryEmbedding);
      const rankedMemoryIds = options.rerankFn
        ? await applyRerank(q.question, ranked, options.rerankFn)
        : ranked.map(r => r.id);
      perQuestion.push(scoreQuestion(q, store, rankedMemoryIds, ks, auditCap));
    } finally {
      store.close();
    }
  }

  const baseLabel = options.variant === 'hybrid' && !options.embedFn ? 'hybrid-fts-fallback' : options.variant;
  const suffixes = `${options.rerankFn ? '+rerank' : ''}${options.contextualEmbed ? '+ctx' : ''}`;
  return {
    variant: options.variant,
    variantLabel: `${baseLabel}${suffixes}`,
    contextualEmbed: options.contextualEmbed === true,
    corpusMode,
    ks,
    poolSize,
    candidatesPerRetriever: HYBRID_SEARCH.CANDIDATES_PER_RETRIEVER,
    embedded: options.embedFn !== undefined,
    perQuestion,
    aggregates: aggregate(perQuestion, ks),
  };
}
