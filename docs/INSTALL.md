# Installing Waykeep (formerly Cairn)

Waykeep is one npm package plus per-agent wiring. Every path below starts
with the package; pick the wiring that matches your agent(s).

## 1. Install the package

```bash
npm install -g waykeep
```

> **npm ≥ 11.5 blocks native install scripts by default.** If the
> install warns that scripts were blocked for `better-sqlite3`,
> `onnxruntime-node`, `sharp`, or `protobufjs`, the SQLite addon was
> NOT built and `waykeep` will fail at first use. Re-run with the
> scripts allowed (note: npm's own suggested command omits the
> package name and errors — use this one):
>
> ```bash
> npm install -g waykeep --allow-scripts=better-sqlite3,onnxruntime-node,sharp,protobufjs
> ```
>
> or allow them once for all global installs, then reinstall:
>
> ```bash
> npm config set allow-scripts=better-sqlite3,onnxruntime-node,sharp,protobufjs --location=user
> npm install -g waykeep
> ```
>
> `waykeep doctor` detects the broken-addon state and prints this fix.

Coming from `cairn-memory`? Uninstall it first — npm refuses to hand
the `cairn` bin from one package name to another (`EEXIST` otherwise):

```bash
npm uninstall -g cairn-memory && npm install -g waykeep && waykeep init
```

No C compiler needed — hooks run through a bundled shell relay, and
`waykeep build-relay` can compile the faster C relay later if you want it.

## 2. Wire your agent(s)

Both plugins require **waykeep >= 6.0.0** from step 1 — earlier
versions predate the commands the plugins call.

### Claude Code — plugin (recommended)

```text
/plugin marketplace add vedtechsolutions/waykeep
/plugin install waykeep@waykeep
```

The plugin wires the MCP server and the full hook set (briefings,
pitfall warnings, auto-capture). It is a thin plugin: it finds the
`waykeep` package you installed in step 1 and runs that — updating
the package updates the behavior, no plugin reinstall needed.

For the StatusLine (context-pressure tracking, dynamic briefing
budgets — not a plugin surface):

```bash
waykeep init --statusline-only
```

Do NOT run a full `waykeep init` alongside the plugin — it wires the
same hooks into `~/.claude/settings.json` and every event would fire
twice (two briefings per session, two recalls per prompt). Pick one:
plugin, or `waykeep init`.

Switching an EXISTING `waykeep init` setup to the plugin? The same
command migrates you: `waykeep init --statusline-only` removes Waykeep's
settings-wired hooks and MCP server (your own entries are untouched)
and keeps only the StatusLine.

### Claude Code — no plugin

```bash
waykeep init
```

Writes the MCP server, hooks, and StatusLine into
`~/.claude/settings.json` (idempotent; your other settings are
preserved, with a backup written first).

### Codex CLI

```bash
waykeep init      # wires the MCP server AND the hook set into ~/.codex
```

Then open `codex` and run `/hooks` to review and trust the Waykeep
entries — Codex holds new hooks until you approve them. The approval
survives in-place package updates (the hook commands don't change).
Re-review triggers when the wired commands change: a moved install or
an nvm Node-version switch (new absolute paths), switching relay forms
with `waykeep build-relay`, or a release that changes hook routes.
`waykeep doctor` warns when your hooks point at a missing install OR at
a different install than the one running doctor.

Marketplace alternative for the MCP tools:

```bash
codex plugin marketplace add vedtechsolutions/waykeep
codex plugin add waykeep@waykeep
```

The plugin carries only the MCP tools on purpose: Codex re-reviews
plugin-bundled hooks on every plugin update, while hooks wired by
`waykeep init` keep their one-time approval. If you use both the plugin
and `waykeep init`, Codex sees the same MCP server from two sources and
keeps one — harmless, but you only need one of the two.

## 3. Verify

```bash
waykeep doctor
```

One health check for everything: Node, SQLite, relay, hooks, database,
socket. It diagnoses; it never mutates.

Note for GUI-launched agents: the CODEX plugin's MCP entry runs the
bare `waykeep` command, which must be on the launching app's PATH — if a
GUI-launched Codex cannot find it, start it from a terminal once or
add your npm global bin directory to the desktop environment's PATH.
The CLAUDE plugin needs none of that: its launcher resolves the
install off-PATH (cache, then volta → ~/.local → homebrew →
/usr/local, then the newest nvm version that has waykeep). Neither uses a login
shell — profile output would corrupt the MCP protocol stream.

## Migrating your store from `~/.cairn` to `~/.waykeep`

Upgrading from a legacy Cairn install? Your memories keep working untouched — the
`waykeep` binary transparently keeps reading your legacy `~/.cairn` store until
you migrate it. When you're ready to move to `~/.waykeep`:

```bash
# Stop your agents/daemon first — a running server keeps the old store open.
waykeep migrate --dry-run   # preview: what would be copied, and where
waykeep migrate             # copy ~/.cairn → ~/.waykeep, then restart your agent
```

It COPIES, never moves — your legacy `~/.cairn` is left intact as a rollback
backup — copies the database with SQLite's WAL-safe online backup, verifies it
(integrity + row-count parity) before making `~/.waykeep` authoritative, and
carries your `config.json` privacy settings across. It is idempotent (safe to
re-run). Stop your agents first: the command aborts if it detects the hook daemon
still serving the store, and also aborts if the store changes mid-copy. Restart
your agent afterward so it serves the new store.

**Rolling back:** stop all agents/daemon first — a running process keeps using
`~/.waykeep` until it exits (the store root is chosen once per process), so a
rollback only takes effect on restart. Then delete
`~/.waykeep/waykeep-migrated.json` and restart; authority reverts to the legacy
`~/.cairn` store. Note that `~/.cairn` is the snapshot from migration time — any
memories you added AFTER migrating live only in `~/.waykeep`, so keep `~/.waykeep`
(don't delete it) if you might want them back.

## Migrating existing memories

Coming from another memory system? One command each, re-runnable:

```bash
waykeep import --from claude-mem          # the community claude-mem archive
waykeep import --from codex-memories      # Codex native memories (~/.codex/memories)
waykeep import --from memory-md --path ./MEMORY.md   # any MEMORY.md
```

Add `--dry-run` to preview. Imports are deduplicated, secret-scrubbed,
and idempotent — re-running never duplicates or inflates anything.
