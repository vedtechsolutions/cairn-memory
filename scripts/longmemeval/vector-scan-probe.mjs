#!/usr/bin/env node
/**
 * Vector-scan latency/footprint probe — measures vec_distance_cosine
 * top-K scan cost and stored-vector size across embedding dimensions
 * (the DB-side inputs to embedder default/opt-in decisions; model RAM and
 * embed latency are the resource-probe's job).
 *
 * Method: per dimension, N synthetic unit-norm vectors in an isolated
 * ':memory:' store (schema-real memories table, embedding_model-stamped),
 * warmup ×2, then REPS timed top-K scans. Nearest-rank quantiles
 * (index = ceil(q·n)−1 on the ascending sort); raw samples retained.
 *
 * Usage: node scripts/longmemeval/vector-scan-probe.mjs [--rows 5000] [--reps 40] [--dims 256,384,512] [--out probe.json]
 */
import { writeFile } from 'node:fs/promises';
import { openDatabase } from '../../dist/src/db/connection.js';

const args = process.argv.slice(2);
const argValue = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
};
const ROWS = Number(argValue('--rows') ?? 5000);
const REPS = Number(argValue('--reps') ?? 40);
const LIMIT = 20;
const WARMUPS = 2;
const DIMS = (argValue('--dims') ?? '256,384,512').split(',').map(Number);
const outPath = argValue('--out');

const quantile = (sortedAsc, q) => sortedAsc[Math.ceil(q * sortedAsc.length) - 1];

const results = [];
for (const dim of DIMS) {
  const db = openDatabase({ dbPath: ':memory:' });
  const ins = db.prepare(`
    INSERT INTO memories (id, content, kind, project, tags, confidence, source, created_at, recall_count, invalidated, embedding, embedding_model)
    VALUES (?, ?, 'fact', 'probe', '[]', 0.5, 'learned', datetime('now'), 0, 0, ?, 'probe')
  `);
  db.transaction(() => {
    for (let i = 0; i < ROWS; i++) {
      const v = new Float32Array(dim);
      let norm = 0;
      for (let j = 0; j < dim; j++) { v[j] = Math.sin((i + 1) * (j + 1) * 0.01); norm += v[j] * v[j]; }
      norm = Math.sqrt(norm);
      if (norm > 0) for (let j = 0; j < dim; j++) v[j] /= norm;
      ins.run(`m${i}`, `content ${i}`, Buffer.from(v.buffer));
    }
  })();

  const q = new Float32Array(dim);
  for (let j = 0; j < dim; j++) q[j] = Math.cos(j * 0.02);
  const qb = Buffer.from(q.buffer);
  const stmt = db.prepare(`
    SELECT id, vec_distance_cosine(embedding, ?) AS d FROM memories
    WHERE embedding_model = 'probe' ORDER BY d ASC LIMIT ${LIMIT}
  `);
  for (let w = 0; w < WARMUPS; w++) stmt.all(qb);
  const raw = [];
  for (let r = 0; r < REPS; r++) {
    const s = performance.now();
    stmt.all(qb);
    raw.push(Math.round((performance.now() - s) * 100) / 100);
  }
  db.close();
  const sorted = [...raw].sort((a, b) => a - b);
  const entry = {
    dim,
    bytes_per_vector: dim * 4,
    scan_p50_ms: quantile(sorted, 0.5),
    scan_p95_ms: quantile(sorted, 0.95),
    raw_ms: raw,
  };
  results.push(entry);
  console.error(`dim ${dim}: p50 ${entry.scan_p50_ms}ms | p95 ${entry.scan_p95_ms}ms | ${entry.bytes_per_vector}B/vector`);
}

const out = {
  probe: 'vector-scan-probe',
  quantile_method: 'nearest-rank: index = ceil(q*n)-1 on ascending sort',
  rows: ROWS,
  top_k: LIMIT,
  reps: REPS,
  results,
};
const json = JSON.stringify(out, null, 2) + '\n';
if (outPath) {
  await writeFile(outPath, json);
  console.error(`probe written: ${outPath}`);
} else {
  process.stdout.write(json);
}
