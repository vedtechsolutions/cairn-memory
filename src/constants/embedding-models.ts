/**
 * Embedding model registry (roadmap W2). Every model the embedding service
 * can run, keyed by the stable identifier stored per-row in schema v26's
 * embedding_model column. Selected via WAYKEEP_EMBEDDING_MODEL (default
 * minilm-l6); resolution and the schema-v26 activation gate live in
 * utils/embeddings.ts.
 *
 * Any registered model may be selected (schema v26): every stored vector is
 * tagged with its model, vector reads filter on the active model, and the
 * backfill worker re-embeds mismatched rows after a switch.
 */

export interface EmbeddingModelConfig {
  /** Registry key — also the per-row schema-v26 embedding_model value. */
  key: string;
  /** HuggingFace repo path loaded by transformers.js feature-extraction. */
  hfPath: string;
  /** Stored/queried vector dimension. Smaller than nativeDim for MRL
   *  (matryoshka) models — vectors are truncated then renormalized. */
  dim: number;
  /** Model's native output dimension (equals dim when no truncation). */
  nativeDim: number;
  /** Quantization loaded via transformers.js dtype option. */
  dtype: 'q8' | 'q4';
  /** Asymmetric task prefix prepended to QUERY inputs ('' = symmetric). */
  queryPrefix: string;
  /** Asymmetric task prefix prepended to DOCUMENT inputs ('' = symmetric). */
  documentPrefix: string;
  /** sha256 manifest of the COMPLETE model package (relative cache path →
   *  hash) — every file transformers.js feature-extraction loads. The HF
   *  path floats on main; production loads verify the cached package and
   *  REFUSE to embed with an unpinned or drifted one. Pins were computed
   *  from the exact cached bytes the W2 benchmarks ran against. A model
   *  registered WITHOUT a manifest cannot load in production. */
  artifacts?: Readonly<Record<string, string>>;
}

/** nomic-v1.5 and nomic-v1.5-256 load the SAME package — the variants
 *  differ only in stored/queried MRL dimension. */
const NOMIC_V15_ARTIFACTS: Readonly<Record<string, string>> = {
  'config.json': '9ab00bd92cee80a569f708140b7b6c1661a65891ff3765b1519e181ba2f2c92b',
  'tokenizer.json': 'd241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66',
  'tokenizer_config.json': 'd7e0000bcc80134debd2222220427e6bf5fa20a669f40a0d0d1409cc18e0a9bc',
  'onnx/model_quantized.onnx': 'b4342336debaea79de872370664b0aaeb67dea4605513d00ee236ea871a81f27',
};

export const DEFAULT_EMBEDDING_MODEL_KEY = 'minilm-l6';

/** Challenger prefix strings verified against the official model cards
 *  (external review, 2026-07-21). */
export const EMBEDDING_MODELS: Readonly<Record<string, EmbeddingModelConfig>> = {
  'minilm-l6': {
    key: 'minilm-l6',
    hfPath: 'Xenova/all-MiniLM-L6-v2',
    dim: 384,
    nativeDim: 384,
    dtype: 'q8',
    queryPrefix: '',
    documentPrefix: '',
    artifacts: {
      'config.json': '7135149f7cffa1a573466c6e4d8423ed73b62fd2332c575bf738a0d033f70df7',
      'tokenizer.json': 'da0e79933b9ed51798a3ae27893d3c5fa4a201126cef75586296df9b4d2c62a0',
      'tokenizer_config.json': '9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3',
      'onnx/model_quantized.onnx': 'afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1',
    },
  },
  // Codex-picked first challenger: Apache-2.0, q8, 512 MRL dims initially
  'nomic-v1.5': {
    key: 'nomic-v1.5',
    hfPath: 'nomic-ai/nomic-embed-text-v1.5',
    dim: 512,
    nativeDim: 768,
    dtype: 'q8',
    queryPrefix: 'search_query: ',
    documentPrefix: 'search_document: ',
    artifacts: NOMIC_V15_ARTIFACTS,
  },
  // 256-dim MRL variant (W2 close-out step 3): same weights and RAM as
  // nomic-v1.5 — only the stored/queried vector shrinks. Distinct key so
  // v26 per-row tagging isolates it from 512-dim nomic vectors.
  'nomic-v1.5-256': {
    key: 'nomic-v1.5-256',
    hfPath: 'nomic-ai/nomic-embed-text-v1.5',
    dim: 256,
    nativeDim: 768,
    dtype: 'q8',
    queryPrefix: 'search_query: ',
    documentPrefix: 'search_document: ',
    artifacts: NOMIC_V15_ARTIFACTS,
  },
  // Second challenger: q4 only (fp16 unsupported in transformers.js).
  // DELIBERATELY UNPINNED — never benchmarked or cached here, so there are
  // no trusted bytes to pin. Production load refuses until a manifest is
  // added from verified bytes.
  'embeddinggemma-300m': {
    key: 'embeddinggemma-300m',
    hfPath: 'onnx-community/embeddinggemma-300m-ONNX',
    dim: 768,
    nativeDim: 768,
    dtype: 'q4',
    queryPrefix: 'task: search result | query: ',
    documentPrefix: 'title: none | text: ',
  },
} as const;

/** Matches torch's F.layer_norm default eps (the pooling normalization). */
export const LAYER_NORM_EPS = 1e-5;
