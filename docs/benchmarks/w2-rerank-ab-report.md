# W2 reranker A/B: jina-turbo cross-encoder on LongMemEval-S

Date: 2026-07-22 · Harness commit: `ba83715` (all arms) · Dataset:
`longmemeval_s_cleaned.json` @ `98d7416c…` (manifest-pinned sha256) ·
Reranker: `jinaai/jina-reranker-v1-turbo-en` q8, complete-package artifact
manifest verified per run (weights `3defdef1…`).

Verdict: **minilm-l6 + jina-turbo rerank is the leading configuration** —
the largest quality gain of the W2 cycle, in the budget-compliant setup.
Default flip remains blocked on the latency budget decision and
production-side manifest enforcement (see gates).

## Protocol

- `CAIRN_RERANK=1`, RRF top-20 window → cross-encoder → top-k; pool tail
  order preserved; deterministic ties (score desc, original RRF rank).
- Sequential same-commit pairs (never concurrent); artifact manifest
  (config/tokenizer/tokenizer_config/ONNX sha256) verified before scoring.
- Continuity: the fresh `ba83715` minilm baseline reproduced the recorded
  `d4a6881` baseline EXACTLY (aggregates + all 500 rows) — third
  consecutive exact reproduction; the recorded baseline remains the valid
  comparator.
- Stratified 4-per-type smoke gated the full run; both full reports pass
  independent aggregate recomputation + audit checks.
- Model choice was smoke-driven: bge-reranker-base (roadmap's initial
  pick) measured +681 MB / 1132 ms p50 per complete 20-pair rerank on this
  hardware — disqualified; jina-turbo won the ordering probe.

## Full A/B — minilm vs minilm+rerank (500 questions)

| official_compat | minilm | minilm+rerank | Δ |
|---|---|---|---|
| session recall_all@5 | 0.8473 | **0.8998** | **+0.0525** |
| session recall_all@10 | 0.9499 | 0.9523 | +0.0024 |
| session ndcg_any@5 | 0.6288 | 0.6359 | +0.0071 |
| turn recall_all@5 | 0.6110 | 0.6516 | +0.0406 |
| turn recall_all@10 | 0.7470 | **0.8210** | +0.0740 |
| turn ndcg_any@5 | 0.6386 | 0.6857 | +0.0471 |
| turn ndcg_any@10 | 0.6761 | 0.7313 | +0.0552 |

No aggregate metric regressed in either namespace.

### Paired uncertainty (session recall_all@5)

| namespace | n | mean Δ | up/down/tied | sign test p | bootstrap 95% CI |
|---|---|---|---|---|---|
| official_compat | 419 | +0.0525 | 26 / 4 / 389 | 0.0001 | [+0.0286, +0.0788] |
| unique_session | 470 | +0.0447 | 27 / 6 / 437 | 0.0003 | [+0.0213, +0.0681] |

Method as in `w2-nomic-ab-report.md` (exact two-sided sign test, ties
excluded; seeded paired bootstrap, mulberry32(42), 10,000 resamples).
Reproduce: `node scripts/longmemeval/compare.mjs
docs/benchmarks/longmemeval-s-hybrid.json
docs/benchmarks/longmemeval-s-hybrid-rerank.json --allow-harness-mismatch`
(continuity-proven comparator, see above).

### Per-ability session recall_all@5 (unique_session)

| ability | n | minilm | minilm+rerank | Δ |
|---|---|---|---|---|
| multi-session | 121 | 0.7273 | **0.8264** | +0.0991 |
| temporal-reasoning | 127 | 0.7480 | **0.8110** | +0.0630 |
| single-session-preference | 30 | 0.8667 | 0.9333 | +0.0667 |
| knowledge-update | 72 | 0.9861 | 0.9722 | −0.0139 (1 question) |
| single-session-assistant | 56 | 0.9464 | 0.9464 | 0 |
| single-session-user | 64 | 1.0000 | 1.0000 | 0 |

Gains land on the two weakest abilities. Strategic comparison:
minilm+rerank official session recall_all@5 **0.8998** beats nomic-v1.5
without rerank (0.8783) — the cheaper, budget-compliant embedder plus the
cross-encoder outperforms the larger embedder alone.

## nomic+rerank arm — stopped at smoke (tightened gate)

Three-arm same-commit stratified smoke (24 questions): nomic+rerank vs
minilm+rerank was **identical on session recall_all@5 in every namespace
and every ability bucket** (all ties, mean Δ exactly 0), with only small
mixed movements elsewhere (+0.05 session@10, −0.05 turn@5); vs nomic alone
it even regressed one question. No plausible incremental advantage over
the winner → the ~5 h full run was not spent. The cross-encoder absorbs
most of nomic's embedding advantage, and the 405 MB combined configuration
cannot become default regardless.

## Resource gates (independent of quality)

Measured with the checked-in probe (`scripts/longmemeval/resource-probe.mjs`
— 40 timed iterations per set after 3 warmups, nearest-rank quantiles
`index = ceil(q·n)−1`, raw samples retained in
`docs/benchmarks/resource-probe/*.json`). Two candidate sets per run:
'short' synthetic sentences, and a 'representative' window sampled
deterministically (seed 42) from real dataset user-turn chunks spanning the
length distribution up to the 2000-char ingestion bound — a PESSIMISTIC
upper bound, since batch padding makes the longest chunk in a window set
its cost and this window always contains near-cap chunks.

Five fresh default-thread processes + four thread settings (all warm cache;
score-preservation check set byte-identical across ALL nine runs):

| run | threads | combined RSS | short p50/p95 | representative p50/p95 |
|---|---|---|---|---|
| default-1..5 | default | 206–242 MB | 126–170 / 206–401 ms | **842–1186 / 1339–2352 ms** |
| threads-1 | 1 | 204 MB | 330 / 428 ms | 2616 / 2908 ms |
| threads-2 | 2 | 241 MB | 206 / 380 ms | 1616 / 2303 ms |
| threads-4 | 4 | 205 MB | 169 / 285 ms | 1269 / 2069 ms |
| threads-8 | 8 | 236 MB | 126 / 227 ms | 1101 / 1944 ms |

- **Latency gate: FAILED / OPEN.** Representative p50 ≈ 0.84–1.19 s vs the
  ≤150 ms roadmap requirement (~7×), and score-preserving ONNX thread
  tuning cannot close it (default threading is already near-optimal; scores
  identical across all settings). The earlier "158 ms p50" reading came
  from short synthetic candidates and a mislabeled p95 index — superseded
  by this probe. A budget revision is a separate product decision; a
  smaller rerank window or model change would require a fresh quality A/B.
  Operational midpoint estimate: the full rerank leg added ~2.5–3 min over
  its ~44-min baseline across 419 scored questions ≈ ~380 ms amortized per
  real retrieved window (wall-clock delta, noisy) — real windows usually
  contain some long chunks but not always near-cap ones.
- **Combined RSS: warm steady-state PASS with margin** (204–242 MB across
  nine processes, ≥58 MB headroom under the 300 MB budget); **cold
  first-download NARROW pass** (294 MB, 6 MB under the limit).
- **Production manifest enforcement required before default flip** —
  production loading still follows floating `main`; only benchmark runs
  verify the artifact manifest today.
- Full-run operational peak (supplementary, total process incl. corpus):
  rerank leg 1.77 GB over 46:40 wall.

Reproduce: `node scripts/longmemeval/resource-probe.mjs` (add
`RERANK_THREADS=<n>` for tuning runs; `--out <file>` to retain raw samples).

## Artifacts

- `longmemeval-s-hybrid-rerank.{json,md}` — minilm+rerank full report
  (meta carries the complete verified artifact manifest)
- `longmemeval-s-hybrid.{json,md}` — recorded baseline (reproduced exactly
  at `ba83715`)
- `scripts/longmemeval/compare.mjs` — comparator used for every number here
