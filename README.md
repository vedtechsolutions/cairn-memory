# Cairn

Dual-channel memory system for AI coding agents. Hooks + MCP tools give Claude Code and Codex ONE persistent, shared memory across sessions — briefings, pitfall warnings, auto-learned lessons with per-agent provenance — plus seamless recovery after context compaction.

[![npm version](https://img.shields.io/npm/v/cairn-memory.svg)](https://www.npmjs.com/package/cairn-memory)
[![license: Elastic-2.0](https://img.shields.io/badge/license-Elastic--2.0-blue.svg)](LICENSE)
[![node](https://img.shields.io/node/v/cairn-memory.svg)](https://nodejs.org)
[![CI](https://github.com/vedtechsolutions/cairn-memory/actions/workflows/ci.yml/badge.svg)](https://github.com/vedtechsolutions/cairn-memory/actions/workflows/ci.yml)

> Published on npm as [`cairn-memory`](https://www.npmjs.com/package/cairn-memory). "Cairn" is the project; `cairn-memory` is the package, and it installs the `cairn` CLI.

## What It Does

Cairn solves two problems that ruin long agent sessions.

**Context compaction destroys working memory.** After compaction, an agent forgets what it was doing, what files it read, what decisions it made, and what mistakes to avoid.

**Every agent is a memory island.** What Claude learned the hard way, Codex re-learns the hard way — and vice versa. As of v5.3, Cairn gives every agent on a machine one shared, ambient memory: Codex fails a command once, and Claude gets warned before touching the same file; decisions, corrections, and lessons carry `origin_client` provenance so you always know which agent learned what. Switch models freely — the memory stays.

Cairn fixes this with:

- **14 lifecycle hooks + StatusLine** (Claude Code) and **10 trusted hooks** (Codex) that passively capture context pressure, errors, successes, corrections, file activity, task state, plans, compaction, subagents, and API failures — wired automatically by `cairn init`
- **17 MCP tools** + **2 MCP resources** for explicit memory management, planning, reminders, and progressive-disclosure expansion
- **SQLite + FTS5 + vector embeddings** backend with hybrid search (RRF), confidence-weighted ranking, and natural decay
- **Embedded hook socket** (v5) — socket-routed hooks run through a persistent Unix socket inside the MCP server process, sharing one DB connection and one session cache. Skip gates short-circuit null-output `pitfall-check` calls in <1 ms.
- **Write gateways** (`storeDecision()` / `storePitfall()`) that unify all storage paths with smart merge (source authority, dedup, enrichment)
- **Context-adaptive injection** that scales down as the context window fills
- **Dynamic briefing budget** (600–3000 tokens) that scales with available context window
- **Progressive disclosure briefing** (v5) — post-compaction sessions receive a compact structured index with stable type-coded IDs; Claude pulls full detail on demand via `cairn_expand`
- **Fast token estimator** (v5) — briefing compile dropped from 2,200–4,760 ms to 9–13 ms by replacing the WASM tokenizer in the hot loop with a char-based approximation (200–500× speedup)
- **In-process skip-gate invalidation** (v5) — MCP write tools bump a shared `memoryVersion` counter, giving corrections a staleness bound of zero to the next hook call with no IPC or polling
- **Infrastructure extraction** — auto-recall, decision mining, and plan bridging reduce dependence on explicit tool calls

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

## Post-Compaction Recovery

After compaction, Cairn injects a tier-based briefing:

- **Tier 1 (always)**: Goals (three-tier Now/Feature/Project rendering with per-tier staleness and age labels), git state, structured user profile, plan state, decisions from active plan, recently read/modified files, reasoning state (hypotheses + open questions), error context, approach
- **Tier 2 (high)**: Decisions from memory DB — effectiveness-ranked, with investigation chain summaries
- **Tier 3 (high)**: Pitfalls — effectiveness-ranked, quality-adaptive count
- **Tier 4 (medium)**: Corrections — quality-gated

Budget: dynamic (600–3000 tokens based on context pressure). Cascading allocation: each tier gets min(tier budget, remaining space). Project context uses ultra-compact single-line format on startup, skipped entirely on compact. Stage 2 correction pass recovers high-impact pitfalls dropped during reduction.

## Memory Types

| Kind | Purpose | Example |
|------|---------|---------|
| `pitfall` | Mistakes to avoid | "Never use raw SQL in Odoo models" |
| `decision` | Architectural choices | "Use authlib over python-social-auth" |
| `correction` | User-specified rules | "Always use snake_case for Python methods" |
| `fact` | Stable knowledge | "DB uses PostgreSQL 15 in production" |
| `pattern` | Distilled wins from smooth sessions | "Two-step refactor approach — tests passed first try" |
| `goal` | Task/project intent for cross-session continuity | "Primary memory integration — North-Star Phases 3-5" |
| `user_profile` | User role, expertise, preferences (always global) | "User prioritizes quality over speed" |
| `reference` | Pointers to external systems (auto-prefixed `ref:`) | "Linear issue TRK-42: auth token refresh" |

## Truth Maintenance

Cairn keeps stored facts and decisions trustworthy without deleting anything:

- **Supersession** — when a new fact/decision gives a newer semver value for the same subject ("node 18.1" → "20.3"), the older claim is retired (excluded from recall, kept queryable). This is the only path that hides a memory, so it's limited to unambiguous version advances — a lower-authority observation never silently retires a higher-authority claim, and a bare-number difference (error codes, ports, counts) is treated as a contradiction to flag, not a supersession.
- **Standing contradiction** — genuinely opposing memories (negation/antonym flip on the same subject, scope-guarded) get a `contradicts` edge; both keep surfacing and the briefing lists them under "Conflicting memories — verify & resolve." Nothing is auto-resolved.
- **Truth-decay** — facts/decisions with time-sensitive claims render a "(verify — Nd old)" marker past a claim-type half-life (version 90d / metric 120d / date 180d / volatile 60d). Read-time, non-destructive; durable facts never decay.

## Context-Adaptive Modes

| Mode | Context Free | Behavior |
|------|-------------|----------|
| `normal` | >50% | Full injection: 5 pitfalls, facts, reminders |
| `compact` | 25-50% | Reduced: 3 pitfalls, skip facts |
| `minimal` | 10-25% | Minimal injection: 1 pitfall |
| `critical` | <10% | Silent — preserves remaining context |

## Installation

### Prerequisites

- Node.js >= 20.0.0
- Claude Code CLI installed
- A C compiler is optional (it builds the fast hook relay; without one, Cairn falls back to a bundled shell relay)

### Quick start (npm)

```bash
npm install -g cairn-memory   # installs the `cairn` CLI
cairn init                    # writes the MCP server + all hooks + StatusLine into ~/.claude/settings.json
cairn doctor                  # health check: Node, native SQLite, relay, model pin, DB schema, socket
```

`cairn init` is idempotent, backs up your existing settings, and merges in Cairn without disturbing your other MCP servers or hooks; pass `--dry-run` to preview. That is the whole setup. The sections below explain what `init` configures and give the manual / from-source path.

### From source (contributors)

```bash
git clone https://github.com/vedtechsolutions/cairn-memory.git
cd cairn-memory
npm install
npm run build
```

The manual configuration steps below are exactly what `cairn init` automates — follow them only if you are wiring Cairn up by hand or from a source checkout.

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

### 3b. Standalone Daemon (recommended when multiple agents share a machine)

When more than one agent client uses Cairn on the same machine (for example Claude Code and Codex side by side), run the hook socket as its own service so it survives session churn and no client ever waits on another's lifecycle:

```bash
sudo cp deploy/cairn-daemon.service /etc/systemd/system/   # adjust paths inside first
sudo systemctl daemon-reload
sudo systemctl enable --now cairn-daemon
```

After every `npm run build`, restart it to pick up the new code: `sudo systemctl restart cairn-daemon`. Check it with `curl -s --unix-socket ~/.cairn/hook-daemon.sock http://localhost/health` — `mode` reports `standalone`. Without the daemon everything still works in embedded mode; sampling-backed hook features (Layer 1c reflection) are only available in embedded mode since the standalone daemon has no MCP client to sample through.

```json
{
  "statusLine": {
    "type": "command",
    "command": "node /path/to/cairn/dist/src/hooks/statusline.js"
  },
  "hooks": {
    "SessionStart": [
      {
        "matcher": "",
        "hooks": [
          { "type": "command", "command": "/path/to/cairn/dist/src/hooks/hook-relay session-start" }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "matcher": "",
        "hooks": [
          { "type": "command", "command": "/path/to/cairn/dist/src/hooks/hook-relay prompt-check" }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "Write|Edit|MultiEdit",
        "hooks": [
          { "type": "command", "command": "/path/to/cairn/dist/src/hooks/hook-relay pitfall-check" }
        ]
      },
      {
        "matcher": "Bash",
        "hooks": [
          { "type": "command", "command": "/path/to/cairn/dist/src/hooks/hook-relay pitfall-check" }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Bash|Write|Edit|MultiEdit",
        "hooks": [
          { "type": "command", "command": "/path/to/cairn/dist/src/hooks/hook-relay success-tracker", "async": true }
        ]
      },
      {
        "matcher": "ExitPlanMode",
        "hooks": [
          { "type": "command", "command": "/path/to/cairn/dist/src/hooks/hook-relay plan-bridge" }
        ]
      }
    ],
    "PostToolUseFailure": [
      {
        "matcher": "Bash|Write|Edit|MultiEdit",
        "hooks": [
          { "type": "command", "command": "/path/to/cairn/dist/src/hooks/hook-relay error-learning", "async": true }
        ]
      }
    ],
    "PreCompact": [
      {
        "matcher": "",
        "hooks": [
          { "type": "command", "command": "node /path/to/cairn/dist/src/hooks/precompact.js" }
        ]
      }
    ],
    "PostCompact": [
      {
        "matcher": "",
        "hooks": [
          { "type": "command", "command": "/path/to/cairn/dist/src/hooks/hook-relay postcompact" }
        ]
      }
    ],
    "SessionEnd": [
      {
        "matcher": "",
        "hooks": [
          { "type": "command", "command": "node /path/to/cairn/dist/src/hooks/session-end.js" }
        ]
      }
    ],
    "SubagentStart": [
      {
        "matcher": "",
        "hooks": [
          { "type": "command", "command": "/path/to/cairn/dist/src/hooks/hook-relay subagent-context" }
        ]
      }
    ],
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          { "type": "command", "command": "/path/to/cairn/dist/src/hooks/hook-relay governance-gate" },
          { "type": "command", "command": "/path/to/cairn/dist/src/hooks/hook-relay stop", "async": true }
        ]
      }
    ],
    "SubagentStop": [
      {
        "matcher": "",
        "hooks": [
          { "type": "command", "command": "/path/to/cairn/dist/src/hooks/hook-relay subagent-stop", "async": true }
        ]
      }
    ],
    "StopFailure": [
      {
        "matcher": "rate_limit|max_output_tokens|server_error",
        "hooks": [
          { "type": "command", "command": "/path/to/cairn/dist/src/hooks/hook-relay stop-failure", "async": true }
        ]
      }
    ],
    "FileChanged": [
      {
        "matcher": "",
        "hooks": [
          { "type": "command", "command": "/path/to/cairn/dist/src/hooks/hook-relay file-changed", "async": true }
        ]
      }
    ]
  }
}
```

The synchronous `governance-gate` entry must remain before the async `stop`
entry. To disable warn mode or uninstall only the governance relay, remove the
`governance-gate` command and leave the async `stop` entry in place; Cairn then
returns to advisory-only Slice B behavior.

Or configure Claude Code automatically instead of editing `settings.json` by hand:

```bash
cairn init              # merge Cairn's MCP + StatusLine + hooks into ~/.claude/settings.json
cairn init --dry-run          # preview the changes without writing
cairn init --migrate-routes   # modernize deprecated hook routes (one re-trust in Codex)
```

`cairn init` is idempotent and preserves your existing settings (it backs up
`settings.json` first and never touches non-Cairn config).

A C compiler is **not** required: the hooks run through the shell relay by
default. For the fast compiled relay, run `cairn build-relay` where a C
compiler is available (it falls back to the shell relay otherwise). The shell
relay needs a POSIX shell (`bash` + `curl`); on Windows, run `cairn build-relay`
for the compiled relay, or use WSL. Install paths containing spaces are not
currently supported by the generated hook commands.

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

## Governance gate inspector (Slice A)

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

## Database

- Location: `~/.cairn/cairn.db`
- Engine: SQLite 3 with WAL mode + FTS5 + sqlite-vec (vector similarity)
- Schema version: 28
- Configurable via `CAIRN_DB_PATH` env var
- Embeddings: 384-dim via `@huggingface/transformers` (all-MiniLM-L6-v2, q8) — selected from the model registry (`src/constants/embedding-models.ts`) via `CAIRN_EMBEDDING_MODEL` (default `minilm-l6`; challengers `nomic-v1.5` / `nomic-v1.5-256` / `embeddinggemma-300m`). Schema v26 tags every stored vector with its model: vector reads filter on the active model, and after a model switch the backfill worker re-embeds mismatched rows while FTS+RRF carry retrieval
- Reranking (opt-in): `CAIRN_RERANK=1` enables a cross-encoder stage on `cairn_recall` (RRF top-20 → rerank → top-k; MCP server only); model via `CAIRN_RERANK_MODEL` (default `jina-turbo-v1`, registry in `src/constants/reranker-models.ts`)

## Scope Controls

Mark a project **private** and its memories never surface in any other project — not in briefings, prompt or pitfall injections, subagent context, or `cairn_recall` (including graph-neighbor enrichment). Inside the project everything works normally.

Create `~/.cairn/config.json` (override the path with `CAIRN_CONFIG_PATH`):

```json
{
  "v": 1,
  "scope": {
    "privateProjects": ["clientwork-aaaa1111"]
  }
}
```

Project IDs are the `<name>-<hash>` slugs shown in briefings and `cairn_stats`. The file is read live — no restart needed. An absent file means no restrictions; an invalid file logs a warning and applies none (fix it to reactivate).

What "private" enforces: automatic surfaces (briefings, prompt/pitfall injections, subagent context, predictive recall) never carry the project's content elsewhere, and explicit tool reads (`cairn_recall`, `cairn_export`, `cairn_expand`, cleanup/stats previews, the briefing resource) are **session-bound** — they return the private project's content only when the session's own working directory is that project. Naming the project as an argument from elsewhere is not enough. Moving content out is always an explicit act: `cairn_promote` and restore-mode `cairn_ingest` both require a `from_private: true` acknowledgment to change a private memory's scope. This is isolation for autonomous agents sharing one memory store — not access control against you: the database file is yours either way.

`cairn_recall` also accepts `scope: "project"` (requires `project`) to return only that project's own memories, excluding globals.

## Hook Reference

| Hook | Event | Matcher | Purpose |
|------|-------|---------|---------|
| session-start | SessionStart | `*` | Inject briefing, detect post-compaction |
| prompt-check | UserPromptSubmit | `*` | Auto-recall, intent classification, corrections, decision detection |
| pitfall-check | PreToolUse | `Write\|Edit\|MultiEdit`, `Bash` | Proactive warnings: pitfalls, decisions, loop detection |
| success-tracker | PostToolUse | `Bash\|Write\|Edit\|MultiEdit` | Track tool chains, detect success patterns |
| plan-bridge | PostToolUse | `ExitPlanMode` | Auto-persist plan mode plans to Cairn DB |
| error-learning | PostToolUseFailure | `Bash\|Write\|Edit\|MultiEdit` | Auto-create pitfalls, error pattern escalation |
| precompact | PreCompact | `*` | Snapshot state, mine decisions from assistant text |
| postcompact | PostCompact | `*` | Record compaction timestamp for reliable session detection |
| subagent-context | SubagentStart | `*` | Inject plan + pitfalls + corrections into subagent prompts |
| stop | Stop | `*` | End-of-turn decision mining from assistant message |
| subagent-stop | SubagentStop | `*` | Capture subagent outcomes as plan step notes |
| stop-failure | StopFailure | `rate_limit\|max_output_tokens\|server_error` | Learn from API errors, create actionable pitfalls |
| file-changed | FileChanged | `*` | Fire file-triggered reminders on file changes |
| session-end | SessionEnd | `*` | Record outcome, protect in-progress steps |
| statusline | StatusLine | n/a | Write context pressure to `~/.claude/cairn-state.json`; display mode, memory count, active plan progress, and reminders |

## MCP Tool Reference

| Tool | Purpose |
|------|---------|
| `cairn_recall` | Retrieve relevant memories by topic |
| `cairn_learn` | Store distilled lessons (pitfall/decision/correction/fact) |
| `cairn_correct` | Fix or invalidate a memory |
| `cairn_forget` | Permanently delete a memory |
| `cairn_strengthen` | Increase confidence in a useful memory |
| `cairn_weaken` | Decrease confidence in a wrong memory |
| `cairn_plan` | Create and manage task plans with steps and decisions |
| `cairn_remind` | Trigger-action reminders ("when X, remind me Y") |
| `cairn_reminder_list` | List active reminders for a project |
| `cairn_reminder_delete` | Deactivate or permanently delete a reminder |
| `cairn_ingest` | Import markdown (v2 `data:` payloads or legacy v1 sections); `mode=learn` (gateway semantics) or `mode=restore` (strict atomic upsert-by-id) |
| `cairn_export` | Export memories as round-trip v2 markdown (lossless canonical-JSON payloads; free-form files on unfiltered exports) |
| `cairn_promote` | Promote project memory to global scope |
| `cairn_stats` | Memory health and statistics |
| `cairn_expand` | Expand compact index briefing IDs into full memory detail |
| `cairn_cleanup` | Bulk cleanup of low-confidence/old memories (with user confirmation via elicitation) |

## MCP Resource Reference

| Resource | URI | Purpose |
|----------|-----|---------|
| `active-plan` | `cairn://plan/{project}/active` | Full plan with all steps, decisions, notes — no token budget |
| `full-briefing` | `cairn://briefing/{project}` | Full briefing with pitfalls, corrections, decisions — no budget constraint |

## Key Design Decisions

- **Hook-first**: Data flows through hooks (passive capture), not through tool calls
- **Confidence scoring**: Every memory has 0-1 confidence; decays continuously via an incremental Ebbinghaus model (v5.2): each maintenance run charges only the effective age accrued since the previous charge (`conf ×= e^(−Δt/S)`, grace-adjusted), so decay depends on wall-clock time, never on how often maintenance runs. Stability S is per-kind (pitfall 60d, fact 30d, user_profile 120d), extended by recall count (spaced repetition) and source trust (corrected ×1.5). Maintenance is rate-gated (12h) as a cost bound. A one-time `scripts/repair-confidence.mjs` (dry-run default, online backup on `--execute`) lifts evidence-backed memories crushed by the pre-v25 compounding-decay bug back above their surfacing gates
- **Recall slowdown**: Each recall slows decay — frequently useful memories persist longer
- **Deduplication**: 0.6 similarity threshold with bigram+unigram overlap prevents duplicate memories
- **Two-stage briefing pipeline** (v2.9.0): Stage 1 uses impact-proportional token allocation — high-effectiveness pitfalls get full rendering (content + why + how_to_apply), low-effectiveness ones are excluded entirely. Stage 2 correction pass recovers high-impact pitfalls dropped during multi-pass reduction as ultra-compact one-liners. Defense-in-depth noise filters (approach quality gate, conversational rejection, section priority ordering). SNR optimized to ~97% across 19 iterative fixes (v4.1.0)
- **Silent success tracking**: No context injection on successful edits (reduces noise)
- **Error learning**: Auto-creates pitfalls from tool failures with pattern classification
- **Common word filtering**: Filters generic bash words from pitfall matching
- **Semantic path matching**: File path concepts extracted for richer pitfall recall (e.g., `oauth_handler.py` → matches `oauth` tags)
- **Semantic search** (v3.0.0): Local embeddings via `@huggingface/transformers` (all-MiniLM-L6-v2, 384-dim). Hybrid search fuses FTS5 keyword results with vector cosine similarity via Reciprocal Rank Fusion (RRF). Falls back to FTS-only when model not loaded.
- **Knowledge graph** (v3.0.0): `memory_edges` table tracks relationships (supersedes, refines, contradicts, caused_by, informs, co_occurred, generalizes). Graph-enhanced recall enriches results with 1-hop neighbors. Recursive CTE traversal supports N-hop exploration.
- **Memory consolidation** (v3.0.0): Affinity-based agglomerative clustering merges similar memories within the same kind and project. Creates `refines` edges, soft-deletes merged members, boosts representative confidence.
- **Code-location anchoring** (v3.0.0): Memories auto-linked to referenced file paths and function names. `recallByAnchor()` enables file-specific pitfall surfacing in pre-tool hooks.
- **Auto-promotion** (v3.0.0): Detects high-impact memories recurring across projects and promotes them to global scope automatically during maintenance.
- **Predictive pre-fetching** (v3.0.0): Co-recall tracking predicts which memories will be needed based on which ones were recalled together in past sessions.
- **Session continuity scoring** (v3.0.0): Tracks recall precision (ratio of recalled memories that led to success) per session for cross-session quality signals.
- **Embedding-enhanced consolidation** (v3.3.0): Consolidation blends embedding cosine similarity (50%) with token overlap (20%) and temporal proximity (30%) when both memories have embeddings. Catches semantically similar but lexically different memories that token-only clustering misses.
- **Auto edge creation** (v3.3.0): Cross-kind `informs` edges auto-created when `cairn_learn` stores a new memory semantically similar (cosine >= 0.6) to an existing memory of a different kind. Co-recall pairs with co_count >= 3 promoted to `co_occurred` edges during maintenance.
- **Quality-gated predictions** (v3.3.0): Co-recall predictions require minCoCount >= 2 (filters single-occurrence noise). Kind-preference: 'task' intent prefers pitfalls/decisions, 'question' prefers facts/decisions.
- **Regex error distillation** (v3.3.0): Pattern-matches common error formats (TypeScript TS####, Python tracebacks, Node module errors, SQLite, Edit old_string failures) into structured one-sentence lessons. Replaces raw error dump in pitfalls. MCP sampling auto-upgrades when available.
- **Memory versioning** (v3.3.0): `memory_versions` table preserves old content when `cairn_correct(update)` is called. Decision evolution is preserved, not overwritten.
- **Quality-adaptive briefing** (v3.3.0): Previous session quality signal adjusts pitfall allocation — "stuck" sessions get +2 pitfalls, "smooth" sessions get -1 (minimum 1). Prevents alert fatigue after productive sessions.
- **Briefing effectiveness tracking** (v3.3.0): Passive measurement of post-compaction recovery — tracks whether first prompt after compaction references briefing files, requests plan state, or proceeds directly. Recorded in hook telemetry for trend analysis.
- **StopFailure hook** (v3.3.0): Learns from API errors (rate_limit, max_output_tokens, server_error). Creates actionable pitfalls for recurring API failures.
- **Impact tracking**: Surface/impact counters measure which memories actually help, enabling data-driven cleanup
- **Auto plan checkpointing**: Success patterns add progress notes to active plan steps
- **Accurate token counting**: Uses `@anthropic-ai/tokenizer` for real BPE token counts
- **FTS stopword filtering**: 60+ stopwords removed from FTS queries to prevent false matches on common words
- **Query-aware re-ranking**: Recall scoring uses token overlap with query text as a relevance factor, not just confidence/recency
- **Auto decision capture**: Prompt-check detects decision language with rationale and auto-encodes as decisions
- **Confidence rebalance**: Manual learns start at 0.65 (above injection threshold), auto-detected at 0.4 (must earn trust)
- **Context fingerprints** (v2.0.0): 3-dimension fingerprints (lang/framework/module) replace flat tag matching. Multi-signal retrieval fuses fingerprint overlap (40%), content FTS (30%), confidence (20%), recency (10%)
- **Meta-goal filtering** (v2.0.0): `isMetaGoal()` prevents short acks and compaction commands from being stored/displayed as goals
- **Error pattern escalation** (v2.1.0): Session-scoped error counting with tiered escalation — 1st injects lesson, 2nd warns, 3rd+ escalates with category-specific positive alternatives (research-informed: Reflexion, SWE-Agent, Renze 2024)
- **Proactive pre-tool warnings** (v2.2.0): Session-aware, file-specific warnings before tool calls — detects recent file failures, Edit→Bash(fail)→Edit loops, rapid re-edits. Surfaces decisions alongside pitfalls. Lowers confidence floor for files with recent errors so fresh pitfalls are immediately visible. Capped at 3 warnings per call (alert fatigue research)
- **Stale memory detection** (v2.3.0): Three-phase git-aware staleness detection on session start — auto-weakens zero-impact pitfalls, detects stale fingerprints via project structure comparison, and weakens memories referencing deleted files via `git diff`
- **Cross-session momentum** (v2.4.0): Computes session quality signal (smooth/productive/rough/stuck) from existing telemetry at session end. Next session's briefing shows quality + task summary so the agent can adjust approach
- **Bookend read** (v2.5.1): Large transcripts (>512KB) read both head (32KB for goal) and tail (512KB for recent state), preventing goal loss on compaction
- **Infrastructure extraction** (v2.6.0): Auto-recall in UserPromptSubmit, decision mining in PreCompact, compliance nudges — reduces dependence on explicit MCP tool calls from ~30% utilization to ~95% passive coverage
- **Plan bridge** (v2.6.0): PostToolUse hook on ExitPlanMode auto-persists Claude Code plan mode plans to Cairn's SQLite DB, bridging ephemeral plans to persistent storage that survives compaction
- **Two-tier compaction detection** (v2.8.0): PostCompact hook writes definitive compaction flag to EditTracker; SessionStart checks Tier 1 (PostCompact signal, 30s window) before falling back to Tier 2 (DB snapshot heuristic, 60s window). Eliminates false negatives in session type inference
- **Subagent context injection** (v2.8.0): SubagentStart hook injects plan state + top pitfalls + corrections into subagent prompts. Subagents no longer start blind — they inherit the session's critical context
- **MCP resources** (v2.8.0): `cairn://plan/{project}/active` and `cairn://briefing/{project}` expose full plan state and briefings without the 500-token budget constraint, enabling richer post-compaction recovery reads
- **Elicitation for bulk operations** (v2.8.0): `cairn_cleanup(execute)` requests user confirmation via MCP elicitation before bulk deletion. Graceful fallback when client doesn't support elicitation
- **Cross-tier decision dedup** (v4.0.1): 40-char normalized prefix signature comparison between T1 (plan/snapshot) and T2 (memory DB) decisions prevents the same decision from appearing in both "Decisions:" and "Prior decisions:" sections
- **Defense-in-depth error filtering** (v4.0.1): Multi-layer false positive rejection in error rendering — `isLikelyErrorOutput()` at capture time rejects source code; render-time filters reject vitest/jest summaries, Unicode symbols, progress bars, success messages, and `dist/` artifacts
- **Superseded decision filtering** (v4.0.1): Decisions linked by `supersedes` edges in the knowledge graph are automatically excluded from briefing, preventing stale architectural choices from competing with their replacements
- **Write gateways** (v4.1.0): `storeDecision()` and `storePitfall()` are thin wrappers over a shared `storeMemory()` gateway with smart merge — source authority (user>confirmed>corrected>learned), confidence max(boosted, incoming), content length preference, tag union, context gap-fill, fingerprint enrichment, embedding backfill
- **Reject-by-default error capture** (v4.1.0): `isLikelyErrorOutput()` rewritten from permissive (accept anything with "error") to strict (accept only known `LEARNABLE_ERROR_PATTERNS`). Eliminates capture-time noise — 215→0 false positive errors per session
- **Dynamic briefing budget** (v4.1.0): Briefing token budget scales with context pressure via `readState()` — STARTUP_MAX:3000 (>50% free), COMPACT_MAX:2000 (25-50%), MINIMAL_MAX:1200 (10-25%), CRITICAL_MAX:600 (<10%). Extra budget primarily benefits Stage 2 correction pass recovery
- **Plan bridge hardening** (v4.1.0): Plan parser rejects file metadata (shebangs, encoding declarations), source code, and comments as plan names. Bridge skips source code file extensions. Prevents cross-project plan contamination
- **Completed decision filtering** (v4.1.0): `isCompletedDecision()` detects historical completion language ("all implemented and verified in vX.Y") and excludes from briefing render
- **Lang-mismatch penalty** (v4.2.0): When query and memory have known but disjoint `lang` dimensions (e.g., `markdown` vs `typescript`), `multiSignalScore()` applies 0.5x penalty — prevents cross-language false positives in pitfall surfacing
- **Doc-file fingerprint skip** (v4.2.0): Documentation files (`.md`, `.txt`, `.rst`, `.adoc`, `.mdx`) skip fuzzy fingerprint recall entirely — only anchor-based recall applies. Eliminates irrelevant pitfalls when editing docs
- **Sentence-level reasoning extraction** (v4.2.0): `extractReasoningState()` rewritten with sentence-level extraction (handles multi-line text), expanded patterns (`probably because`, `still need to understand`, `must investigate`), and resolution detection — hypotheses/questions resolved in later assistant text are automatically excluded
- **SNR v3 trust plan + guardrails** (v5.0.0): `tests/snr-guardrails.test.ts` locks three probes (warm-compact, post-restart startup, cold-start startup) plus an inverse probe asserting 100% recall of known-relevant memories. Each probe seeds the store with relevant + distractor + foreign-project items and asserts the compiled briefing's noise budget against shared constants (`PROBE_SIGNAL_FLOOR`, `COLD_START_NOISE_CAP`). Post-v3 baseline: warm 100% signal, cold 100% signal, 0/5 noise on both project-identity and disjoint-module probes
- **Project-identity token exclusion** (v5.0.0): `deriveProjectIdentityTokens(project)` strips project slug tokens from both sides of the same-project relevance check. Previously a pitfall tagged with top-level area labels (e.g. `['cairn', 'hooks']`) trivially overlapped any `queryFp` containing the project identity; the gate now requires a surviving non-identity token match
- **Always-on guard fallback + cold-start queryFp synthesis** (v5.0.0): `buildBriefingQueryFp` always returns a `ContextFingerprint` (never `undefined`); `renderTier3` and `recoverDroppedPitfalls` use `guard(queryFp ?? BRIEFING_BROAD_FP)` so the cross-project guard runs unconditionally. `meaningfulTokenCount(fp, identityTokens)` strips project-identity + generic-area tokens; when the count falls below `NARROW_OVERLAP_MIN_MEANINGFUL_TOKENS` (2) the same-project gate falls back to the broad fp variant while the cross-project guard keeps the full synthesised fp — so cold briefings aren't starved and unfingerprinted globals stay blocked
- **`isMetaGoal` resume-prose coverage** (v5.0.0): new `resumeProsePatterns` group catches long-form session-resume blurbs (`"this was where you were … ready to proceed"`, `"before we (got|cot) disconnected"`, `"Resume point: … Next: …"`) that short-pattern matchers missed. `buildBriefingQueryFp` filters `initialGoal`, `plan.name`, and in-progress step descriptions through `isMetaGoal` before tokenising, so synthetic resume prose can't leak into `queryFp.module`
- **Three-tier goal rendering: Now / Feature / Project** (v5.0.0): replaces the monolithic "Goal / Previous goal / Project goal" line with a three-tier taxonomy, each tier carrying its own staleness policy. **Now** = session-scoped per-turn task (session-boundary + `isMetaGoal` + branch + carry + shipped gates). **Feature** = branch-scoped work (branch mismatch + completed-step + shipped-by-commit). **Project** = durable branch-spanning intent (plan/user/transcript source, explicit pivot only). Cross-tier Jaccard dedup (`GOAL_TIER_DEDUP_JACCARD` = 0.55) prevents duplication; each tier renders with a compact age suffix (`Now: … (2m ago)`, `Feature: … (branch, 3h ago)`, `Project: … (plan, 8d ago)`). Schema v23 adds `goal_captured_at` + `project_goal_captured_at` to `compaction_snapshots` so the age clock doesn't reset on every compaction
- **Goal ship-detection via `shippedByCommit` gate** (v5.0.0): sticky goals are suppressed when their meaningful tokens (length ≥3, non-stopword) are covered by the union of recent commit-subject tokens at ≥ `GOAL_SHIPPED_COVERAGE` (0.6) — catches goals describing work already landed on the branch. `getGitWorkingState` fetches the last 8 commit subjects via `git log -8 --pretty=%s`. Conservative: requires ≥3 goal tokens and ≥1 recent commit before the gate runs, so trivial/short goals are exempt
- **Prompt-handler goal-kind staleness gate (SNR v3.1)** (v5.0.0): `isGoalMemoryStale(mem, nowMs)` rejects `kind: 'goal'` memories that trip `isMetaGoal` (session-continuity blurbs that sneaked past ingest) or exceed `LIMITS.GOAL_REMINDER_MAX_AGE_HOURS` (72h). Applied at the four prompt-handler recall sites — task-intent pre-flight, Layer 1a broad recall, Layer 1b co-recall prediction, and Layer 1c vector search (both cached and proxy-embedding branches) — so the prompt-handler path gets the same staleness treatment that `evaluateCarriedGoal` already applied in the briefing compiler. Closes the parallel-code-path gap the v3 trust plan didn't cover
- **`recoverDroppedPitfalls` quality-floor parity** (v5.0.0): the correction pass now applies `computeEffectiveness(m) >= LOW_EFFECTIVENESS_THRESHOLD` AND `m.confidence >= CORRECTION_PASS_MIN_CONFIDENCE` after the cross-project + same-project gates, giving recovery the same quality floor as the main briefing. Eliminates a regression path where a low-effectiveness pitfall dropped by `topPitfalls` under budget pressure could be resurrected by the recovery pass

## License

[Elastic License 2.0](LICENSE) — source-available. You may use, copy, modify,
and redistribute Cairn freely, with three limitations: you may not offer it to
third parties as a hosted or managed service, circumvent license-key
functionality, or remove the licensing notices. See [`LICENSE`](LICENSE) for the
full terms.
