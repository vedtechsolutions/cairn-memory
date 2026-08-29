# Governance gate inspector (Slice A)


The checked-in [`.cairn/gates.json`](.cairn/gates.json) is a versioned example
of exact command forms, parsers, timeouts, skip policy, retention, and
path-to-gate rules. Inspect it without running a command or changing project,
database, settings, or network state:

```bash
npm run build
node scripts/inspect-gates.mjs --project . --paths src/index.ts,README.md --no-db
node scripts/inspect-gates.mjs --project . --paths src/index.ts --db /path/to/test-or-copy.db --json
```

The inspector returns `0` for a valid report, `2` for gate-config/path
validation failures, and `1` for inspector self-errors. Package scripts are
shown only as redacted, hash-keyed proposals and are never executed. The full
command line is not persisted by default — only a redacted form and a SHA-256
are stored; set `CAIRN_PERSIST_RAW_COMMAND=1` to opt into local-only raw
capture, which is never synced or exported. Environment values are read only to
match configured gate variables and are never stored or printed. Client
capability rows are read from a query-only in-memory SQLite snapshot, avoiding
even WAL sidecar creation in the source directory. A missing or
unobserved `FileChanged` capability is reported explicitly as **block
unavailable**. Every configured enforcement level is labeled **diagnostic
only — Slice A does not enforce**; Slice A does not emit warnings or blocks.

Projects without `.cairn/gates.json` key recorded evidence by the raw canonical
cwd (the recorder's `findProjectRoot` fallback).

Retention defaults to 30 days for reproducible tool-event and gate-run
evidence; audit and policy-rule histories remain until explicit cleanup when
their optional ceilings are absent. `cleanupLifecycle` treats a retired rule
family as one lifecycle unit: eligibility is based on the age of the family's
latest revision, then every revision and all of that family's audit rows are
pruned together—not according to each audit row's individual age. Active and
disabled families remain explainable.

