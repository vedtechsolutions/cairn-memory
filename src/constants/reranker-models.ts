/**
 * Cross-encoder reranker registry (roadmap W2 slice 4). Reranking is
 * opt-in (CAIRN_RERANK=1), MCP-server only — hook paths never load models.
 * Model selected via CAIRN_RERANK_MODEL (default jina-turbo-v1).
 *
 * Default is jina-turbo-v1, NOT bge-base, reversing the roadmap's initial
 * pick on smoke evidence (2026-07-21, this hardware): bge-reranker-base
 * (278M params) measured +681 MB incremental RSS and 1132 ms p50 for a
 * complete 20-pair rerank — 2.3× the entire combined RSS budget and 7.5×
 * the 150 ms latency budget — while jina-turbo (38M) measured ~150–216 MB
 * and 158 ms p50, and won the ordering sanity probe.
 */

export interface RerankerModelConfig {
  key: string;
  hfPath: string;
  dtype: 'q8' | 'q4';
  /** sha256 manifest of the COMPLETE model package (relative cache path →
   *  hash). The HF path floats on main, and tokenizer/config changes alter
   *  rankings just as surely as weight changes — so provenance pins every
   *  file the pipeline loads, not only the ONNX weights. Benchmark runs
   *  verify the cached bytes against this manifest and refuse on any
   *  missing file or mismatch. */
  artifacts: Readonly<Record<string, string>>;
}

export const DEFAULT_RERANKER_MODEL_KEY = 'jina-turbo-v1';

export const RERANKER_MODELS: Readonly<Record<string, RerankerModelConfig>> = {
  'jina-turbo-v1': {
    key: 'jina-turbo-v1',
    hfPath: 'jinaai/jina-reranker-v1-turbo-en',
    dtype: 'q8',
    artifacts: {
      'config.json': 'e050ff6a15ae9295e84882fa0e98051bd8754856cd5201395ebf00ce9f2d609b',
      'tokenizer.json': '0046da43cc8c424b317f56b092b0512aaaa65c4f925d2f16af9d9eeb4d0ef902',
      'tokenizer_config.json': 'd291c6652d96d56ffdbcf1ea19d9bae5ed79003f7648c627e725a619227ce8fa',
      'onnx/model_quantized.onnx': '3defdef1ae34e119bd704216087743e79665934c96aebabcb6077c239dc3ae66',
    },
  },
  // Registered but disqualified on current hardware (see header) — kept for
  // A/B on faster machines.
  'bge-base': {
    key: 'bge-base',
    hfPath: 'Xenova/bge-reranker-base',
    dtype: 'q8',
    artifacts: {
      'config.json': 'b6575b9d5be20d6747417c8e20c5a0db1636356e0b6d422d7244c628423c4d4c',
      'tokenizer.json': '48564c5c7d3fa64d85d95e65414a542385f88b0f128fd8d4163fd7a57f2be05c',
      'tokenizer_config.json': 'a1d6bc8734a6f635dc158508bef000f8e2e5a759c7d92f984b2c86e5ff53425b',
      'onnx/model_quantized.onnx': 'dd98f3e67837d23210a6b7550c08cced4f61845b940ac45be3565840a10f3244',
    },
  },
} as const;

export const RERANK = {
  /** Candidates fed to the cross-encoder — the RRF top-N window. */
  CANDIDATES: 20,
  /** p50 budget for one COMPLETE candidate-window rerank (all pairs, one
   *  batched operation) — measured, not per pair. */
  LATENCY_BUDGET_MS: 150,
} as const;
