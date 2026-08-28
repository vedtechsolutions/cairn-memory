/**
 * unique_session namespace + cross-namespace aggregation (roadmap W1).
 *
 * unique_session is the cleaner, deduplicated STANDARD metric family: the
 * memory ranking is collapsed to unique sessions/turns (first occurrence,
 * rank-preserving) and scored with textbook binary NDCG (log2(i+2) discount,
 * ideal = min(|evidence|, k) ones). These values are NOT comparable with
 * published LongMemEval numbers — the upstream-faithful family lives in
 * official-metrics.ts (official_compat). Reports carry both, namespaced.
 */

/** First-occurrence stable dedup — collapse a memory ranking into a unique
 *  session/turn ranking without disturbing rank order. */
export function uniqueStable<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const k = key(item);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(item);
    }
  }
  return out;
}

export function recallAllAtK(evidence: string[], rankedUnique: string[], k: number): 0 | 1 {
  if (evidence.length === 0) return 0;
  const top = new Set(rankedUnique.slice(0, k));
  return evidence.every(id => top.has(id)) ? 1 : 0;
}

/** Standard binary NDCG@k (log2(i+2) discount, i 0-based; ideal places
 *  min(|evidence|, k) relevant items on top). */
export function ndcgAnyAtK(evidence: string[], rankedUnique: string[], k: number): number {
  if (evidence.length === 0) return 0;
  const evidenceSet = new Set(evidence);
  let dcg = 0;
  rankedUnique.slice(0, k).forEach((id, i) => {
    if (evidenceSet.has(id)) dcg += 1 / Math.log2(i + 2);
  });
  let idcg = 0;
  const idealHits = Math.min(evidence.length, k);
  for (let i = 0; i < idealHits; i++) {
    idcg += 1 / Math.log2(i + 2);
  }
  return idcg === 0 ? 0 : dcg / idcg;
}

export type ScoreByK = Record<number, number>;

export interface NamespaceScores {
  sessionRecallAll: ScoreByK;
  sessionNdcg: ScoreByK;
  turnRecallAll?: ScoreByK;
  turnNdcg?: ScoreByK;
}

export interface QuestionAudit {
  evidenceSessions: string[];
  evidenceTurnIds: string[];
  rankedSessions: string[];
  rankedTurnIds: string[];
}

export interface QuestionMetrics {
  questionId: string;
  questionType: string;
  abstention: boolean;
  /** Non-abstention question with zero labeled evidence turns in the selected
   *  corpus — excluded from official_compat entirely (upstream renames such
   *  sessions out of the answer set) and from turn-level unique metrics;
   *  unique_session SESSION metrics still score it via answer_session_ids. */
  noEvidenceTurns?: boolean;
  official?: NamespaceScores;
  unique?: NamespaceScores;
  audit?: QuestionAudit;
}

export interface NamespaceAggregate {
  scored: number;
  sessionRecallAll: ScoreByK;
  sessionNdcg: ScoreByK;
  turnScored: number;
  turnRecallAll: ScoreByK;
  turnNdcg: ScoreByK;
  /** question_type → session recall_all averages */
  byType: Record<string, { scored: number; sessionRecallAll: ScoreByK }>;
}

export interface AggregateMetrics {
  questions: number;
  skippedAbstention: number;
  skippedNoEvidenceTurns: number;
  official: NamespaceAggregate;
  unique: NamespaceAggregate;
}

const mean = (values: number[]): number =>
  values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;

function aggregateNamespace(
  rows: QuestionMetrics[],
  pick: (r: QuestionMetrics) => NamespaceScores | undefined,
  ks: number[],
): NamespaceAggregate {
  const scored = rows.filter(r => pick(r) !== undefined);
  const withTurns = scored.filter(r => pick(r)?.turnRecallAll !== undefined);

  const sessionRecallAll: ScoreByK = {};
  const sessionNdcg: ScoreByK = {};
  const turnRecallAll: ScoreByK = {};
  const turnNdcg: ScoreByK = {};
  for (const k of ks) {
    sessionRecallAll[k] = mean(scored.map(r => pick(r)!.sessionRecallAll[k] ?? 0));
    sessionNdcg[k] = mean(scored.map(r => pick(r)!.sessionNdcg[k] ?? 0));
    turnRecallAll[k] = mean(withTurns.map(r => pick(r)!.turnRecallAll![k] ?? 0));
    turnNdcg[k] = mean(withTurns.map(r => pick(r)!.turnNdcg![k] ?? 0));
  }

  const byType: NamespaceAggregate['byType'] = {};
  for (const row of scored) {
    byType[row.questionType] ??= { scored: 0, sessionRecallAll: {} };
    byType[row.questionType].scored++;
  }
  for (const [type, entry] of Object.entries(byType)) {
    const typeRows = scored.filter(r => r.questionType === type);
    for (const k of ks) {
      entry.sessionRecallAll[k] = mean(typeRows.map(r => pick(r)!.sessionRecallAll[k] ?? 0));
    }
  }

  return {
    scored: scored.length, sessionRecallAll, sessionNdcg,
    turnScored: withTurns.length, turnRecallAll, turnNdcg, byType,
  };
}

export function aggregate(rows: QuestionMetrics[], ks: number[]): AggregateMetrics {
  return {
    questions: rows.length,
    skippedAbstention: rows.filter(r => r.abstention).length,
    skippedNoEvidenceTurns: rows.filter(r => r.noEvidenceTurns === true).length,
    official: aggregateNamespace(rows, r => r.official, ks),
    unique: aggregateNamespace(rows, r => r.unique, ks),
  };
}
