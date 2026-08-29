# Development & manual configuration

## Architecture


```
┌──────────────────────────────────────────────────────────┐
│ Claude Code Session                                      │
│                                                          │
│  14 Hooks + StatusLine (passive, automatic):             │
│    SessionStart, UserPromptSubmit, PreToolUse,           │
│    PostToolUse, PostToolUseFailure, PreCompact,          │
│    PostCompact, SubagentStart, Stop, SubagentStop,       │
│    StopFailure, FileChanged, SessionEnd                  │
│                                                          │
│  16 MCP Tools (explicit, on-demand):                     │
│    cairn_learn / cairn_recall / cairn_correct             │
│    cairn_forget / cairn_strengthen / cairn_weaken         │
│    cairn_plan / cairn_remind / cairn_expand               │
│    cairn_reminder_list / cairn_reminder_delete            │
│    cairn_ingest / cairn_export / cairn_promote            │
│    cairn_stats / cairn_cleanup                            │
│                                                          │
│  2 MCP Resources (read-only views):                      │
│    cairn://plan/{project}/active  → full plan state      │
│    cairn://briefing/{project}     → full briefing        │
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
│ Cairn MCP Server (single Node.js process)                │
│                                                          │
│  ┌────────────────────┐  ┌─────────────────────────────┐ │
│  │ Embedded Hook      │  │ MCP Protocol Server         │ │
│  │ Socket (v5)        │  │ (stdio transport)           │ │
│  │ ~/.cairn/hook-     │  │ 16 tools, 2 resources       │ │
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
       ~/.cairn/cairn.db    ~/.claude/cairn-state.json
       (SQLite+FTS5+vec)      (StatusLine context pressure)
```


## Manual configuration (what `cairn init` automates)

### 2. Configure MCP Server

Add to your Claude Code settings (`~/.claude/settings.json`):

```json
{
  "mcpServers": {
    "cairn": {
      "command": "node",
      "args": ["/path/to/cairn/dist/src/mcp/server.js"],
      "env": {
        "CAIRN_LOG_LEVEL": "info"
      }
    }
  }
}
```

### 3. Configure Hooks And StatusLine

Add all hook events to your `settings.json`. Every hook is important: missing hooks create blind spots in Cairn's learning. Most hooks should call the compiled relay so they run against the shared hook socket at `~/.cairn/hook-daemon.sock`; the relay falls back to direct Node when the socket is unavailable. `PreCompact` and `SessionEnd` are standalone Node hooks because they are not socket routes. `StatusLine` is not a hook event, but it is required for context-pressure tracking and dynamic briefing budgets.

The socket has exactly one owner at a time, arbitrated cooperatively (a live owner is never displaced): the standalone daemon below when installed, otherwise the first agent client's MCP server to start (embedded mode). Client servers that find a live owner share its socket and relay their write-tool cache invalidations to it over `/bump-memory-version`.


### 3c. Codex CLI (cross-agent parity)

Cairn gives Codex the same automatic experience Claude Code gets — session
briefing, ambient recall, pre-tool pitfall warnings, and auto-capture of
errors/decisions/successes into the same shared store, with per-memory
`origin_client` provenance. `cairn init` wires it when `~/.codex` exists:
it generates `~/.codex/hooks.json` (every event through the relay with
`--client codex`) and registers the MCP server in `~/.codex/config.toml`.

**One manual step**: Codex hash-pins hooks and silently skips them until you
approve them once. After `cairn init`, start `codex` — the startup review
lists the 10 "Cairn memory hooks"; accept them (or use `/hooks`). Trust
survives reinstalls as long as the hook commands don't change; `cairn
doctor`'s `codex parity` check reports wired / awaiting-trust state.

Notes: non-interactive `codex exec` rejects MCP tool calls under its default
approval policy — use `codex exec --approve-for-me` when a script needs
`cairn_*` tools (hooks are unaffected). Failed code-mode `apply_patch`
calls emit no hook or rollout record in Codex 0.150.x and are not capturable
(documented gap); shell failures — the dominant error class — are fully
captured, with a daemon-side rollout tailer as the zero-config fallback when
hooks are untrusted (`CAIRN_TAILER=0` disables).

### 4. Verify Installation

```bash
# One-command health check: Node, native SQLite + sqlite-vec, hook relay,
# embedding model pin, database schema, and hook socket. Exits non-zero on a
# critical failure, so it can gate CI and setup scripts. Diagnostic only —
# it never creates the database, binds the socket, or downloads a model.
cairn doctor            # or: node dist/src/cli/index.js doctor

# Run tests
npm test

# Check hook telemetry after a session
sqlite3 ~/.cairn/cairn.db "SELECT hook_name, COUNT(*), SUM(success) FROM hook_telemetry GROUP BY hook_name;"

# Check context-pressure state written by StatusLine
cat ~/.claude/cairn-state.json

# Check whether hooks fell back from the socket to direct Node
test -f ~/.cairn/hook-relay-fallback.log && tail -20 ~/.cairn/hook-relay-fallback.log

# Check memory count
sqlite3 ~/.cairn/cairn.db "SELECT kind, COUNT(*) FROM memories WHERE invalidated=0 GROUP BY kind;"
```


### 5. Optional: Use as Primary Memory

To use Cairn as Claude's primary memory instead of the built-in file-based auto memory:

1. Add `"autoMemoryEnabled": false` to your `~/.claude/settings.json` (suppresses built-in MEMORY.md writes)
2. Copy `.claude/rules/cairn.md` to your project (or symlink for global use)
3. Trim your `MEMORY.md` to a bootstrap stub (build commands, DB path only)
4. All knowledge flows through `cairn_learn` / `cairn_recall` instead of file writes


### 6. Optional: Claude Memory-Tool Backend

Cairn implements the handler side of Anthropic's `memory_20250818` tool:
Claude browses and edits `/memories/**` through the standard six file
commands while every write lands in Cairn's structured store — CAS-token
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
  --data ~/.cairn/benchmarks/longmemeval/longmemeval_s_cleaned.json \
  --variant fts \
  --out docs/benchmarks/longmemeval-s-fts.json --md docs/benchmarks/longmemeval-s-fts.md
node scripts/longmemeval/run.mjs \
  --data ~/.cairn/benchmarks/longmemeval/longmemeval_s_cleaned.json \
  --variant hybrid --embed \
  --out docs/benchmarks/longmemeval-s-hybrid.json --md docs/benchmarks/longmemeval-s-hybrid.md
node scripts/repair-confidence.mjs                  # dry-run confidence repair (see --execute)
```

Test-environment overrides (all set automatically by `tests/hermetic-env.cjs`):

| Env var | Effect |
|---------|--------|
| `CAIRN_DB_PATH` | Database location (also honored in production) |
| `CAIRN_DIR` | Tracker/lock/dedup state directory (default `~/.cairn`) |
| `CAIRN_STATE_PATH` | `cairn-state.json` location (default `~/.claude/cairn-state.json`) |
| `CAIRN_QUERY_CWD` | Pins the briefing query-fingerprint cwd signal (A1 checkout-name neutrality) |
| `CAIRN_ALLOW_TMP_TRANSCRIPTS` | Admits the OS tmpdir into the transcript-path allowlist (tests only) |
| `CAIRN_TAILER` | `0` disables the daemon's Codex rollout tailer (capture fallback) |
| `CAIRN_CODEX_SESSIONS_DIR` | Overrides `~/.codex/sessions` for the rollout tailer (tests) |

