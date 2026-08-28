/**
 * Lazy singleton loader with provenance enforcement — the shared shape of
 * the embedding and reranker pipelines. Load (a clean cache legitimately
 * downloads), THEN verify the cached package; only a verified pipeline is
 * ever returned.
 *
 * Failure semantics:
 * - TRANSIENT load failure (network blip, disk full): the cached promise
 *   clears so the next call retries — one blip must not disable the
 *   pipeline for the process lifetime.
 * - PROVENANCE failure (ArtifactVerificationError — missing manifest,
 *   missing file, hash mismatch): PERMANENT. The loader is poisoned for
 *   the process; every later get() rejects with the same error without
 *   re-loading. A drifted cache cannot heal by retrying, and retrying
 *   would re-download and re-hash on every call.
 */
import { ArtifactVerificationError } from './artifact-verification.js';

export interface VerifiedLoaderOptions<T> {
  /** Load the pipeline (may download into the cache). */
  load: () => Promise<T>;
  /** Verify the cached package; throw ArtifactVerificationError to poison. */
  verify: () => Promise<unknown>;
  /** One-time callback when the loader poisons (logging). */
  onPoison: (err: ArtifactVerificationError) => void;
}

export interface VerifiedLoader<T> {
  get(): Promise<T>;
  isReady(): boolean;
  /** The permanent provenance failure, if any. */
  poison(): ArtifactVerificationError | null;
}

export function createVerifiedLoader<T>(options: VerifiedLoaderOptions<T>): VerifiedLoader<T> {
  let promise: Promise<T> | null = null;
  let ready = false;
  let poisoned: ArtifactVerificationError | null = null;

  const get = (): Promise<T> => {
    if (poisoned) return Promise.reject(poisoned);
    if (!promise) {
      const created = (async (): Promise<T> => {
        const value = await options.load();
        await options.verify();
        ready = true;
        return value;
      })();
      promise = created;
      created.catch((err: unknown) => {
        if (err instanceof ArtifactVerificationError) {
          poisoned = err;
          options.onPoison(err);
        }
        if (promise === created) promise = null;
      });
    }
    return promise;
  };

  return { get, isReady: () => ready, poison: () => poisoned };
}
