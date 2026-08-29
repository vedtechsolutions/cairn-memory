/**
 * Model artifact provenance (W2 flip-precondition gate, production
 * enforcement). Hugging Face paths float on `main`, and tokenizer/config
 * drift alters model behavior just as surely as weight drift — so every
 * file a pipeline loads is pinned by sha256 in the model registry, and
 * PRODUCTION loads verify the cached package after download, refusing to
 * serve from an unverified or unpinned cache.
 *
 * Hashing is streamed: buffering a multi-hundred-MB ONNX would inflate
 * the process peak RSS the resource benchmarks record.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The provenance failure kind, for callers that must react differently to
 *  each (e.g. `waykeep doctor`): a `missing` cache downloads on first use, but
 *  `unpinned` and `mismatch` are hard failures the server refuses to boot on. */
export type ArtifactErrorKind = 'unpinned' | 'missing' | 'mismatch';

/** Distinguishes provenance failures (permanent — poison the loader) from
 *  transient load failures (retryable). */
export class ArtifactVerificationError extends Error {
  constructor(message: string, readonly kind?: ArtifactErrorKind) {
    super(message);
  }
}

export interface PinnedModelConfig {
  hfPath: string;
  artifacts?: Readonly<Record<string, string>>;
}

/** transformers.js local cache location for one model package. */
export function modelCacheDir(hfPath: string): string {
  // dist/src/utils/ → package root, matching the benchmark's resolution.
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', '..', '..', 'node_modules', '@huggingface', 'transformers', '.cache', hfPath);
}

/** Stream-hash one file. Missing/unreadable is a PROVENANCE failure. */
export async function sha256File(filePath: string, label: string): Promise<string> {
  const hash = createHash('sha256');
  try {
    for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  } catch (err) {
    throw new ArtifactVerificationError(
      `${label} artifact missing or unreadable at ${filePath} (load the model first): ${(err as Error).message}`,
      'missing',
    );
  }
  return hash.digest('hex');
}

/** Verify the COMPLETE cached package against relative-path → sha256 pins.
 *  A missing file or any mismatch throws; returns the verified hashes. */
export async function verifyArtifacts(
  cacheDir: string,
  manifest: Readonly<Record<string, string>>,
  label: string,
): Promise<Record<string, string>> {
  const verified: Record<string, string> = {};
  for (const [relPath, expected] of Object.entries(manifest)) {
    const actual = await sha256File(join(cacheDir, relPath), label);
    if (actual !== expected) {
      throw new ArtifactVerificationError(
        `${label} artifact sha256 mismatch for ${relPath}:\n  cached: ${actual}\n  pinned: ${expected}\nrefusing to use an unverified model package`,
        'mismatch',
      );
    }
    verified[relPath] = actual;
  }
  return verified;
}

/** Registry-selection gate: a model WITHOUT a pinned manifest must refuse
 *  BEFORE any download starts — production never loads unpinned packages. */
export function assertManifestPinned(config: PinnedModelConfig, label: string): asserts config is PinnedModelConfig & { artifacts: Readonly<Record<string, string>> } {
  if (config.artifacts === undefined || Object.keys(config.artifacts).length === 0) {
    throw new ArtifactVerificationError(
      `${label} model "${config.hfPath}" has no artifact manifest — pin the complete package (config/tokenizer/tokenizer_config/onnx) before production use`,
      'unpinned',
    );
  }
}

/** Verify a registry model's cached package against its manifest. */
export function verifyModelPackage(config: PinnedModelConfig, label: string): Promise<Record<string, string>> {
  assertManifestPinned(config, label);
  return verifyArtifacts(modelCacheDir(config.hfPath), config.artifacts, label);
}
