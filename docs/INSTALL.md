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

Optional (StatusLine + anything the plugin can't reach):

```bash
cairn init
```

### Claude Code — no plugin

```bash
cairn init
```

Writes the MCP server, hooks, and StatusLine into
`~/.claude/settings.json` (idempotent; your other settings are
preserved, with a backup written first).

### Codex CLI

```bash
codex plugin marketplace add vedtechsolutions/cairn-memory
codex plugin add cairn@cairn      # wires the MCP tools (recall/learn/plan)
cairn init                        # wires the hook set into ~/.codex/hooks.json
```

Then open `codex` once and approve Cairn's hooks when prompted — Codex
reviews new hooks before they run. The approval survives package
updates (hook commands are stable), so it is a one-time step.

The plugin carries only the MCP tools on purpose: Codex re-reviews
plugin-bundled hooks on every plugin update, while hooks wired by
`cairn init` keep their one-time approval.

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
