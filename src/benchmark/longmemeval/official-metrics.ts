/**
 * official_compat namespace — literal mirror of the upstream LongMemEval
 * evaluator (src/retrieval/eval_utils.py @ xiaowu0162/LongMemEval). Values
 * from these functions are directly comparable with published numbers.
 *
 * Upstream properties deliberately preserved, even where a "cleaner" metric
 * exists (that cleaner variant lives in metrics.ts as unique_session):
 *   - DCG discounts NOTHING at positions 1 and 2 (divisor log2(position),
 *     and log2(2) = 1): a single evidence item at rank 2 scores NDCG 1.0.
 *   - Ideal DCG sorts the FULL corpus relevance vector, then truncates at k.
 *   - turn2session strips the trailing "_<turn>" segment, expands the ranked
 *     prefix until it covers k unique sessions (or the corpus is exhausted),
 *     and evaluates at that effective k over the STRIPPED ids — repeated
 *     session hits each contribute gain.
 *
 * Caveat: upstream assumes an exhaustive ranking of the whole corpus. Our
 * rankings are pool-limited and FTS drops non-matching documents entirely, so
 * official_compat numbers here are conservative (missing tail = zero gain).
 */

export interface OfficialScores {
  recallAny: number;
  recallAll: number;
  ndcg: number;
}

/** Mirror of eval_utils.dcg(): relevances[0] + Σ_{i≥1} relevances[i]/log2(i+1). */
export function officialDcg(relevances: number[], k: number): number {
  const r = relevances.slice(0, k);
  if (r.length === 0) return 0;
  let sum = r[0];
  for (let i = 1; i < r.length; i++) {
    sum += r[i] / Math.log2(i + 1);
  }
  return sum;
}

/** Mirror of eval_utils.evaluate_retrieval(). `rankedIds` is the retrieval
 *  ranking (doc ids, best first); `corpusIds` is the full corpus in corpus
 *  order — the ideal-DCG denominator counts every relevant corpus doc. */
export function evaluateRetrieval(
  rankedIds: string[],
  correctIds: string[],
  corpusIds: string[],
  k: number,
): OfficialScores {
  const correct = new Set(correctIds);
  const recalled = new Set(rankedIds.slice(0, k));
  const recallAny = correctIds.some(id => recalled.has(id)) ? 1 : 0;
  const recallAll = correctIds.length > 0 && correctIds.every(id => recalled.has(id)) ? 1 : 0;

  const actual = rankedIds.slice(0, k).map(id => (correct.has(id) ? 1 : 0));
  const ideal = corpusIds.map(id => (correct.has(id) ? 1 : 0)).sort((a, b) => b - a);
  const idealDcg = officialDcg(ideal, k);
  const ndcg = idealDcg === 0 ? 0 : officialDcg(actual, k) / idealDcg;

  return { recallAny, recallAll, ndcg };
}

/** Mirror of eval_utils.evaluate_retrieval_turn2session(): strip turn suffix,
 *  expand the prefix until it holds k unique sessions, evaluate at that
 *  effective k over stripped (repeat-preserving) ids. */
export function evaluateTurn2Session(
  rankedTurnIds: string[],
  correctTurnIds: string[],
  corpusTurnIds: string[],
  k: number,
): OfficialScores {
  const strip = (docId: string): string => {
    const cut = docId.lastIndexOf('_');
    return cut === -1 ? docId : docId.slice(0, cut);
  };
  const correctSessions = [...new Set(correctTurnIds.map(strip))];
  const corpusSessions = corpusTurnIds.map(strip);
  const rankedSessions = rankedTurnIds.map(strip);

  let effectiveK = k;
  let unique = new Set(rankedSessions.slice(0, effectiveK));
  while (effectiveK <= corpusSessions.length && unique.size < k) {
    effectiveK += 1;
    unique = new Set(rankedSessions.slice(0, effectiveK));
  }

  return evaluateRetrieval(rankedSessions, correctSessions, corpusSessions, effectiveK);
}

/** Official turn doc id: sessionId + "_" + (1-indexed ORIGINAL turn position),
 *  matching run_retrieval.py's enumerate over the full session. */
export function turnDocId(sessionId: string, turnIdx: number): string {
  return `${sessionId}_${turnIdx + 1}`;
}
