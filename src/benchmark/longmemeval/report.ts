/**
 * Deterministic report rendering (roadmap W1 slice 3). Byte-identical output
 * for identical runs: no timestamps unless the caller injects one explicitly
 * (CI passes none), stable key order, fixed precision.
 *
 * A recorded baseline must be auditable and reproducible, so meta carries the
 * dataset revision + sha256 (from the manifest), the harness commit/version,
 * corpus + variant modes, pool/candidate depths, and embedding identity when
 * enabled; per-question rows carry evidence and ranked ids (capped).
 */
import type { BenchmarkRun } from './runner.js';
import type { NamespaceAggregate, NamespaceScores, ScoreByK } from './metrics.js';

export interface ReportMeta {
  dataset: string;
  datasetRevision?: string;
  datasetSha256?: string;
  harnessCommit?: string;
  harnessVersion?: string;
  maxQuestions?: number;
  embedding?: { model: string; dim: number; dtype: string };
  /** artifacts = complete-package sha256 manifest (relative cache path →
   *  hash) — immutable provenance; the HF path alone is floating. */
  reranker?: { model: string; dtype: string; artifacts?: Record<string, string> };
  /** Injected by non-CI callers; omitted entirely when absent */
  generatedAt?: string;
}

const fmt = (n: number): number => Number(n.toFixed(4));
const byK = (ks: number[], scores: ScoreByK | undefined): Record<string, number> =>
  Object.fromEntries(ks.map(k => [k, fmt(scores?.[k] ?? 0)]));

function namespaceBlock(ks: number[], agg: NamespaceAggregate): Record<string, unknown> {
  return {
    scored: agg.scored,
    turn_scored: agg.turnScored,
    session_recall_all: byK(ks, agg.sessionRecallAll),
    session_ndcg_any: byK(ks, agg.sessionNdcg),
    turn_recall_all: byK(ks, agg.turnRecallAll),
    turn_ndcg_any: byK(ks, agg.turnNdcg),
    by_type: Object.fromEntries(
      Object.entries(agg.byType).sort(([a], [b]) => a.localeCompare(b)).map(([type, entry]) => [
        type,
        { scored: entry.scored, session_recall_all: byK(ks, entry.sessionRecallAll) },
      ]),
    ),
  };
}

function questionNamespace(ks: number[], scores: NamespaceScores | undefined): Record<string, unknown> | undefined {
  if (!scores) return undefined;
  return {
    session_recall_all: byK(ks, scores.sessionRecallAll),
    session_ndcg_any: byK(ks, scores.sessionNdcg),
    ...(scores.turnRecallAll ? { turn_recall_all: byK(ks, scores.turnRecallAll) } : {}),
    ...(scores.turnNdcg ? { turn_ndcg_any: byK(ks, scores.turnNdcg) } : {}),
  };
}

export function toJsonReport(run: BenchmarkRun, meta: ReportMeta): string {
  const ordered = {
    meta: {
      dataset: meta.dataset,
      ...(meta.datasetRevision ? { dataset_revision: meta.datasetRevision } : {}),
      ...(meta.datasetSha256 ? { dataset_sha256: meta.datasetSha256 } : {}),
      ...(meta.harnessCommit ? { harness_commit: meta.harnessCommit } : {}),
      ...(meta.harnessVersion ? { harness_version: meta.harnessVersion } : {}),
      variant: run.variant,
      variant_label: run.variantLabel,
      corpus_mode: run.corpusMode,
      embedded: run.embedded,
      ...(run.contextualEmbed ? { contextual_embed: true } : {}),
      ...(meta.embedding ? { embedding: meta.embedding } : {}),
      ...(meta.reranker ? { reranker: meta.reranker } : {}),
      ks: run.ks,
      pool_size: run.poolSize,
      candidates_per_retriever: run.candidatesPerRetriever,
      ...(meta.maxQuestions !== undefined ? { max_questions: meta.maxQuestions } : {}),
      ...(meta.generatedAt ? { generated_at: meta.generatedAt } : {}),
    },
    aggregates: {
      questions: run.aggregates.questions,
      skipped_abstention: run.aggregates.skippedAbstention,
      skipped_no_evidence_turns: run.aggregates.skippedNoEvidenceTurns,
      official_compat: namespaceBlock(run.ks, run.aggregates.official),
      unique_session: namespaceBlock(run.ks, run.aggregates.unique),
    },
    per_question: run.perQuestion.map(row => ({
      question_id: row.questionId,
      question_type: row.questionType,
      abstention: row.abstention,
      ...(row.noEvidenceTurns ? { no_evidence_turns: true } : {}),
      ...(row.official ? { official_compat: questionNamespace(run.ks, row.official) } : {}),
      ...(row.unique ? { unique_session: questionNamespace(run.ks, row.unique) } : {}),
      ...(row.audit ? {
        audit: {
          evidence_sessions: row.audit.evidenceSessions,
          evidence_turn_ids: row.audit.evidenceTurnIds,
          ranked_sessions: row.audit.rankedSessions,
          ranked_turn_ids: row.audit.rankedTurnIds,
        },
      } : {}),
    })),
  };
  return JSON.stringify(ordered, null, 2) + '\n';
}

export function toMarkdownReport(run: BenchmarkRun, meta: ReportMeta): string {
  const lines: string[] = [];
  lines.push(`# LongMemEval retrieval report — ${run.variantLabel}`);
  lines.push('');
  lines.push(`Dataset: ${meta.dataset}${meta.datasetRevision ? ` @ ${meta.datasetRevision.slice(0, 12)}` : ''} | corpus: ${run.corpusMode} | embedded: ${run.embedded} | pool: ${run.poolSize}`);
  if (meta.reranker) {
    const onnxSha = meta.reranker.artifacts?.['onnx/model_quantized.onnx'];
    lines.push(`Reranker: ${meta.reranker.model} (${meta.reranker.dtype}${onnxSha ? `, artifact ${onnxSha.slice(0, 12)}…` : ''})`);
  }
  if (meta.harnessCommit || meta.harnessVersion) {
    lines.push(`Harness: ${meta.harnessVersion ?? ''}${meta.harnessCommit ? ` @ ${meta.harnessCommit}` : ''}`);
  }
  lines.push(`Questions: ${run.aggregates.questions} (abstention skipped ${run.aggregates.skippedAbstention}, no-evidence-turn skipped ${run.aggregates.skippedNoEvidenceTurns})`);
  if (meta.generatedAt) lines.push(`Generated: ${meta.generatedAt}`);
  lines.push('');
  for (const [name, agg] of [['official_compat', run.aggregates.official], ['unique_session', run.aggregates.unique]] as const) {
    lines.push(`## ${name} (scored ${agg.scored}, turn-scored ${agg.turnScored})`);
    lines.push('');
    lines.push(`| metric | ${run.ks.map(k => `@${k}`).join(' | ')} |`);
    lines.push(`|---|${run.ks.map(() => '---').join('|')}|`);
    lines.push(`| session recall_all | ${run.ks.map(k => fmt(agg.sessionRecallAll[k] ?? 0)).join(' | ')} |`);
    lines.push(`| session ndcg_any | ${run.ks.map(k => fmt(agg.sessionNdcg[k] ?? 0)).join(' | ')} |`);
    lines.push(`| turn recall_all | ${run.ks.map(k => fmt(agg.turnRecallAll[k] ?? 0)).join(' | ')} |`);
    lines.push(`| turn ndcg_any | ${run.ks.map(k => fmt(agg.turnNdcg[k] ?? 0)).join(' | ')} |`);
    lines.push('');
    const types = Object.entries(agg.byType).sort(([a], [b]) => a.localeCompare(b));
    if (types.length > 0) {
      lines.push(`| ability (session recall_all) | scored | ${run.ks.map(k => `@${k}`).join(' | ')} |`);
      lines.push(`|---|---|${run.ks.map(() => '---').join('|')}|`);
      for (const [type, entry] of types) {
        lines.push(`| ${type} | ${entry.scored} | ${run.ks.map(k => fmt(entry.sessionRecallAll[k] ?? 0)).join(' | ')} |`);
      }
      lines.push('');
    }
  }
  return lines.join('\n');
}
