#!/usr/bin/env node
/**
 * Reranker resource probe (roadmap W2 slice 4) — reproducible latency/RSS
 * measurement for the ACTIVE reranker + embedder pair in ONE process.
 *
 * Method:
 *   - Loads the reranker from the registry (provenance manifest verified
 *     after load), then the embedder — combined incremental RSS is the
 *     budget-gate number; cache state at load is recorded because a cold
 *     first-download load measures higher than a warm steady-state load.
 *   - Times the COMPLETE 20-pair rerank operation (batch tokenize + model
 *     forward), never per pair: 3 untimed warmups, then N timed iterations
 *     (default 40) over TWO candidate sets — 'short' synthetic sentences
 *     and 'representative' windows sampled deterministically (mulberry32
 *     seed 42) from real dataset user turns capped at the ingestion chunk
 *     bound, matching what production top-20 windows actually contain.
 *   - Quantiles use the nearest-rank method on the ascending sort:
 *     index = ceil(q × n) − 1 (0-based). For n=40: p50 → index 19,
 *     p95 → index 37. Raw samples are retained in the output JSON.
 *   - RERANK_THREADS=<n> passes intraOpNumThreads to the ONNX session for
 *     score-preserving tuning experiments; the fixed check-set scores in
 *     the output let runs under different thread settings prove the
 *     ordering (and scores) are preserved.
 *
 * Usage:
 *   node scripts/longmemeval/resource-probe.mjs [--iterations 40] [--out probe.json] [--data <dataset.json>]
 */
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getRerankerModelConfig, verifyArtifacts } from '../../dist/src/utils/reranker.js';
import { MAX_TURN_CHARS, splitTurn } from '../../dist/src/benchmark/longmemeval/ingest.js';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const argValue = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
};
const ITERATIONS = Number(argValue('--iterations') ?? 40);
const WARMUPS = 3;
const WINDOW = 20;
const outPath = argValue('--out');
const dataPath = argValue('--data')
  ?? join(process.env.HOME ?? '', '.cairn', 'benchmarks', 'longmemeval', 'longmemeval_s_cleaned.json');

const mb = (b) => Math.round(b / 1024 / 1024);

/** Nearest-rank quantile on an ASCENDING sort: index = ceil(q·n) − 1. */
function quantile(sortedAsc, q) {
  return sortedAsc[Math.ceil(q * sortedAsc.length) - 1];
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- Load reranker (threads tunable), verify provenance ----------------------
const config = getRerankerModelConfig();
const cacheDir = join(here, '..', '..', 'node_modules', '@huggingface', 'transformers', '.cache', config.hfPath);
const cachePresentAtLoad = existsSync(join(cacheDir, 'onnx', 'model_quantized.onnx'));
const threads = process.env.RERANK_THREADS ? Number(process.env.RERANK_THREADS) : null;

const rss0 = process.memoryUsage.rss();
const t0 = performance.now();
const { AutoTokenizer, AutoModelForSequenceClassification } = await import('@huggingface/transformers');
const tokenizer = await AutoTokenizer.from_pretrained(config.hfPath);
const model = await AutoModelForSequenceClassification.from_pretrained(config.hfPath, {
  dtype: config.dtype,
  ...(threads ? { session_options: { intraOpNumThreads: threads } } : {}),
});
const loadMs = Math.round(performance.now() - t0);
const rss1 = process.memoryUsage.rss();
await verifyArtifacts(cacheDir, config.artifacts);

// --- Load embedder on top (combined budget measurement) ----------------------
const { embed, getEmbeddingModelConfig } = await import('../../dist/src/utils/embeddings.js');
await embed('resource probe embedder warmup sentence');
const rss2 = process.memoryUsage.rss();

// --- Candidate sets ----------------------------------------------------------
const shortSet = Array.from({ length: WINDOW }, (_, i) =>
  `Candidate memory number ${i} discussing topic ${i % 5} with some realistic sentence content about projects and decisions made during session ${i}.`);
let shortQuery = 'what decisions were made about the project during recent sessions';

let representativeSet = null;
let repQuery = null;
let repSource = 'unavailable';
if (existsSync(dataPath)) {
  const questions = JSON.parse(await readFile(dataPath, 'utf8'));
  const turns = [];
  for (const q of questions.slice(0, 50)) {
    for (const sess of q.haystack_sessions) {
      for (const t of sess) {
        if (t.role === 'user' && t.content.trim().length > 0) {
          turns.push(...splitTurn(t.content.trim(), MAX_TURN_CHARS));
        }
      }
    }
  }
  // Deterministic length-spanning sample: sort by length, take an evenly
  // spaced spread (seeded jitter) so the window covers the real length
  // distribution up to the chunk bound instead of only short texts.
  turns.sort((a, b) => a.length - b.length);
  const rand = mulberry32(42);
  representativeSet = Array.from({ length: WINDOW }, (_, i) => {
    const base = Math.floor((i + 0.5) * turns.length / WINDOW);
    const jitter = Math.floor((rand() - 0.5) * (turns.length / WINDOW));
    return turns[Math.min(turns.length - 1, Math.max(0, base + jitter))];
  });
  repQuery = questions.find((q) => !q.question_id.endsWith('_abs')).question;
  repSource = dataPath;
}

// --- Timed complete-window rerank operations ---------------------------------
async function rerankOnce(query, docs) {
  const inputs = tokenizer(new Array(docs.length).fill(query), {
    text_pair: docs, padding: true, truncation: true,
  });
  const { logits } = await model(inputs);
  return Array.from({ length: docs.length }, (_, i) => Number(logits.data[i]));
}

async function measure(query, docs) {
  for (let i = 0; i < WARMUPS; i++) await rerankOnce(query, docs);
  const raw = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const s = performance.now();
    await rerankOnce(query, docs);
    raw.push(Math.round((performance.now() - s) * 100) / 100);
  }
  const sorted = [...raw].sort((a, b) => a - b);
  return { raw, p50: quantile(sorted, 0.5), p95: quantile(sorted, 0.95) };
}

const short = await measure(shortQuery, shortSet);
const representative = representativeSet ? await measure(repQuery, representativeSet) : null;

// --- Score-preservation check set (compare across thread settings) -----------
const checkDocs = (representativeSet ?? shortSet).slice(0, 8);
const checkScores = (await rerankOnce(repQuery ?? shortQuery, checkDocs)).map((s) => Number(s.toFixed(6)));

const result = {
  probe: 'reranker-resource-probe',
  quantile_method: 'nearest-rank: index = ceil(q*n)-1 on ascending sort',
  reranker: { model: config.hfPath, dtype: config.dtype, key: config.key },
  embedder: getEmbeddingModelConfig().key,
  threads: threads ?? 'default',
  cache_present_at_load: cachePresentAtLoad,
  load_ms: loadMs,
  rss_mb: { reranker_incremental: mb(rss1 - rss0), embedder_incremental: mb(rss2 - rss1), combined_incremental: mb(rss2 - rss0) },
  iterations: ITERATIONS,
  window: WINDOW,
  latency_ms: {
    short: { p50: short.p50, p95: short.p95, raw: short.raw },
    representative: representative
      ? { source: repSource, p50: representative.p50, p95: representative.p95, raw: representative.raw }
      : { source: repSource },
  },
  score_check: { query: repQuery ?? shortQuery, scores: checkScores },
};

const json = JSON.stringify(result, null, 2) + '\n';
if (outPath) {
  await writeFile(outPath, json);
  console.error(`probe written: ${outPath}`);
} else {
  process.stdout.write(json);
}
console.error(`[summary] threads=${result.threads} cold=${!cachePresentAtLoad} combined=${result.rss_mb.combined_incremental}MB short p50/p95=${short.p50}/${short.p95}ms${representative ? ` representative p50/p95=${representative.p50}/${representative.p95}ms` : ''}`);
