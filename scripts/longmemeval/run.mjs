#!/usr/bin/env node
/**
 * LongMemEval retrieval harness runner (roadmap W1 slice 3).
 *
 * Retrieval-only mode: isolated per-question in-memory stores, uniform
 * confidence, read-only queries — never touches the live store. Lifecycle
 * replay (decay/feedback active) is a separate future mode, NOT this script.
 *
 * Reports carry two metric namespaces:
 *   official_compat — exact upstream evaluator semantics (comparable with
 *                     published LongMemEval numbers)
 *   unique_session  — cleaner deduplicated standard metrics (Waykeep-internal)
 *
 * Usage:
 *   node scripts/longmemeval/run.mjs                              # fixture, fts, user-only corpus
 *   node scripts/longmemeval/run.mjs --variant hybrid             # labeled hybrid-fts-fallback
 *   node scripts/longmemeval/run.mjs --variant hybrid --embed     # real hybrid (loads local model)
 *   node scripts/longmemeval/run.mjs --corpus all-roles           # Waykeep experiment corpus
 *   node scripts/longmemeval/run.mjs --data ~/.waykeep/benchmarks/longmemeval/longmemeval_s_cleaned.json
 *   node scripts/longmemeval/run.mjs --k 5,10 --max-questions 20 --out report.json --md report.md
 *   node scripts/longmemeval/run.mjs --timestamp                  # stamp generated_at (omit for CI determinism)
 */
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateDataset } from '../../dist/src/benchmark/longmemeval/data.js';
import { runBenchmark } from '../../dist/src/benchmark/longmemeval/runner.js';
import { toJsonReport, toMarkdownReport } from '../../dist/src/benchmark/longmemeval/report.js';

const here = dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const argValue = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
};

const dataPath = argValue('--data') ?? join(here, 'fixture', 'harness-fixture.json');
const variant = argValue('--variant') ?? 'fts';
if (variant !== 'fts' && variant !== 'hybrid') {
  console.error(`Unknown variant "${variant}" — use fts or hybrid.`);
  process.exit(1);
}
const corpusMode = argValue('--corpus') ?? 'user-only';
if (corpusMode !== 'user-only' && corpusMode !== 'all-roles') {
  console.error(`Unknown corpus mode "${corpusMode}" — use user-only or all-roles.`);
  process.exit(1);
}
const ks = (argValue('--k') ?? '5,10').split(',').map(Number);
const maxQuestions = argValue('--max-questions') ? Number(argValue('--max-questions')) : undefined;
const outPath = argValue('--out');
const mdPath = argValue('--md');
const wantTimestamp = args.includes('--timestamp');

let embedFn;
let embeddingMeta;
if (args.includes('--embed')) {
  const { embed, warmupEmbeddings, getEmbeddingModelConfig } = await import('../../dist/src/utils/embeddings.js');
  warmupEmbeddings();
  embedFn = (text, role) => embed(text, role);
  const config = getEmbeddingModelConfig();
  embeddingMeta = { model: config.hfPath, dim: config.dim, dtype: config.dtype };
}

const contextualEmbed = args.includes('--contextual');
if (contextualEmbed && (!args.includes('--embed') || variant !== 'hybrid')) {
  console.error('--contextual requires --variant hybrid --embed (it changes the embedded document text).');
  process.exit(1);
}

let rerankFn;
let rerankerMeta;
if (args.includes('--rerank')) {
  if (variant !== 'hybrid') {
    console.error('--rerank requires --variant hybrid (the RRF pipeline is what gets reranked).');
    process.exit(1);
  }
  const { rerank, loadReranker, verifyArtifacts, getRerankerModelConfig } = await import('../../dist/src/utils/reranker.js');
  const config = getRerankerModelConfig();
  // Provenance: LOAD first (a clean cache legitimately downloads here),
  // then stream-verify the COMPLETE cached model package — weights AND
  // tokenizer/config files — against the registry manifest before any
  // scoring. The HF path floats on main; the manifest does not.
  await loadReranker();
  const cacheDir = join(here, '..', '..', 'node_modules', '@huggingface', 'transformers', '.cache', config.hfPath);
  let artifacts;
  try {
    artifacts = await verifyArtifacts(cacheDir, config.artifacts);
  } catch (err) {
    console.error(`Reranker provenance check failed: ${err.message}`);
    process.exit(1);
  }
  rerankFn = (query, candidates) => rerank(query, candidates);
  rerankerMeta = { model: config.hfPath, dtype: config.dtype, artifacts };
}

// Reproducibility metadata: manifest pin (when running a manifest-listed
// file), harness commit + package version. All best-effort.
const manifest = JSON.parse(await readFile(join(here, 'manifest.json'), 'utf8'));
const manifestEntry = manifest.files[basename(dataPath)];
const pkg = JSON.parse(await readFile(join(here, '..', '..', 'package.json'), 'utf8'));
let harnessCommit;
try {
  harnessCommit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: here, encoding: 'utf8' }).trim();
} catch { /* not a git checkout — omit */ }

const raw = JSON.parse(await readFile(dataPath, 'utf8'));
const questions = validateDataset(raw);
console.error(`Loaded ${questions.length} questions from ${dataPath} (corpus: ${corpusMode}, variant: ${variant})`);

const run = await runBenchmark(questions, { variant, ks, maxQuestions, corpusMode, embedFn, rerankFn, contextualEmbed });

const meta = {
  dataset: basename(dataPath),
  ...(manifestEntry ? { datasetRevision: manifest.revision, datasetSha256: manifestEntry.sha256 } : {}),
  ...(harnessCommit ? { harnessCommit } : {}),
  harnessVersion: `waykeep@${pkg.version}`,
  ...(maxQuestions !== undefined ? { maxQuestions } : {}),
  ...(embeddingMeta ? { embedding: embeddingMeta } : {}),
  ...(rerankerMeta ? { reranker: rerankerMeta } : {}),
  ...(wantTimestamp ? { generatedAt: new Date().toISOString() } : {}),
};
const json = toJsonReport(run, meta);

if (outPath) {
  await writeFile(outPath, json);
  console.error(`JSON report written: ${outPath}`);
} else {
  process.stdout.write(json);
}
if (mdPath) {
  await writeFile(mdPath, toMarkdownReport(run, meta));
  console.error(`Markdown report written: ${mdPath}`);
}
