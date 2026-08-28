# W6 shadow evaluator latency

Date: 2026-08-26

Harness: `tests/governance-shadow-benchmark.test.ts`

Environment: Node v24.12.0, Git 2.43.0, Linux 6.8.0-117-generic x86_64,
AMD EPYC Processor (with IBPB), 8 cores.

Verdict: **PASS** — the largest measured p95 was **192.36 ms**, below the
250 ms Slice B acceptance ceiling by 57.64 ms. Every measured evaluation also
completed without a `deadline_exceeded` verdict.

## Protocol

The harness measures the wall-clock duration of the real end-to-end shadow
evaluator on clean temporary Git repositories. Each repository contains a real
`.cairn/gates.json`, one active `pre_exit` rule, current client capability state,
and 25, 250, or 1,000 tracked source files. The evaluator performs the production
config load, repository snapshot/watermark work, digest v2 capture, evidence
selection, capability and precedence resolution, and SQLite verdict persistence.

Each size receives three unmeasured warmups followed by 20 sequential samples.
p50 and p95 use nearest-rank ordering (`ceil(q*n)-1`). The acceptance run was
executed directly so it did not contend with the parallel full test suite:

`CAIRN_RUN_SHADOW_BENCHMARK=1 node dist/tests/governance-shadow-benchmark.test.js`

The default full-suite form validates the retained protocol and measurements but
does not rerun wall-clock acceptance under unrelated test contention.

## Results

| Tracked files | Samples | p50 | p95 | 250 ms gate |
|---:|---:|---:|---:|---|
| 25 | 20 | 82.92 ms | 100.61 ms | Pass |
| 250 | 20 | 86.41 ms | 112.97 ms | Pass |
| 1,000 | 20 | 137.40 ms | 192.36 ms | Pass |

Raw summary: `docs/benchmarks/w6-shadow-evaluator.json`.
