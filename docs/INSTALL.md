# Installing Cairn

Cairn is one npm package plus per-agent wiring. Every path below starts
with the package; pick the wiring that matches your agent(s).

## 1. Install the package

```bash
npm install -g cairn-memory
```

No C compiler needed — hooks run through a bundled shell relay, and
`cairn build-relay` can compile the faster C relay later if you want it.

## 2. Wire your agent(s)

### Claude Code — plugin (recommended)

```text
/plugin marketplace add vedtechsolutions/cairn-memory
/plugin install cairn@cairn
```

The plugin wires the MCP server and the full hook set (briefings,
pitfall warnings, auto-capture). It is a thin plugin: it finds the
`cairn-memory` package you installed in step 1 and runs that — updating
the package updates the behavior, no plugin reinstall needed.

For the StatusLine (context-pressure tracking, dynamic briefing
budgets — not a plugin surface):

```bash
cairn init --statusline-only
```

Do NOT run a full `cairn init` alongside the plugin — it wires the
same hooks into `~/.claude/settings.json` and every event would fire
twice (two briefings per session, two recalls per prompt). Pick one:
plugin, or `cairn init`.

### Claude Code — no plugin

```bash
cairn init
```

Writes the MCP server, hooks, and StatusLine into
`~/.claude/settings.json` (idempotent; your other settings are
preserved, with a backup written first).

### Codex CLI

```bash
cairn init      # wires the MCP server AND the hook set into ~/.codex
```

Then open `codex` and run `/hooks` to review and trust the Cairn
entries — Codex holds new hooks until you approve them. The approval
survives in-place package updates (the hook commands don't change);
re-review triggers only when the resolved install path itself changes —
e.g. switching Node versions under nvm, or moving the install — and
`cairn doctor` tells you when that has happened.

Marketplace alternative for the MCP tools:

```bash
codex plugin marketplace add vedtechsolutions/cairn-memory
codex plugin add cairn@cairn
```

The plugin carries only the MCP tools on purpose: Codex re-reviews
plugin-bundled hooks on every plugin update, while hooks wired by
`cairn init` keep their one-time approval. If you use both the plugin
and `cairn init`, Codex sees the same MCP server from two sources and
keeps one — harmless, but you only need one of the two.

## 3. Verify

```bash
cairn doctor
```

One health check for everything: Node, SQLite, relay, hooks, database,
socket. It diagnoses; it never mutates.

## Migrating existing memories

Coming from another memory system? One command each, re-runnable:

```bash
cairn import --from claude-mem          # the community claude-mem archive
cairn import --from codex-memories      # Codex native memories (~/.codex/memories)
cairn import --from memory-md --path ./MEMORY.md   # any MEMORY.md
```

Add `--dry-run` to preview. Imports are deduplicated, secret-scrubbed,
and idempotent — re-running never duplicates or inflates anything.
