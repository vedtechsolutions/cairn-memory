# Waykeep

Local-first shared memory for AI coding agents. One persistent memory across sessions AND across agents — Claude Code and Codex share briefings, pitfall warnings, decisions, and auto-learned lessons, with seamless recovery after context compaction.

[![npm version](https://img.shields.io/npm/v/waykeep.svg)](https://www.npmjs.com/package/waykeep)
[![license: Elastic-2.0](https://img.shields.io/badge/license-Elastic--2.0-blue.svg)](LICENSE)
[![node](https://img.shields.io/node/v/waykeep.svg)](https://nodejs.org)
[![CI](https://github.com/vedtechsolutions/waykeep/actions/workflows/ci.yml/badge.svg)](https://github.com/vedtechsolutions/waykeep/actions/workflows/ci.yml)

> **Formerly Cairn.** Published on npm as [`waykeep`](https://www.npmjs.com/package/waykeep) — installs the `waykeep` CLI (the `cairn` bin still works). Existing installs keep everything: your data stays in `~/.cairn` and MCP tool names keep their `cairn_` prefix. Upgrading is `npm uninstall -g cairn-memory && npm install -g waykeep && waykeep init` — the uninstall first, because npm refuses to hand the `cairn` bin from one package name to another; init then re-points hook wiring at the new install location (Codex asks to trust its hook entries once; that's the path move, not new behavior). The old [`cairn-memory`](https://www.npmjs.com/package/cairn-memory) package is deprecated but keeps working until you switch.

## Why

Two problems ruin long agent sessions:

**Context compaction destroys working memory.** After compaction, an agent forgets what it was doing, what it read, what it decided, and what mistakes to avoid.

**Every agent is a memory island.** What Claude learned the hard way, Codex re-learns the hard way — and vice versa.

Waykeep fixes both: hooks passively capture what happens (errors, successes, corrections, decisions, plans, compaction state), MCP tools give agents explicit recall and learning, and everything lands in one local SQLite store with hybrid keyword+semantic search. Codex fails a command once; Claude gets warned before touching the same file. Switch models freely — the memory stays.

## Install

```bash
npm install -g waykeep   # the one runtime (no C compiler needed)
waykeep init                    # wires MCP + hooks + StatusLine for your agents
waykeep doctor                  # health check
```

Then, instead of `waykeep init`, you can wire your agent through its plugin marketplace — this repository is one (the npm package from the first step is still required — **waykeep >= 5.5.0** — the plugins are thin):

```text
# Claude Code
/plugin marketplace add vedtechsolutions/waykeep
/plugin install waykeep@waykeep

# Codex CLI
codex plugin marketplace add vedtechsolutions/waykeep
codex plugin add waykeep@waykeep
waykeep init            # hooks (one-time trust approval at next Codex start)
```

Full guide — plugins, hook trust, multi-agent daemon, from-source: [`docs/INSTALL.md`](docs/INSTALL.md).

## What you get

- **Session briefings** — every session starts with goals, plan state, recent files, decisions, and top pitfalls; after compaction the briefing is rebuilt from the pre-compaction snapshot so the agent resumes instead of restarting. Budget scales with context pressure (600–3000 tokens); when the window is nearly full, Waykeep goes silent rather than spend it.
- **Pitfall warnings before the mistake** — pre-tool hooks surface relevant past failures before Write/Edit/Bash touches the file that caused them.
- **Automatic learning** — tool failures become pitfalls, user corrections become rules, decision language becomes recorded decisions (with the `[dec: …]` sigil for zero-cost capture), successes build patterns. No manual bookkeeping.
- **Plans that survive** — plan-mode plans persist to the store automatically; steps, decisions, and progress notes carry across sessions and compactions.
- **Cross-agent provenance** — every memory records which agent learned it (`origin_client`), so shared memory never becomes anonymous memory.
- **17 MCP tools + 2 resources** for explicit control: recall, learn, correct, plan, remind, export/ingest, promote, stats, cleanup. Truth maintenance (supersession, contradiction flags, decay), context-adaptive modes, and tuning knobs: [`docs/development.md`](docs/development.md).

## Memory types

| Kind | Purpose | Example |
|------|---------|---------|
| `pitfall` | Mistakes to avoid | "Never use raw SQL in Odoo models" |
| `decision` | Architectural choices | "Use authlib over python-social-auth" |
| `correction` | User-specified rules | "Always use snake_case for Python methods" |
| `fact` | Stable knowledge | "DB uses PostgreSQL 15 in production" |
| `pattern` | Distilled wins from smooth sessions | "Two-step refactor approach — tests passed first try" |
| `goal` | Task/project intent for continuity | "Primary memory integration — Phases 3-5" |
| `user_profile` | User role, expertise, preferences (always global) | "User prioritizes quality over speed" |
| `reference` | Pointers to external systems (auto-prefixed `ref:`) | "Linear issue TRK-42: auth token refresh" |

Memories carry 0–1 confidence that grows with proven usefulness and decays with time; recall slows decay, so what keeps helping keeps surfacing. Contradictory claims are flagged for you to resolve — never silently overwritten; superseded versions stay queryable.

## Migrating from other memory systems

One command each, re-runnable — imports are deduplicated, secret-scrubbed, and idempotent:

```bash
waykeep import --from codex-memories                 # ~/.codex/memories (structured MEMORY.md handbook)
waykeep import --from claude-mem                     # ~/.claude-mem archive (live worker safe — snapshot read)
waykeep import --from memory-md --path ./MEMORY.md   # any MEMORY.md (+ auto-memory topic files)
waykeep import --from codex-memories --dry-run       # preview without writing
```

**Manual repo-pack** — `waykeep pack export|import --dir <path> [--project ID | --global]` writes deterministic one-record-per-file observations for sharing lessons through your own channel. It never runs git; keep the directory gitignored unless you mean to share it. The same owner socket also serves a local `/owner/apply` endpoint for bounded incremental restore (see `waykeep doctor` for socket health).


Codex task groups keep their structure: working directories map to project scopes, keywords become tags, failures become pitfalls. Excluded files are excluded **and listed**.

## Private projects

Mark a project private in `~/.cairn/config.json` and its memories never surface anywhere else — not in briefings, injections, subagent context, or recall:

```json
{ "v": 1, "scope": { "privateProjects": ["clientwork-aaaa1111"] } }
```

One rule: a session can neither read nor modify another project's private content. Explicit reads are session-bound (you must be *in* the project), moving content out requires an explicit `from_private: true` acknowledgment, and the file is read live — no restart. This is isolation between autonomous agents sharing a store, not access control against you: the database file is yours either way.

## What is it worth?

```bash
waykeep report            # tokens saved vs. tokens spent, honestly
waykeep report --days=90
```

Gross savings separates **measured** (your agent's own reported compaction savings) from **estimated** (verified pitfall saves × a fixed proxy, clearly labeled). Injected briefings and warnings count as cost. Net = gross − cost, even when negative.

## Hook handlers (wired by `waykeep init` or the Claude plugin)

| Hook | Event | Purpose |
|------|-------|---------|
| session-start | SessionStart | Inject briefing, detect post-compaction |
| prompt-check | UserPromptSubmit | Auto-recall, corrections, decision detection |
| pitfall-check | PreToolUse | Warnings before Write/Edit/Bash |
| success-tracker | PostToolUse | Track tool chains, success patterns |
| plan-bridge | PostToolUse (ExitPlanMode) | Persist plan-mode plans |
| error-learning | PostToolUseFailure | Auto-create pitfalls from failures |
| precompact / postcompact | PreCompact / PostCompact | Snapshot + reliable compaction detection |
| subagent-context / subagent-stop | SubagentStart / SubagentStop | Context in, outcomes out |
| governance-gate + stop / stop-failure | Stop / StopFailure | Advisory gate + decision mining; learn from API errors |
| session-end | SessionEnd | Record outcome, protect in-progress steps |
| statusline | StatusLine | Context pressure → dynamic briefing budgets |

Codex gets the same experience through its own 10-hook set (`waykeep init` wires `~/.codex/hooks.json`; one-time trust approval).

## MCP tools

| Tool | Purpose |
|------|---------|
| `cairn_recall` / `cairn_learn` | Retrieve relevant memories; store distilled lessons |
| `cairn_correct` / `cairn_forget` | Fix, invalidate, or delete a memory |
| `cairn_strengthen` / `cairn_weaken` | Confidence feedback |
| `cairn_plan` | Plans: steps, decisions, notes, completion |
| `cairn_remind` / `cairn_reminder_list` / `cairn_reminder_delete` | Trigger-action reminders |
| `cairn_ingest` / `cairn_export` | Round-trip markdown import/export (learn or strict-restore modes) |
| `cairn_promote` | Project memory → global (private projects require acknowledgment) |
| `cairn_stats` / `cairn_cleanup` | Health, statistics, confirmed bulk cleanup |
| `cairn_expand` | Expand compact briefing IDs into full detail |
| `cairn_governance_override` | Record an explicit override of an advisory governance warning |

Resources: `cairn://plan/{project}/active` and `cairn://briefing/{project}` — full state, no token budget.

## Database

- `~/.cairn/cairn.db` (override: `CAIRN_DB_PATH`) — SQLite WAL + FTS5 + sqlite-vec, schema v32
- Embeddings: 384-dim local (all-MiniLM-L6-v2 by default), hybrid FTS+vector search with RRF; optional cross-encoder rerank (`CAIRN_RERANK=1`)
- Everything is local. Nothing leaves your machine.

## Development

```bash
npm run build && npm test
```

External contributions require signing the [CLA](CLA.md) (a bot prompts on your first PR) and DCO sign-off — see [`CONTRIBUTING.md`](CONTRIBUTING.md). Contributor guide, architecture, benchmarks (LongMemEval), SNR probes, and test-environment reference: [`docs/development.md`](docs/development.md). Multi-agent daemon setup: [`docs/daemon.md`](docs/daemon.md). Memory-tool backend for the Anthropic SDK: [`docs/memory-tool-adapter.md`](docs/memory-tool-adapter.md). Governance gate inspector: [`docs/governance-inspector.md`](docs/governance-inspector.md).

## License

[Elastic License 2.0](LICENSE) — source-available. Use, copy, modify, and redistribute freely; you may not offer Waykeep as a hosted/managed service, circumvent license-key functionality, or remove licensing notices.

The [`waykeep-contract`](packages/contract) types package is [MIT](packages/contract/LICENSE), so adapters and integrations can build against Waykeep without restriction. External contributions require the [CLA](CLA.md).
