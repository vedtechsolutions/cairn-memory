# Step-4 live-store remediation — evidence of record (2026-09-02)

The one sanctioned write of the memory remediation: 88 truncation-polluted
rows (content exactly 200 chars ending `...` — the old extractors'
`slice(0,197)+'...'` signature) invalidated on the live store, with 23
replacements (12 hand-reviewed truncated decisions + 11 reviewer-identified
false-negative recoveries, incl. f01d97a6) stored as pure prefix cuts at
each ancestor's live confidence and project, zero inherited telemetry.

Authorization: dual review (Claude + codex), three rounds, pinned to
`final-manifest.json` at the sha in `final-manifest.sha256`
(2bc3f293…). Applied per-row atomically (IMMEDIATE transaction: CAS on
content sha + project + kind + active, invalidate, replacement insert).

PRIVACY: this directory ships in the public tree, so MEMORY CONTENT IS
REDACTED here (codex step-8/9 review). The full unredacted manifest,
receipt, and post-apply replay live in the store owner's private data dir:
`~/.cairn/remediation/2026-09-02-step4/`. Integrity between the two is
pinned by per-row `content_sha256` / `replacement_sha256` digests.

| artifact | what it proves |
|---|---|
| `final-manifest.sanitized.json` | all 88 rows — ids, kinds, hashed project, confidence, telemetry, action, bucket, content/replacement sha256 (content redacted) |
| `final-manifest.sha256` | the authorization pin of the FULL manifest the apply verified |
| `receipt.sanitized.json` | 88 applied + 23 replacement ids/confidences — from `--apply --live` (content redacted) |
| `apply-log.txt` | 88 INVALID + 23 REPLACED, 0 FAILED / 0 DRIFTED / 0 UNKNOWN (ids only) |
| `verify-log.txt` | `--verify --receipt`: 111 match, 0 mismatch, 0 signature residue (ids only) |

Instrument: `scripts/remediate-truncated.mjs` (gated by
`tests/remediation-manifest.test.ts`).
