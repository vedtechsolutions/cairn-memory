/**
 * Cross-encoder reranker service — lazy singleton mirroring embeddings.ts.
 * Opt-in via WAYKEEP_RERANK=1; model via WAYKEEP_RERANK_MODEL. MCP-server only:
 * hook processes must never load models.
 *
 * Failure semantics: INVALID configuration fails closed (throw — resolved
 * synchronously at server startup). TRANSIENT model-load failure degrades
 * explicitly: rerank() returns null, callers keep the RRF order and label
 * the result — production logs the fallback, the benchmark refuses to
 * score a mislabeled run.
 */
import {
  DEFAULT_RERANKER_MODEL_KEY, RERANKER_MODELS, type RerankerModelConfig,
} from '../constants/reranker-models.js';
import { assertManifestPinned, verifyArtifacts as verifyArtifactsGeneric, verifyModelPackage } from './artifact-verification.js';
import { createVerifiedLoader, type VerifiedLoader } from './verified-loader.js';
import { ENV } from '../constants/env.js';
import { log } from './log.js';

/** WAYKEEP_RERANK contract: unset/''/'0' = off, '1' = on, anything else is a
 *  misconfiguration and fails closed rather than guessing intent. */
export function isRerankEnabled(envValue: string | undefined = process.env[ENV.RERANK]): boolean {
  if (envValue === undefined || envValue === '' || envValue === '0') return false;
  if (envValue === '1') return true;
  throw new Error(`invalid ${ENV.RERANK} "${envValue}" — use 1 to enable or unset/0 to disable`);
}

/** Resolve the reranker model config. Pure; fails closed on unknown keys. */
export function resolveRerankerModel(
  envValue: string | undefined = process.env[ENV.RERANK_MODEL],
): RerankerModelConfig {
  const key = envValue?.trim() || DEFAULT_RERANKER_MODEL_KEY;
  if (!Object.hasOwn(RERANKER_MODELS, key)) {
    throw new Error(
      `unknown ${ENV.RERANK_MODEL} "${key}" — valid keys: ${Object.keys(RERANKER_MODELS).join(', ')}`,
    );
  }
  return RERANKER_MODELS[key];
}

let activeModel: RerankerModelConfig | null = null;

export function getRerankerModelConfig(): RerankerModelConfig {
  if (!activeModel) activeModel = resolveRerankerModel();
  return activeModel;
}

interface RerankerPipeline {
  tokenizer: (queries: string[], opts: Record<string, unknown>) => Promise<Record<string, unknown>>;
  model: (inputs: Record<string, unknown>) => Promise<{ logits: { data: Float32Array | number[] } }>;
}

let loader: VerifiedLoader<RerankerPipeline> | null = null;

/** Lazy verified singleton: an UNPINNED model refuses before any download
 *  starts (defense-in-depth behind the startup gate — the invariant holds
 *  even if registry typing or startup wiring regresses); a pinned one loads
 *  (a clean cache legitimately downloads), then the cached package verifies
 *  against the registry manifest. Transient load failures retry; provenance
 *  failures poison the loader for the process — production NEVER scores
 *  with an unverified package. */
function getLoader(): VerifiedLoader<RerankerPipeline> {
  if (!loader) {
    const config = getRerankerModelConfig();
    loader = createVerifiedLoader<RerankerPipeline>({
      load: async () => {
        assertManifestPinned(config, 'reranker');
        const { AutoTokenizer, AutoModelForSequenceClassification } = await import('@huggingface/transformers');
        const tokenizer = await AutoTokenizer.from_pretrained(config.hfPath);
        const model = await AutoModelForSequenceClassification.from_pretrained(config.hfPath, { dtype: config.dtype });
        return { tokenizer, model } as unknown as RerankerPipeline;
      },
      verify: () => verifyModelPackage(config, 'reranker'),
      onPoison: (err) => {
        log.error(`reranker artifact verification FAILED — reranking disabled for this process: ${err.message}`);
      },
    });
  }
  return loader;
}

const getPipeline = (): Promise<RerankerPipeline> => getLoader().get();

export function isRerankerReady(): boolean {
  return loader?.isReady() ?? false;
}

/** Pre-warm the model (fire-and-forget; MCP server startup). */
export function warmupReranker(): void {
  getPipeline().catch(err => {
    log.warn('Reranker warmup failed (will retry on use):', err);
  });
}

/** Awaitable model load — the benchmark loads (downloading on a clean
 *  cache) BEFORE artifact verification, so a legitimate first run can
 *  fetch weights and still refuse to score against an unverified cache. */
export async function loadReranker(): Promise<void> {
  await getPipeline();
}

/** Verify a cached model package against relative-path → sha256 pins.
 *  Thin label-binding over the shared implementation (see
 *  artifact-verification.ts) — kept exported here for the benchmark
 *  runner and provenance tests. */
export function verifyArtifacts(cacheDir: string, manifest: Readonly<Record<string, string>>): Promise<Record<string, string>> {
  return verifyArtifactsGeneric(cacheDir, manifest, 'reranker');
}

export interface RerankCandidate {
  id: string;
  text: string;
  /** Original (RRF) rank — the deterministic tie-breaker. */
  rank: number;
}

/** Deterministic ordering: score descending, ORIGINAL rank ascending on
 *  ties. Pure — exported for tests. */
export function orderByScore<T extends { rank: number }>(candidates: T[], scores: number[]): T[] {
  return candidates
    .map((c, i) => ({ c, s: scores[i] }))
    .sort((a, b) => (b.s - a.s) || (a.c.rank - b.c.rank))
    .map(x => x.c);
}

/** Validate raw cross-encoder output: exactly one logit per candidate and
 *  every score finite. Returns null on ANY violation — a short, long, NaN,
 *  or infinite logit vector is an unusable inference result, and sorting
 *  by it would produce a silently wrong ranking. Pure — exported for
 *  tests. */
export function scoresFromLogits(logitsData: ArrayLike<number>, expectedCount: number): number[] | null {
  if (logitsData.length !== expectedCount) return null;
  const scores = new Array<number>(expectedCount);
  for (let i = 0; i < expectedCount; i++) {
    const s = Number(logitsData[i]);
    if (!Number.isFinite(s)) return null;
    scores[i] = s;
  }
  return scores;
}

/** Score query↔candidate pairs with the cross-encoder and return the
 *  candidates reordered (score desc, original rank on ties). Returns NULL
 *  on transient unavailability OR unusable inference output — the caller
 *  MUST label the fallback (production) or throw (benchmark), never
 *  silently present RRF order as reranked. */
export async function rerank(query: string, candidates: RerankCandidate[]): Promise<RerankCandidate[] | null> {
  if (candidates.length === 0) return [];
  let pipeline: RerankerPipeline;
  try {
    pipeline = await getPipeline();
  } catch {
    return null; // transient load failure — caller labels the RRF fallback
  }
  const inputs = await pipeline.tokenizer(new Array(candidates.length).fill(query), {
    text_pair: candidates.map(c => c.text), padding: true, truncation: true,
  });
  const { logits } = await pipeline.model(inputs);
  const scores = scoresFromLogits(logits.data, candidates.length);
  if (scores === null) {
    log.warn(`reranker returned unusable output (${logits.data.length} logits for ${candidates.length} candidates, or non-finite scores) — falling back`);
    return null;
  }
  return orderByScore(candidates, scores);
}
