/**
 * Embedding model registry + resolution (roadmap W2 slice 1) — registry
 * invariants, env-var selection, the schema-v26 challenger gate, asymmetric
 * prefix application, and MRL truncation. Pure logic only: no model
 * downloads, no pipeline loads.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ENV } from '../src/constants/env.js';
import {
  DEFAULT_EMBEDDING_MODEL_KEY, EMBEDDING_MODELS,
} from '../src/constants/embedding-models.js';
import {
  buildEmbeddingInput, postProcessEmbedding, resolveEmbeddingModel, truncateAndRenormalize,
} from '../src/utils/embeddings.js';

describe('embedding model registry — invariants', () => {
  it('default key exists and is the current production model', () => {
    const def = EMBEDDING_MODELS[DEFAULT_EMBEDDING_MODEL_KEY];
    assert.ok(def, 'default key present in registry');
    assert.equal(def.hfPath, 'Xenova/all-MiniLM-L6-v2');
    assert.equal(def.dim, 384);
    assert.equal(def.dtype, 'q8');
    assert.equal(def.queryPrefix, '');
    assert.equal(def.documentPrefix, '');
  });

  it('every entry is internally consistent', () => {
    for (const [key, config] of Object.entries(EMBEDDING_MODELS)) {
      assert.equal(config.key, key, `${key}: key field matches registry key`);
      assert.ok(config.hfPath.includes('/'), `${key}: hfPath is org/repo`);
      assert.ok(config.dim > 0 && config.dim <= config.nativeDim, `${key}: dim within native output`);
      assert.ok(['q8', 'q4'].includes(config.dtype), `${key}: supported dtype`);
      assert.equal(typeof config.queryPrefix, 'string');
      assert.equal(typeof config.documentPrefix, 'string');
    }
  });

  it('nomic-v1.5-256 resolves to native 768 → stored 256 with nomic prefixes and unit-norm MRL output', () => {
    const c = resolveEmbeddingModel('nomic-v1.5-256');
    assert.equal(c.key, 'nomic-v1.5-256');
    assert.equal(c.hfPath, 'nomic-ai/nomic-embed-text-v1.5', 'same weights as nomic-v1.5');
    assert.equal(c.nativeDim, 768);
    assert.equal(c.dim, 256);
    assert.equal(c.queryPrefix, 'search_query: ');
    assert.equal(c.documentPrefix, 'search_document: ');

    // Non-zero-mean synthetic native output exercises the layer-norm step
    const raw = new Float32Array(768);
    for (let i = 0; i < raw.length; i++) raw[i] = Math.sin(i) + 2;
    const out = postProcessEmbedding(c, raw);
    assert.equal(out.length, 256, 'MRL truncates to the registry dim');
    assert.ok(Math.abs(Math.hypot(...out) - 1) < 1e-4, 'unit norm after truncation');
    assert.throws(() => postProcessEmbedding(c, new Float32Array(256)), /expected native 768/,
      'a pre-truncated vector must be rejected — truncation happens here, not upstream');
  });

  it('asymmetric-prefix models define BOTH prefixes (retrieval breaks with one side)', () => {
    for (const config of Object.values(EMBEDDING_MODELS)) {
      const hasQuery = config.queryPrefix.length > 0;
      const hasDoc = config.documentPrefix.length > 0;
      assert.equal(hasQuery, hasDoc, `${config.key}: prefixes are all-or-nothing`);
    }
  });
});

describe('resolveEmbeddingModel — env selection, fail closed', () => {
  it('resolves the default when unset or blank', () => {
    assert.equal(resolveEmbeddingModel(undefined).key, DEFAULT_EMBEDDING_MODEL_KEY);
    assert.equal(resolveEmbeddingModel('').key, DEFAULT_EMBEDDING_MODEL_KEY);
    assert.equal(resolveEmbeddingModel('  ').key, DEFAULT_EMBEDDING_MODEL_KEY);
  });

  it('resolves an explicit default selection', () => {
    assert.equal(resolveEmbeddingModel('minilm-l6').key, 'minilm-l6');
  });

  it('rejects unknown keys with the valid key list', () => {
    assert.throws(() => resolveEmbeddingModel('gpt-embeddings'), new RegExp(`unknown ${ENV.EMBEDDING_MODEL} "gpt-embeddings".*minilm-l6`));
  });

  it('rejects inherited object-property keys as unknown, not as gated challengers', () => {
    for (const key of ['__proto__', 'constructor', 'toString']) {
      assert.throws(() => resolveEmbeddingModel(key), new RegExp(`unknown ${ENV.EMBEDDING_MODEL}`), `${key} must hit the unknown-key path`);
    }
  });

  it('resolves challenger keys now that v26 per-row model tagging exists', () => {
    assert.equal(resolveEmbeddingModel('nomic-v1.5').dim, 512);
    assert.equal(resolveEmbeddingModel('embeddinggemma-300m').dim, 768);
  });
});

describe('buildEmbeddingInput — asymmetric task prefixes', () => {
  it('symmetric model passes text through unchanged for both roles', () => {
    const minilm = EMBEDDING_MODELS['minilm-l6'];
    assert.equal(buildEmbeddingInput(minilm, 'query', 'hello'), 'hello');
    assert.equal(buildEmbeddingInput(minilm, 'document', 'hello'), 'hello');
  });

  it('prefix model applies the role-matching prefix', () => {
    const nomic = EMBEDDING_MODELS['nomic-v1.5'];
    assert.equal(buildEmbeddingInput(nomic, 'query', 'hello'), 'search_query: hello');
    assert.equal(buildEmbeddingInput(nomic, 'document', 'hello'), 'search_document: hello');
  });
});

describe('truncateAndRenormalize — official MRL procedure (layer norm → truncate → L2)', () => {
  it('returns the vector unchanged when already at or below the target dim', () => {
    const vec = new Float32Array([0.6, 0.8]);
    assert.equal(truncateAndRenormalize(vec, 2), vec);
    assert.equal(truncateAndRenormalize(vec, 4), vec);
  });

  it('truncates to the target dim with unit norm', () => {
    const vec = new Float32Array([3, 4, 12, 0]);
    const out = truncateAndRenormalize(vec, 2);
    assert.equal(out.length, 2);
    assert.ok(Math.abs(Math.hypot(...out) - 1) < 1e-6, 'unit norm after truncation');
  });

  it('is shift-invariant — the signature that layer norm precedes truncation', () => {
    // Nomic's official 512-d procedure layer-normalizes the FULL native
    // vector before truncating. Layer norm removes the mean, so adding a
    // constant to every component must not change the output; plain
    // truncate+renormalize (the bug) fails this.
    const vec = new Float32Array([0.3, -1.2, 0.8, 2.1, -0.5, 0.05]);
    const shifted = new Float32Array(vec.map(v => v + 10));
    const a = truncateAndRenormalize(vec, 3);
    const b = truncateAndRenormalize(shifted, 3);
    for (let i = 0; i < a.length; i++) {
      assert.ok(Math.abs(a[i] - b[i]) < 1e-4, `component ${i} shift-invariant`);
    }
  });

  it('handles a zero-variance vector without NaN (layer-norm eps)', () => {
    const vec = new Float32Array([5, 5, 5, 5]);
    const out = truncateAndRenormalize(vec, 2);
    assert.ok([...out].every(Number.isFinite), 'no NaN/Infinity from zero variance');
  });
});

describe('postProcessEmbedding — exact native-dim enforcement', () => {
  const minilm = EMBEDDING_MODELS['minilm-l6'];
  const nomic = EMBEDDING_MODELS['nomic-v1.5'];

  it('rejects a short vector instead of silently storing it', () => {
    assert.throws(() => postProcessEmbedding(minilm, new Float32Array(200)), /returned 200 dims, expected native 384/);
  });

  it('rejects an over-long vector', () => {
    assert.throws(() => postProcessEmbedding(minilm, new Float32Array(768)), /returned 768 dims, expected native 384/);
  });

  it('passes native-dim output through (no truncation for non-MRL models)', () => {
    const raw = new Float32Array(384);
    raw[0] = 1;
    assert.equal(postProcessEmbedding(minilm, raw).length, 384);
  });

  it('truncates MRL model output from nativeDim to registry dim', () => {
    const raw = new Float32Array(768);
    for (let i = 0; i < raw.length; i++) raw[i] = Math.sin(i);
    const out = postProcessEmbedding(nomic, raw);
    assert.equal(out.length, 512);
    assert.ok(Math.abs(Math.hypot(...out) - 1) < 1e-4, 'unit norm');
  });
});
