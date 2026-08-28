/**
 * Embedding service — lazy singleton for local text embeddings, driven by
 * the model registry in constants/embedding-models.ts and selected via
 * CAIRN_EMBEDDING_MODEL (default minilm-l6).
 *
 * IMPORTANT: Only use from the MCP server (long-lived process).
 * Hook processes are short-lived — they should NOT load the model.
 */
import {
  DEFAULT_EMBEDDING_MODEL_KEY, EMBEDDING_MODELS, type EmbeddingModelConfig,
} from '../constants/embedding-models.js';
import { assertManifestPinned, verifyModelPackage } from './artifact-verification.js';
import { createVerifiedLoader, type VerifiedLoader } from './verified-loader.js';

/** Which side of asymmetric retrieval an input belongs to. Symmetric models
 *  (minilm-l6) ignore the distinction; prefix models (nomic, gemma) require
 *  it for retrieval quality. */
export type EmbeddingRole = 'query' | 'document';

/** Resolve the active model config from CAIRN_EMBEDDING_MODEL. Pure —
 *  callers pass an explicit value in tests. FAILS CLOSED on unknown keys.
 *  Any registered model may be selected: schema v26 tags every stored
 *  vector with its model, all vector reads filter on the active model, and
 *  the backfill worker re-embeds mismatched rows (FTS+RRF carry retrieval
 *  during the transition). */
export function resolveEmbeddingModel(
  envValue: string | undefined = process.env.CAIRN_EMBEDDING_MODEL,
): EmbeddingModelConfig {
  const key = envValue?.trim() || DEFAULT_EMBEDDING_MODEL_KEY;
  // Object.hasOwn: inherited properties (__proto__, constructor, toString)
  // must get the unknown-key error, not fall through as truthy "configs".
  if (!Object.hasOwn(EMBEDDING_MODELS, key)) {
    throw new Error(
      `unknown CAIRN_EMBEDDING_MODEL "${key}" — valid keys: ${Object.keys(EMBEDDING_MODELS).join(', ')}`,
    );
  }
  return EMBEDDING_MODELS[key];
}

let activeModel: EmbeddingModelConfig | null = null;

/** Active model config (resolved once per process). */
export function getEmbeddingModelConfig(): EmbeddingModelConfig {
  if (!activeModel) activeModel = resolveEmbeddingModel();
  return activeModel;
}

/** Prepend the model's task prefix for the given role. Pure. */
export function buildEmbeddingInput(config: EmbeddingModelConfig, role: EmbeddingRole, text: string): string {
  return (role === 'query' ? config.queryPrefix : config.documentPrefix) + text;
}

/** Matches torch's F.layer_norm default eps. */
const LAYER_NORM_EPS = 1e-5;

/** MRL truncation per the official Nomic procedure: LAYER-NORMALIZE the
 *  full native vector, THEN truncate, THEN L2-normalize. Plain
 *  truncate+renormalize skips the layer norm and produces different (wrong)
 *  vectors. No-op when the vector is already `dim` long. Pure. */
export function truncateAndRenormalize(vec: Float32Array, dim: number): Float32Array {
  if (vec.length <= dim) return vec;

  let mean = 0;
  for (let i = 0; i < vec.length; i++) mean += vec[i];
  mean /= vec.length;
  let variance = 0;
  for (let i = 0; i < vec.length; i++) variance += (vec[i] - mean) ** 2;
  variance /= vec.length;
  const denom = Math.sqrt(variance + LAYER_NORM_EPS);

  const out = new Float32Array(dim);
  for (let i = 0; i < dim; i++) out[i] = (vec[i] - mean) / denom;

  let norm = 0;
  for (let i = 0; i < out.length; i++) norm += out[i] * out[i];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < out.length; i++) out[i] /= norm;
  return out;
}

/** Validate + post-process a raw model output: the model MUST return exactly
 *  nativeDim components (fail closed on drift — a short vector stored
 *  silently would poison vector search), then MRL-truncate to the registry
 *  dim. Pure. */
export function postProcessEmbedding(config: EmbeddingModelConfig, raw: Float32Array): Float32Array {
  if (raw.length !== config.nativeDim) {
    throw new Error(
      `embedding model "${config.key}" returned ${raw.length} dims, expected native ${config.nativeDim} — refusing to store`,
    );
  }
  return truncateAndRenormalize(raw, config.dim);
}

type Extractor = (text: string, opts: Record<string, unknown>) => Promise<{ data: Float32Array }>;

let loader: VerifiedLoader<Extractor> | null = null;

/** Lazy verified singleton: an UNPINNED model refuses before any download
 *  starts; a pinned one loads (a clean cache legitimately downloads), then
 *  the cached package verifies against the registry manifest. Transient
 *  load failures retry; provenance failures poison the loader for the
 *  process — production never embeds with an unverified package. */
function getLoader(): VerifiedLoader<Extractor> {
  if (!loader) {
    const config = getEmbeddingModelConfig();
    loader = createVerifiedLoader<Extractor>({
      load: async () => {
        assertManifestPinned(config, 'embedding');
        const { pipeline } = await import('@huggingface/transformers');
        return await pipeline('feature-extraction', config.hfPath, { dtype: config.dtype }) as unknown as Extractor;
      },
      verify: () => verifyModelPackage(config, 'embedding'),
      onPoison: (err) => {
        console.error(`[cairn] embedding artifact verification FAILED — embeddings disabled for this process: ${err.message}`);
      },
    });
  }
  return loader;
}

const getPipeline = (): Promise<Extractor> => getLoader().get();

/** Check if the embedding model is loaded (non-blocking) */
export function isEmbeddingReady(): boolean {
  return loader?.isReady() ?? false;
}

/** Embed text for the active model. Role selects the asymmetric task prefix
 *  (documents by default); output is truncated + renormalized to the model's
 *  registry dim for MRL models. */
export async function embed(text: string, role: EmbeddingRole = 'document'): Promise<Float32Array> {
  const config = getEmbeddingModelConfig();
  const extractor = await getPipeline();
  const output = await extractor(buildEmbeddingInput(config, role, text), { pooling: 'mean', normalize: true });
  return postProcessEmbedding(config, new Float32Array(output.data));
}

/** Embed a retrieval query (asymmetric prefix models need the query side). */
export function embedQuery(text: string): Promise<Float32Array> {
  return embed(text, 'query');
}

/** Convert Float32Array embedding to Buffer for SQLite BLOB storage */
export function embeddingToBuffer(embedding: Float32Array): Buffer {
  return Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
}

/** Convert SQLite BLOB Buffer back to Float32Array */
export function bufferToEmbedding(buf: Buffer): Float32Array {
  // Create a copy to avoid issues with buffer offset/alignment
  const copy = new ArrayBuffer(buf.length);
  const view = new Uint8Array(copy);
  for (let i = 0; i < buf.length; i++) view[i] = buf[i];
  return new Float32Array(copy);
}

/** Pre-warm the model on startup (fire-and-forget) */
export function warmupEmbeddings(): void {
  getPipeline().catch(err => {
    console.error('[cairn] Embedding model warmup failed:', err);
  });
}
