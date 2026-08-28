/**
 * Production artifact-manifest enforcement (W2 flip-precondition gate) —
 * the verified-loader semantics (transient retry vs permanent provenance
 * poisoning), the unpinned-model refusal, registry manifest completeness,
 * and — when the local cache holds the benchmarked packages — that the
 * checked-in pins match those exact bytes.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ArtifactVerificationError, assertManifestPinned, modelCacheDir,
  sha256File, verifyArtifacts, verifyModelPackage,
} from '../src/utils/artifact-verification.js';
import { createVerifiedLoader } from '../src/utils/verified-loader.js';
import { EMBEDDING_MODELS } from '../src/constants/embedding-models.js';
import { RERANKER_MODELS } from '../src/constants/reranker-models.js';

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

// --- verified-loader semantics --------------------------------------------------

describe('verified loader — transient retry vs permanent poisoning', () => {
  it('a transient load failure retries; the next attempt can succeed', async () => {
    let loads = 0;
    const loader = createVerifiedLoader<string>({
      load: async () => {
        loads++;
        if (loads === 1) throw new Error('network blip');
        return 'pipeline';
      },
      verify: async () => {},
      onPoison: () => assert.fail('a transient failure must not poison'),
    });
    await assert.rejects(loader.get(), /network blip/);
    assert.equal(await loader.get(), 'pipeline');
    assert.equal(loads, 2);
    assert.equal(loader.isReady(), true);
    assert.equal(loader.poison(), null);
  });

  it('a transient VERIFY failure (non-provenance) also retries', async () => {
    let verifies = 0;
    const loader = createVerifiedLoader<string>({
      load: async () => 'pipeline',
      verify: async () => {
        verifies++;
        if (verifies === 1) throw new Error('disk hiccup');
      },
      onPoison: () => assert.fail('a non-provenance failure must not poison'),
    });
    await assert.rejects(loader.get(), /disk hiccup/);
    assert.equal(await loader.get(), 'pipeline');
  });

  it('a provenance failure poisons PERMANENTLY: no reload, one poison callback', async () => {
    let loads = 0;
    let poisons = 0;
    const failure = new ArtifactVerificationError('sha256 mismatch for onnx/model_quantized.onnx');
    const loader = createVerifiedLoader<string>({
      load: async () => { loads++; return 'pipeline'; },
      verify: async () => { throw failure; },
      onPoison: (err) => { poisons++; assert.equal(err, failure); },
    });
    await assert.rejects(loader.get(), (err: Error) => err === failure);
    await assert.rejects(loader.get(), (err: Error) => err === failure);
    await assert.rejects(loader.get(), (err: Error) => err === failure);
    assert.equal(loads, 1, 'a drifted cache must not be re-downloaded/re-hashed per call');
    assert.equal(poisons, 1);
    assert.equal(loader.isReady(), false);
    assert.equal(loader.poison(), failure);
  });

  it('success: verify runs before ready, the pipeline is cached', async () => {
    const order: string[] = [];
    const loader = createVerifiedLoader<string>({
      load: async () => { order.push('load'); return 'pipeline'; },
      verify: async () => { order.push('verify'); },
      onPoison: () => assert.fail('must not poison'),
    });
    assert.equal(loader.isReady(), false);
    assert.equal(await loader.get(), 'pipeline');
    assert.equal(await loader.get(), 'pipeline');
    assert.deepEqual(order, ['load', 'verify']);
    assert.equal(loader.isReady(), true);
  });
});

// --- manifest gates -------------------------------------------------------------

describe('unpinned models refuse before any download', () => {
  it('assertManifestPinned rejects absent and empty manifests, names the model', () => {
    assert.throws(
      () => assertManifestPinned({ hfPath: 'x/unpinned' }, 'embedding'),
      (err: Error) => err instanceof ArtifactVerificationError
        && /embedding model "x\/unpinned" has no artifact manifest/.test(err.message),
    );
    assert.throws(() => assertManifestPinned({ hfPath: 'x/empty', artifacts: {} }, 'reranker'), /no artifact manifest/);
    assertManifestPinned({ hfPath: 'x/ok', artifacts: { 'config.json': sha('c') } }, 'embedding');
  });

  it('the embedding service refuses an unpinned registry model without touching the network', () => {
    // Subprocess: module-level singletons resolve env at first use. The
    // refusal precedes the transformers import, so failure is immediate —
    // no download can start.
    let refused = false;
    try {
      execFileSync(process.execPath, [
        '-e',
        "import('./dist/src/utils/embeddings.js').then(m => m.embed('probe')).then(() => process.exit(0), err => { console.error(err.message); process.exit(3); });",
      ], {
        cwd: process.cwd(),
        env: { ...process.env, CAIRN_EMBEDDING_MODEL: 'embeddinggemma-300m' },
        encoding: 'utf8',
        timeout: 30_000,
      });
    } catch (err) {
      refused = true;
      const stderr = String((err as { stderr?: string }).stderr ?? '');
      assert.match(stderr, /embedding model "onnx-community\/embeddinggemma-300m-ONNX" has no artifact manifest/);
    }
    assert.ok(refused, 'an unpinned model must refuse to embed');
  });
});

// --- verifyArtifacts / package plumbing -----------------------------------------

describe('artifact verification plumbing', () => {
  it('labels appear in mismatch and missing-file messages', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cairn-artifacts-'));
    try {
      mkdirSync(join(dir, 'onnx'), { recursive: true });
      writeFileSync(join(dir, 'config.json'), 'config bytes');
      await assert.rejects(
        verifyArtifacts(dir, { 'config.json': sha('other bytes') }, 'embedding'),
        (err: Error) => err instanceof ArtifactVerificationError && /embedding artifact sha256 mismatch for config\.json/.test(err.message),
      );
      await assert.rejects(
        verifyArtifacts(dir, { 'missing.json': sha('x') }, 'embedding'),
        /embedding artifact missing or unreadable/,
      );
      const verified = await verifyArtifacts(dir, { 'config.json': sha('config bytes') }, 'embedding');
      assert.deepEqual(verified, { 'config.json': sha('config bytes') });
      assert.equal(await sha256File(join(dir, 'config.json'), 'embedding'), sha('config bytes'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('modelCacheDir resolves inside the transformers.js cache', () => {
    const dir = modelCacheDir('acme/model-x');
    assert.match(dir, /node_modules[/\\]@huggingface[/\\]transformers[/\\]\.cache[/\\]acme[/\\]model-x$/);
  });
});

// --- registry manifest completeness ---------------------------------------------

const PACKAGE_FILES = ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model_quantized.onnx'];
const HEX64 = /^[0-9a-f]{64}$/;

describe('registry manifests', () => {
  it('every production-eligible embedding model pins the complete package', () => {
    for (const key of ['minilm-l6', 'nomic-v1.5', 'nomic-v1.5-256']) {
      const manifest = EMBEDDING_MODELS[key].artifacts;
      assert.ok(manifest, `${key} must be pinned`);
      assert.deepEqual(Object.keys(manifest).sort(), [...PACKAGE_FILES].sort(), `${key} manifest must cover the complete package`);
      for (const hash of Object.values(manifest)) assert.match(hash, HEX64);
    }
    // The MRL variants load the SAME package — pins must be identical.
    assert.deepEqual(EMBEDDING_MODELS['nomic-v1.5'].artifacts, EMBEDDING_MODELS['nomic-v1.5-256'].artifacts);
    // gemma is deliberately unpinned: never benchmarked, no trusted bytes.
    assert.equal(EMBEDDING_MODELS['embeddinggemma-300m'].artifacts, undefined);
  });

  it('every reranker model pins the complete package', () => {
    for (const config of Object.values(RERANKER_MODELS)) {
      assert.deepEqual(Object.keys(config.artifacts).sort(), [...PACKAGE_FILES].sort());
      for (const hash of Object.values(config.artifacts)) assert.match(hash, HEX64);
    }
  });
});

// --- benchmarked-bytes integration (environment-gated) ---------------------------

describe('checked-in pins match the locally cached benchmarked bytes', () => {
  const pinned: Array<{ label: string; hfPath: string; artifacts: Readonly<Record<string, string>> }> = [
    { label: 'embedding', hfPath: EMBEDDING_MODELS['minilm-l6'].hfPath, artifacts: EMBEDDING_MODELS['minilm-l6'].artifacts! },
    { label: 'embedding', hfPath: EMBEDDING_MODELS['nomic-v1.5'].hfPath, artifacts: EMBEDDING_MODELS['nomic-v1.5'].artifacts! },
    { label: 'reranker', hfPath: RERANKER_MODELS['jina-turbo-v1'].hfPath, artifacts: RERANKER_MODELS['jina-turbo-v1'].artifacts },
    { label: 'reranker', hfPath: RERANKER_MODELS['bge-base'].hfPath, artifacts: RERANKER_MODELS['bge-base'].artifacts },
  ];

  for (const { label, hfPath, artifacts } of pinned) {
    it(`${hfPath} verifies against its pins when cached`, async (t) => {
      if (!existsSync(modelCacheDir(hfPath))) {
        t.skip(`package not cached locally — pins verified on benchmark hosts`);
        return;
      }
      const verified = await verifyModelPackage({ hfPath, artifacts }, label);
      assert.equal(Object.keys(verified).length, PACKAGE_FILES.length);
    });
  }
});
