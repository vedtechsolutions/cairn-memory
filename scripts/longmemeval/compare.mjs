#!/usr/bin/env node
/**
 * Paired comparison of two LongMemEval report JSONs over the SAME question
 * set (challenger minus baseline), with uncertainty:
 *   - per-question win/loss/tie counts on session recall_all@5
 *   - exact two-sided sign test over the movers
 *   - seeded paired-bootstrap 95% CI on the mean delta (deterministic:
 *     mulberry32(42), 10,000 resamples — identical output on every run)
 *   - per-ability breakdown and full aggregate deltas
 *
 * FAILS CLOSED (exit 1) when the reports are not cleanly comparable:
 * mismatched dataset identity/sha, variant, corpus mode, ks, pool or
 * candidate depth, duplicate or missing question ids, question-type
 * drift, or namespace scored-row availability. Harness-commit mismatch
 * also fails unless --allow-harness-mismatch is passed (for the
 * documented continuity case where a re-run reproduced the recorded
 * baseline exactly).
 *
 * Usage:
 *   node scripts/longmemeval/compare.mjs [--allow-harness-mismatch] <baseline.json> <challenger.json>
 */
import { readFile } from 'node:fs/promises';

const BOOTSTRAP_RESAMPLES = 10_000;
const BOOTSTRAP_SEED = 42;
const K = '5';
const NAMESPACES = ['official_compat', 'unique_session'];

const args = process.argv.slice(2);
const allowHarnessMismatch = args.includes('--allow-harness-mismatch');
const paths = args.filter(a => a !== '--allow-harness-mismatch');
if (paths.length !== 2) {
  console.error('Usage: node scripts/longmemeval/compare.mjs [--allow-harness-mismatch] <baseline.json> <challenger.json>');
  process.exit(1);
}
const [basePath, challPath] = paths;
const base = JSON.parse(await readFile(basePath, 'utf8'));
const chall = JSON.parse(await readFile(challPath, 'utf8'));

function fail(msg) {
  console.error(`comparison refused: ${msg}`);
  process.exit(1);
}

// --- Compatibility validation — apparently-valid statistics over unrelated
// --- or incomplete reports are worse than no statistics.

// variant_label is deliberately NOT compared: the label carries the
// experimental variable (e.g. 'hybrid' vs 'hybrid+rerank'), so comparing it
// would block exactly the A/Bs this tool exists for. 'variant' + 'embedded'
// still catch the incompatible cases (fts vs hybrid, fallback vs real).
const COMPARABLE_META_FIELDS = [
  'dataset', 'dataset_revision', 'dataset_sha256', 'variant', 'embedded',
  'corpus_mode', 'ks', 'pool_size', 'candidates_per_retriever', 'max_questions',
];
for (const field of COMPARABLE_META_FIELDS) {
  const a = base.meta[field];
  const b = chall.meta[field];
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    fail(`meta.${field} differs (${JSON.stringify(a)} vs ${JSON.stringify(b)}) — reports are not comparable`);
  }
}
if (base.meta.harness_commit !== chall.meta.harness_commit) {
  if (!allowHarnessMismatch) {
    fail(`harness_commit differs (${base.meta.harness_commit} vs ${chall.meta.harness_commit}); pass --allow-harness-mismatch ONLY when a continuity check proved the runs equivalent`);
  }
  console.log(`NOTE: harness commits differ (${base.meta.harness_commit} vs ${chall.meta.harness_commit}) — proceeding under --allow-harness-mismatch\n`);
}

function indexRows(report, label) {
  const rows = new Map();
  for (const q of report.per_question) {
    if (rows.has(q.question_id)) fail(`${label} contains duplicate question_id "${q.question_id}"`);
    rows.set(q.question_id, q);
  }
  return rows;
}
const baseRows = indexRows(base, 'baseline');
const challRows = indexRows(chall, 'challenger');

if (baseRows.size !== challRows.size) {
  fail(`question counts differ (baseline ${baseRows.size} vs challenger ${challRows.size})`);
}
for (const [id, bq] of baseRows) {
  const cq = challRows.get(id);
  if (!cq) fail(`question "${id}" present in baseline but missing from challenger`);
  if (bq.question_type !== cq.question_type) {
    fail(`question "${id}" type differs (${bq.question_type} vs ${cq.question_type})`);
  }
  if (bq.abstention !== cq.abstention) {
    fail(`question "${id}" abstention flag differs`);
  }
  // Scored-row availability: a namespace present on one side but not the
  // other silently shrinks the pairing — refuse instead.
  for (const ns of NAMESPACES) {
    if ((bq[ns] === undefined) !== (cq[ns] === undefined)) {
      fail(`question "${id}" is scored in ${ns} on one side only`);
    }
  }
}

// --- Statistics ---------------------------------------------------------------

/** Deterministic PRNG — bootstrap output must be reproducible. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Exact two-sided sign test: 2 × P(X ≤ min(w,l)) under Binomial(w+l, 0.5),
 *  ties excluded, capped at 1. */
function signTestTwoSided(wins, losses) {
  const n = wins + losses;
  if (n === 0) return 1;
  const k = Math.min(wins, losses);
  let coef = 1; // C(n, 0)
  let cum = 1;
  for (let i = 1; i <= k; i++) {
    coef = coef * (n - i + 1) / i;
    cum += coef;
  }
  return Math.min(1, 2 * (cum / 2 ** n));
}

function pairedDeltas(ns) {
  const deltas = [];
  const rows = [];
  for (const [id, cq] of challRows) {
    if (cq.abstention) continue;
    if (cq[ns] === undefined) continue; // availability equality validated above
    const bq = baseRows.get(id);
    const b = bq[ns]?.session_recall_all?.[K];
    const c = cq[ns]?.session_recall_all?.[K];
    if (b === undefined || c === undefined) {
      fail(`question "${id}" lacks session_recall_all@${K} in ${ns} on one side`);
    }
    deltas.push(c - b);
    rows.push({ id, type: cq.question_type, b, c, d: c - b });
  }
  return { deltas, rows };
}

function bootstrapCi(deltas) {
  const rand = mulberry32(BOOTSTRAP_SEED);
  const n = deltas.length;
  const means = new Array(BOOTSTRAP_RESAMPLES);
  for (let r = 0; r < BOOTSTRAP_RESAMPLES; r++) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += deltas[(rand() * n) | 0];
    means[r] = sum / n;
  }
  means.sort((a, b) => a - b);
  return [means[Math.floor(0.025 * BOOTSTRAP_RESAMPLES)], means[Math.ceil(0.975 * BOOTSTRAP_RESAMPLES) - 1]];
}

for (const ns of NAMESPACES) {
  const { deltas, rows } = pairedDeltas(ns);
  if (rows.length === 0) fail(`no paired scored rows in ${ns}`);
  const up = rows.filter((r) => r.d > 0).length;
  const down = rows.filter((r) => r.d < 0).length;
  const tied = rows.length - up - down;
  const mean = deltas.reduce((a, b) => a + b, 0) / deltas.length;
  const p = signTestTwoSided(up, down);
  const [lo, hi] = bootstrapCi(deltas);

  console.log(`## ${ns} — session recall_all@${K} (paired, n=${rows.length})`);
  console.log(`  mean delta: ${mean >= 0 ? '+' : ''}${mean.toFixed(4)}`);
  console.log(`  improved: ${up} | regressed: ${down} | tied: ${tied}`);
  console.log(`  exact two-sided sign test (ties excluded): p=${p.toFixed(4)}`);
  console.log(`  paired bootstrap 95% CI (${BOOTSTRAP_RESAMPLES} resamples, seed ${BOOTSTRAP_SEED}): [${lo >= 0 ? '+' : ''}${lo.toFixed(4)}, ${hi >= 0 ? '+' : ''}${hi.toFixed(4)}]`);

  const byType = new Map();
  for (const r of rows) {
    const t = byType.get(r.type) ?? { n: 0, sumB: 0, sumC: 0, movers: [] };
    t.n++; t.sumB += r.b; t.sumC += r.c;
    if (r.d !== 0) t.movers.push(`${r.id} ${r.d > 0 ? '+' : ''}${r.d}`);
    byType.set(r.type, t);
  }
  console.log('  per-ability (baseline → challenger):');
  for (const [type, t] of [...byType.entries()].sort()) {
    const movers = t.movers.length > 0 ? `  [${t.movers.join(', ')}]` : '';
    console.log(`    ${type} (n=${t.n}): ${(t.sumB / t.n).toFixed(4)} → ${(t.sumC / t.n).toFixed(4)}${movers}`);
  }
  console.log('');
}

console.log('## aggregate deltas (challenger − baseline)');
for (const ns of NAMESPACES) {
  for (const metric of ['session_recall_all', 'session_ndcg_any', 'turn_recall_all', 'turn_ndcg_any']) {
    const parts = [];
    for (const k of Object.keys(base.aggregates[ns][metric])) {
      const b = base.aggregates[ns][metric][k];
      const c = chall.aggregates[ns][metric][k];
      parts.push(`@${k}: ${b} → ${c} (${c >= b ? '+' : ''}${(c - b).toFixed(4)})`);
    }
    console.log(`  ${ns} ${metric}  ${parts.join('  ')}`);
  }
}
