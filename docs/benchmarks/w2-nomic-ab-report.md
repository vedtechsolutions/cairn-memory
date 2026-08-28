# W2 challenger A/B: nomic-v1.5 vs minilm-l6 (LongMemEval-S hybrid)

Date: 2026-07-21 · Harness commit: `1f05ad0` (both sides) · Dataset:
`longmemeval_s_cleaned.json` @ `98d7416c…` (manifest-pinned sha256)

Verdict: **quality gate PASS** (broad non-inferiority + material gains on the
weakest abilities). **Resource gate UNRESOLVED** — nomic alone consumes 289 MB
of the 300 MB combined embedder+reranker budget; the combined measurement
happens when the reranker lands, and a retrieval win does not waive it.

## Protocol

- Challenger: `CAIRN_EMBEDDING_MODEL=nomic-v1.5` (`nomic-ai/nomic-embed-text-v1.5`,
  q8, 768→512 MRL per the official procedure: layer-norm full vector →
  truncate → L2-normalize; asymmetric `search_query:` / `search_document:`
  prefixes; role-explicit harness embedFn).
- Baseline: `minilm-l6` re-run at the SAME harness commit, sequentially
  (never concurrent with the challenger — no CPU/memory contention in
  timing or RSS observations).
- **Continuity check**: the re-run reproduced the recorded `d4a6881`
  baseline (`longmemeval-s-hybrid.json`) EXACTLY — aggregates identical,
  0 of 500 per-question rows differ. The intervening commits (registry,
  role API, v26 tagging/filtering) are behaviorally inert for the
  symmetric default model, and the embed pipeline is deterministic on this
  machine.
- Both reports pass independent aggregate recomputation + audit checks.
- Stratified 4-per-type 24-question smoke ran first (directional gate:
  1 improved / 0 regressed / 23 unchanged; the mover was multi-session).

## Quality (paired, same commit, 470 scored / 419 turn-scored)

Per-question unique_session session recall_all@5: **21 improved / 9
regressed / 440 unchanged**.

### Paired uncertainty (session recall_all@5)

| namespace | n | mean Δ | up/down/tied | sign test p (two-sided, exact) | bootstrap 95% CI |
|---|---|---|---|---|---|
| official_compat | 419 | +0.0310 | 21 / 8 / 390 | 0.0241 | [+0.0072, +0.0573] |
| unique_session | 470 | +0.0255 | 21 / 9 / 440 | 0.0428 | [+0.0043, +0.0489] |

Both CIs exclude zero and both sign tests reject the no-difference null at
α = 0.05. Methodology: ties excluded from the exact binomial sign test;
paired bootstrap resamples the per-question delta vector with replacement
(10,000 resamples, percentile 2.5/97.5, deterministic PRNG mulberry32
seed 42 — identical output on every run). Reproduce from a clean checkout:

```
node scripts/longmemeval/compare.mjs --allow-harness-mismatch \
  docs/benchmarks/longmemeval-s-hybrid.json \
  docs/benchmarks/longmemeval-s-hybrid-nomic-v1.5.json
```

(`--allow-harness-mismatch` is required — and justified ONLY — because the
baseline artifact is stamped `d4a6881` while the challenger is `1f05ad0`,
and the same-commit re-run reproduced the baseline exactly (see the
continuity check), so the recorded artifact IS the paired comparator. The
comparator otherwise fails closed on any metadata, question-set, or
scored-row incompatibility.)

| official_compat | minilm-l6 | nomic-v1.5 | Δ |
|---|---|---|---|
| session recall_all@5 | 0.8473 | **0.8783** | +0.0310 |
| session recall_all@10 | 0.9499 | **0.9570** | +0.0071 |
| session ndcg_any@5 | 0.6288 | 0.6424 | +0.0136 |
| session ndcg_any@10 | 0.6432 | 0.6428 | −0.0004 |
| turn recall_all@5 | 0.6110 | **0.6659** | +0.0549 |
| turn recall_all@10 | 0.7470 | **0.8019** | +0.0549 |
| turn ndcg_any@5 | 0.6386 | **0.7074** | +0.0688 |
| turn ndcg_any@10 | 0.6761 | **0.7424** | +0.0663 |

Per-ability session recall_all@5 (unique_session):

| ability | n | minilm-l6 | nomic-v1.5 | Δ | movers |
|---|---|---|---|---|---|
| multi-session | 121 | 0.7273 | **0.8017** | +0.0744 | 11 up / 2 down |
| temporal-reasoning | 127 | 0.7480 | **0.7795** | +0.0315 | 7 up / 3 down |
| single-session-preference | 30 | 0.8667 | **0.9000** | +0.0333 | 3 up / 2 down |
| knowledge-update | 72 | 0.9861 | 0.9722 | −0.0139 | 0 up / 1 down |
| single-session-assistant | 56 | 0.9464 | 0.9286 | −0.0178 | 0 up / 1 down |
| single-session-user | 64 | 1.0000 | 1.0000 | 0 | — |

The gains land exactly on the W2 target abilities (multi-session and
temporal-reasoning — the baseline's weakest). Nine questions regressed in
total (spread across abilities, each offset by larger gains); the two
NEGATIVE ability-level aggregate deltas (knowledge-update, single-session-
assistant) are each caused by a single regressed question in a
near-ceiling ability.

## Resources (independent gate)

Controlled probe (single process, `process.memoryUsage.rss()` delta around
the first embed; warm latency = 40 sequential single-threaded embeds via
`performance.now()`, p50/p95 from the sorted sample):

| | cold load+first embed | incremental RSS | warm p50 | warm p95 |
|---|---|---|---|---|
| minilm-l6 (384d q8) | 1.0 s | +108 MB | 9 ms | 46 ms |
| nomic-v1.5 (768→512d q8) | 6.9 s | **+289 MB** | 53 ms | 92 ms |

Budget: ≤300 MB incremental for embedder + reranker COMBINED → nomic alone
leaves ~11 MB. Options before any default flip: smaller MRL dims (256),
budget revision, or challenger-as-opt-in. The combined embedder+reranker
measurement is a separate, required step when the reranker lands.

Supplementary operational evidence (NOT the budget metric): `/usr/bin/time -v`
maximum resident set size — total benchmark process peak, corpus and stores
included — nomic full run 1.63 GB over 3 h 52 m wall; minilm full run
1.60 GB over 44 m wall.

## Artifacts

- `longmemeval-s-hybrid-nomic-v1.5.{json,md}` — challenger full report
- `longmemeval-s-hybrid.{json,md}` — recorded baseline (reproduced exactly
  at `1f05ad0`; not re-recorded)
- `scripts/longmemeval/compare.mjs` — checked-in paired comparison
  (deltas, per-ability movers, sign test, seeded bootstrap CI); every
  number in this report reproduces from the two checked-in JSONs via the
  command above
