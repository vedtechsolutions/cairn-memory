# Development & manual configuration

## Architecture


```
┌──────────────────────────────────────────────────────────┐
│ Claude Code Session                                      │
│                                                          │
│  13 Hook handlers + StatusLine (passive, automatic):     │
│    SessionStart, UserPromptSubmit, PreToolUse,           │
│    PostToolUse, PostToolUseFailure, PreCompact,          │
│    PostCompact, SubagentStart, Stop, SubagentStop,       │
│    StopFailure, SessionEnd                               │
│                                                          │
│  17 MCP Tools (explicit, on-demand):                     │
│    waykeep_learn / waykeep_recall / waykeep_correct             │
│    waykeep_forget / waykeep_strengthen / waykeep_weaken         │
│    waykeep_plan / waykeep_remind / waykeep_expand               │
│    waykeep_reminder_list / waykeep_reminder_delete            │
│    waykeep_ingest / waykeep_export / waykeep_promote            │
│    waykeep_stats / waykeep_cleanup                            │
│                                                          │
│  2 MCP Resources (read-only views):                      │
│    waykeep://plan/{project}/active  → full plan state      │
│    waykeep://briefing/{project}     → full briefing        │
└──────────┬───────────────────────────────┬───────────────┘
           │                               │
     hook events                    stdio (MCP protocol)
           │                               │
           ▼                               │
  ┌─────────────────────┐                  │
  │ hook-relay (C binary)│                  │
  │ fallback → node.js   │                  │
  └──────────┬──────────┘                  │
             │ Unix socket                 │
             ▼                             ▼
┌──────────────────────────────────────────────────────────┐
│ Waykeep MCP Server (single Node.js process)                │
│                                                          │
│  ┌────────────────────┐  ┌─────────────────────────────┐ │
│  │ Embedded Hook      │  │ MCP Protocol Server         │ │
│  │ Socket (v5)        │  │ (stdio transport)           │ │
│  │ ~/.waykeep/hook-     │  │ 17 tools, 2 resources       │ │
│  │   daemon.sock      │  │                             │ │
│  │ 12 hook routes     │  │                             │ │
│  │ + /statusline      │  │                             │ │
│  └─────────┬──────────┘  └──────────────┬──────────────┘ │
│            │                            │                │
│            └──────────┬─────────────────┘                │
│                       ▼                                  │
│            ┌─────────────────────┐                       │
│            │ Shared SessionCache │                       │
│            │ + memoryVersion     │                       │
│            │ + skip-gate cache   │                       │
│            ├─────────────────────┤                       │
│            │ better-sqlite3 (1x) │                       │
│            │ Embedding model     │                       │
│            └─────────────────────┘                       │
└──────────────────────────────────────────────────────────┘
              │                        │
              ▼                        ▼
       ~/.waykeep/waykeep.db    ~/.claude/waykeep-state.json
       (SQLite+FTS5+vec)      (StatusLine context pressure)
```


## Manual configuration (what `waykeep init` automates)

### 2. Configure MCP Server

Register the server at user scope with the `claude` CLI. Claude Code reads
MCP servers from `~/.claude.json` (or `$CLAUDE_CONFIG_DIR/.claude.json`) —
an `mcpServers` key in `~/.claude/settings.json` is silently ignored, that
file only carries MCP *policy* keys:

```bash
claude mcp add-json -s user waykeep '{"type":"stdio","command":"node","args":["/path/to/waykeep/dist/src/mcp/server.js"],"env":{"WAYKEEP_LOG_LEVEL":"info"}}'
```

`add-json` refuses a name that already exists; to re-point a moved install,
run `claude mcp remove waykeep -s user` first. (`waykeep init` does exactly
this, and prints the command when `claude` is not on PATH.)

### 3. Configure Hooks And StatusLine

Add all hook events to your `settings.json`. Every hook is important: missing hooks create blind spots in Waykeep's learning. Most hooks should call the compiled relay so they run against the shared hook socket at `~/.waykeep/hook-daemon.sock`; the relay falls back to direct Node when the socket is unavailable. `PreCompact` and `SessionEnd` are standalone Node hooks because they are not socket routes. `StatusLine` is not a hook event, but it is required for context-pressure tracking and dynamic briefing budgets.

The socket has exactly one owner at a time, arbitrated cooperatively (a live owner is never displaced): the standalone daemon below when installed, otherwise the first agent client's MCP server to start (embedded mode). Client servers that find a live owner share its socket and relay their write-tool cache invalidations to it over `/bump-memory-version`.


### 3c. Codex CLI (cross-agent parity)

Waykeep gives Codex the same automatic experience Claude Code gets — session
briefing, ambient recall, pre-tool pitfall warnings, and auto-capture of
errors/decisions/successes into the same shared store, with per-memory
`origin_client` provenance. `waykeep init` wires it when `~/.codex` exists:
it generates `~/.codex/hooks.json` (every event through the relay with
`--client codex`) and registers the MCP server in `~/.codex/config.toml`.

**One manual step**: Codex hash-pins hooks and silently skips them until you
approve them once. After `waykeep init`, start `codex` — the startup review
lists the 10 "Waykeep memory hooks"; accept them (or use `/hooks`). Trust
survives reinstalls as long as the hook commands don't change; `waykeep
doctor`'s `codex parity` check reports wired / awaiting-trust state.

Notes: non-interactive `codex exec` rejects MCP tool calls under its default
approval policy — use `codex exec --approve-for-me` when a script needs
`waykeep_*` tools (hooks are unaffected). Failed code-mode `apply_patch`
calls emit no hook or rollout record in Codex 0.150.x and are not capturable
(documented gap); shell failures — the dominant error class — are fully
captured, with a daemon-side rollout tailer as the zero-config fallback when
hooks are untrusted (`WAYKEEP_TAILER=0` disables).

### 4. Verify Installation

```bash
# One-command health check: Node, native SQLite + sqlite-vec, hook relay,
# embedding model pin, database schema, and hook socket. Exits non-zero on a
# critical failure, so it can gate CI and setup scripts. Diagnostic only —
# it never creates the database, binds the socket, or downloads a model.
waykeep doctor          # or: node dist/src/cli/index.js doctor

# Run tests
npm test

# Check hook telemetry after a session
sqlite3 ~/.waykeep/waykeep.db "SELECT hook_name, COUNT(*), SUM(success) FROM hook_telemetry GROUP BY hook_name;"

# Check context-pressure state written by StatusLine
cat ~/.claude/waykeep-state.json

# Check whether hooks fell back from the socket to direct Node
test -f ~/.waykeep/hook-relay-fallback.log && tail -20 ~/.waykeep/hook-relay-fallback.log

# Check memory count
sqlite3 ~/.waykeep/waykeep.db "SELECT kind, COUNT(*) FROM memories WHERE invalidated=0 GROUP BY kind;"
```


### 5. Optional: Use as Primary Memory

To use Waykeep as Claude's primary memory instead of the built-in file-based auto memory:

1. Add `"autoMemoryEnabled": false` to your `~/.claude/settings.json` (suppresses built-in MEMORY.md writes)
2. Copy `.claude/rules/waykeep.md` to your project (or symlink for global use)
3. Trim your `MEMORY.md` to a bootstrap stub (build commands, DB path only)
4. All knowledge flows through `waykeep_learn` / `waykeep_recall` instead of file writes


### 6. Optional: Claude Memory-Tool Backend

Waykeep implements the handler side of Anthropic's `memory_20250818` tool:
Claude browses and edits `/memories/**` through the standard six file
commands while every write lands in Waykeep's structured store — CAS-token
edit grammar, smart-merge gateway, frozen paging, and per-command write
transactions included.

```ts
import { betaMemoryTool } from '@anthropic-ai/sdk/helpers/beta/memory';
import { createMemoryToolHandlers } from './dist/src/memory-tool/sdk-adapter.js';

const tool = betaMemoryTool(createMemoryToolHandlers({ db, planRepo }));
```

Full contract, virtual-filesystem layout, and guarantees:
[`docs/memory-tool-adapter.md`](docs/memory-tool-adapter.md).


## Development

```bash
npm run build    # Compile TypeScript + hook-relay C binary
npm test         # Run tests (node:test via scripts/run-tests.mjs — fails on zero discovered tests; hermetic via tests/hermetic-env.cjs preload)
npm run dev      # Watch mode (tsc --watch)

node scripts/snr-probe.mjs           # Measure briefing signal/noise on a warm-compact snapshot
node scripts/snr-probe.mjs --cold    # Same probe against a cold-start briefing
node scripts/snr-inverse-probe.mjs   # Assert 100% recall of known-relevant memories

node scripts/longmemeval/run.mjs                    # LongMemEval harness on the checked-in fixture (fts)
node scripts/longmemeval/run.mjs --variant hybrid   # hybrid variant (add --embed for real embeddings)
node scripts/longmemeval/run.mjs --variant hybrid --embed --rerank  # + cross-encoder rerank stage
node scripts/longmemeval/fetch.mjs                  # download the pinned real dataset (never used by CI)

node scripts/longmemeval/compare.mjs <baseline.json> <challenger.json>  # paired A/B: deltas, sign test, seeded bootstrap CI

# Recorded LongMemEval-S baselines (docs/benchmarks/) — regenerate with:
node scripts/longmemeval/run.mjs \
  --data ~/.waykeep/benchmarks/longmemeval/longmemeval_s_cleaned.json \
  --variant fts \
  --out docs/benchmarks/longmemeval-s-fts.json --md docs/benchmarks/longmemeval-s-fts.md
node scripts/longmemeval/run.mjs \
  --data ~/.waykeep/benchmarks/longmemeval/longmemeval_s_cleaned.json \
  --variant hybrid --embed \
  --out docs/benchmarks/longmemeval-s-hybrid.json --md docs/benchmarks/longmemeval-s-hybrid.md
node scripts/repair-confidence.mjs                  # dry-run confidence repair (see --execute)
```

Test-environment overrides (all set automatically by `tests/hermetic-env.cjs`):

| Env var | Effect |
|---------|--------|
| `WAYKEEP_DB_PATH` | Database location (also honored in production) |
| `WAYKEEP_DIR` | State directory (default `~/.waykeep`; un-migrated installs use `~/.cairn`) |
| `WAYKEEP_STATE_PATH` | `waykeep-state.json` location (default `~/.claude/waykeep-state.json`) |
| `WAYKEEP_QUERY_CWD` | Pins the briefing query-fingerprint cwd signal (A1 checkout-name neutrality) |
| `WAYKEEP_ALLOW_TMP_TRANSCRIPTS` | Admits the OS tmpdir into the transcript-path allowlist (tests only) |
| `WAYKEEP_TAILER` | `0` disables the daemon's Codex rollout tailer (capture fallback) |
| `WAYKEEP_CODEX_SESSIONS_DIR` | Overrides `~/.codex/sessions` for the rollout tailer (tests) |
| `WAYKEEP_CODEX_DIR` | Overrides `~/.codex` for `waykeep init`/`doctor` |
| `WAYKEEP_CLAUDE_SETTINGS` | Overrides `~/.claude/settings.json` for `waykeep init` |
| `WAYKEEP_CLAUDE_CONFIG` | Overrides `~/.claude.json` (the MCP registry `waykeep init` reads) |
| `WAYKEEP_CLAUDE_BIN` | Path of the `claude` CLI `waykeep init` runs (also useful when it is installed off-PATH) |



## Reference (moved from the README front page)

## Truth Maintenance

Waykeep keeps stored facts and decisions trustworthy without deleting anything:

- **Supersession** — when a new fact/decision gives a newer semver value for the same subject ("node 18.1" → "20.3"), the older claim is retired (excluded from recall, kept queryable). This is the only path that hides a memory, so it's limited to unambiguous version advances — a lower-authority observation never silently retires a higher-authority claim, and a bare-number difference (error codes, ports, counts) is treated as a contradiction to flag, not a supersession.
- **Standing contradiction** — genuinely opposing memories (negation/antonym flip on the same subject, scope-guarded) get a `contradicts` edge; both keep surfacing and the briefing lists them under "Conflicting memories — verify & resolve." Nothing is auto-resolved.
- **Truth-decay** — facts/decisions with time-sensitive claims render a "(verify — Nd old)" marker past a claim-type half-life (version 90d / metric 120d / date 180d / volatile 60d). Read-time, non-destructive; durable facts never decay.

## Context-Adaptive Modes

| Mode | Context Free | Behavior |
|------|-------------|----------|
| `normal` | >50% | Full injection: 5 pitfalls, facts, reminders |
| `compact` | 25-50% | Reduced: 3 pitfalls, skip facts |
| `minimal` | 10-25% | Minimal injection: 1 pitfall |
| `critical` | <10% | Near-silent: hard 600-token briefing cap, no prompt/pitfall injection |


## Database details

## Database

- Location: `~/.waykeep/waykeep.db`
- Engine: SQLite 3 with WAL mode + FTS5 + sqlite-vec (vector similarity)
- Schema version: 31
- Configurable via `WAYKEEP_DB_PATH` env var
- Embeddings: 384-dim via `@huggingface/transformers` (all-MiniLM-L6-v2, q8) — selected from the model registry (`src/constants/embedding-models.ts`) via `WAYKEEP_EMBEDDING_MODEL` (default `minilm-l6`; challengers `nomic-v1.5` / `nomic-v1.5-256` / `embeddinggemma-300m`). Schema v26 tags every stored vector with its model: vector reads filter on the active model, and after a model switch the backfill worker re-embeds mismatched rows while FTS+RRF carry retrieval
- Reranking (opt-in): `WAYKEEP_RERANK=1` enables a cross-encoder stage on `waykeep_recall` (RRF top-20 → rerank → top-k; MCP server only); model via `WAYKEEP_RERANK_MODEL` (default `jina-turbo-v1`, registry in `src/constants/reranker-models.ts`)


## Report rollup controls

Recording is on by default; disable with `{"report":{"rollup":false}}` in `~/.waykeep/config.json` or `WAYKEEP_ROLLUP=0` — both are true zero-writes.

## Private-project session identity

Session identity derives from the server's working directory (git remote when available, path hash otherwise). For non-git projects, launch your agent from the project root — a subdirectory or symlinked path derives a different identity and the private project's content will (safely) not be returned. `waykeep_recall` with no `project` argument targets the session's own project (the same default `waykeep_learn` uses) plus globals; `scope: "project"` narrows to only the target project's rows, `scope: "global"` to only globals. `scope: "project"` errors only when there is no target at all (no argument and no derivable session project).
