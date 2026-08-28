# nomic-v1.5-256 decision evidence (W2 close, step 3)

All artifacts in this directory; exact reproduction commands below.

## Stratified quality smoke (both arms at commit `02169e5`)

- `strat-minilm.json` — baseline: `node scripts/longmemeval/run.mjs
  --data <stratified-24.json> --variant hybrid --embed`
- `strat-nomic256.json` — challenger: same command with
  `CAIRN_EMBEDDING_MODEL=nomic-v1.5-256`
- `comparison.txt` — `node scripts/longmemeval/compare.mjs strat-minilm.json
  strat-nomic256.json`

The stratified subset is the first 4 questions per ability type of the
manifest-pinned `longmemeval_s_cleaned.json` (dataset revision + sha256 in
each report's meta). Result: 1 improved / 0 regressed / rest tied on
session recall_all@5 in both namespaces; the mover (`gpt4_59c863d7`,
multi-session) is the same question nomic-v1.5 (512) fixed in its full
run — smoke-equivalent quality at half the stored dimension. Directional
evidence only (n=24); full-run validation of nomic-256 remains optional
and open.

## Vector-scan latency / footprint (`vector-scan.json`)

`node scripts/longmemeval/vector-scan-probe.mjs --out vector-scan.json`
(5000 synthetic unit-norm rows per dim, top-20 scans, 40 reps,
nearest-rank quantiles, raw samples retained):

| dim | bytes/vector | scan p50 | scan p95 |
|---|---|---|---|
| 256 | 1024 | 9.21 ms | 14.14 ms |
| 384 (minilm) | 1536 | 9.99 ms | 23.24 ms |
| 512 (nomic) | 2048 | 13.47 ms | 53.90 ms |

Footprint is exact arithmetic (33% smaller than minilm, 50% smaller than
nomic-512). Scan latency: 256d measured modestly faster than 384d (~8%
p50 in this committed run; an earlier uncommitted run measured a larger
gap — run-to-run variance is material at these absolute magnitudes) and
clearly faster than 512d (~32% p50). None of these is a bottleneck at
current store sizes; recorded for the scaling picture.

## Model-side resources

Identical weights to nomic-v1.5 — model RAM (+289 MB cold probe) and
embed latency (p50 53 ms) carry over unchanged from
`w2-nomic-ab-report.md`; only the stored/queried vector shrinks.
