# Changelog

## [Unreleased]

### Added

- Added the sync-envelope module to `waykeep-contract`: the Phase 2 replication wire vocabulary — client commands, canonical server log events, conflict reasons, share states, stable error codes, the op-status query/response, and the entity envelope with versioned hashing and reserved encryption fields. Types and constants only; additive.
- Added schema v32 (team-sync foundations): `author`, `updated_at` (trigger-maintained), and tri-state `share_state` on memories; a tombstone log written whenever a memory is deleted or invalidated (forget audit today, retraction propagation later); and the neutral sync replica tables (entity map, alias log, conflict sets, contributor projection, state store, semantic journal). `migrate-project` now carries all project-keyed sync state through renames.

- Added the semantic-change journal: every semantic memory mutation in a shareable scope (create, merge, correction, retraction, supersession, promote, explicit bulk deletion) records an intent entry in the same transaction — local audit today, the sync worker's feed later. Administrative rescopes never journal; autonomous maintenance (TTL/decay/pruning) journals nothing and can no longer delete sync-bound rows.
- Fixed three journal-atomicity defects and two races found by re-review: anchor repair re-decided as silent local repair (never journals — local-git renames must not push teamwide); session-end consolidation made atomic per cluster; single-record restore owns its transaction; the autonomous bound-row guard now rechecks inside an immediate transaction (check/use race); the v32 heal takes an immediate transaction (concurrent-open SQLITE_BUSY); D13 suppression threads through the public repository facade.
- Extended the journal to every remaining semantic surface (dual-review fold): Memory Tool deletions, edits, and renames; explicit trust changes (`cairn_strengthen`/`cairn_weaken`, terminal weaken now retracts properly); portable restores; consolidation; auto-promotion; and anchor repair. Supersession now journals a caused tombstone (`superseded-by:<id>`) instead of a wire-inexpressible upsert. Autonomous consolidation, auto-promotion, and terminal weakening are barred from sync-bound rows; opted-out shadow rows prune normally again.

- Added the free-core sync-apply engine (§6 M1 transitions): untrusted-by-construction event application — neutralize + scrub + shape-validate unconditionally, id-preserving, version-guarded, tombstone-honoring, non-reinforcing — with the entity map, shadow associations (opted-out rows are matched, never written), offline-twin coexistence + alias collapse, fork-preserve on diverged tombstones, deterministic client-minted near-dup conflict sets, a protocol-invariant halt on canonical-hash collisions, and a durable memory generation bumped per committed batch.

- Added the owner-control RPC (`/owner/apply`, `/owner/health`): a separate served-route registry on the hook socket — never part of hook wiring — applying sync-event batches on a dedicated `busy_timeout=0` connection with batch idempotency, strict pre-buffer and streaming body caps, a stable error taxonomy (VALIDATION / PROTOCOL_HALT / BUSY / TOO_LARGE with retryability), and in-process cache invalidation on commit. Free standalone use: bounded local incremental restore.

### Fixed

- Fixed automatic injection precision (from a live cross-agent evaluation): pitfalls marked RESOLVED and superseded memories are excluded from every automatic context surface; conversational/tasking prompts ("ask/review/evaluate…") can no longer be captured as decisions; proactive warnings are capped at one bounded warning (96 tokens) per correlated turn.
- Fixed `npm publish` leaving a hollowed `dist/` behind (`strip:publish` removed benchmark output that incremental builds never re-emitted, failing three test files until a clean rebuild): a `postpublish` script now restores the full build.

## [5.5.0] - 2026-08-29

### Changed

- Renamed the project: Cairn is now **Waykeep**. The npm package is [`waykeep`](https://www.npmjs.com/package/waykeep) (installs both the `waykeep` bin and the legacy `cairn` alias), the repository is `vedtechsolutions/waykeep` (old URLs redirect), and the contract package is `waykeep-contract`. Nothing about local state changes: data stays in `~/.cairn`, MCP tool names keep their `cairn_` prefix, the MCP server key, hook routes, and `CAIRN_*` environment variables are unchanged. Switching packages is `npm uninstall -g cairn-memory && npm install -g waykeep && waykeep init` — the uninstall first because npm refuses to hand the `cairn` bin between package names; init re-points hook wiring at the new install (Codex re-trusts its hook entries once because the paths move).
- Renamed the marketplace plugins `cairn` → `waykeep` for both agents (install: `/plugin install waykeep@waykeep`, `codex plugin add waykeep@waykeep`); the plugin launchers now prefer the `waykeep` bin and fall back to `cairn`, so a leftover cairn-memory install can never displace the current one.
- Rebranded display surfaces: briefings (`[Waykeep Memory Briefing]`), injection prefixes (`[WAYKEEP]`), the subagent framing line, StatusLine, and CLI messages.
- Renamed the gate-config JSON Schema artifact to `schemas/waykeep-gates.schema.json`; its `$id` now points at `waykeep.dev` (the previous `cairn.dev` was never an owned domain).
- Export files now open with `# Waykeep Export v2` — readers never keyed on the header line, so existing export files import unchanged.

### Added

- Added `waykeep migrate-project <old-project-id>`: carries a project's memories, sessions, plans, and telemetry to the current project id after a git remote rename or repo transfer changed the remote-derived identity (`--dry-run` to preview). Fails closed on privacy: rows of a project marked private are not moved to an id the scope config does not list.
- The system-voice neutralizer now strips forged `[waykeep …]` prefixes from stored memory text as well as `[cairn …]` ones.

### Added

- Added a Contributor License Agreement ([`CLA.md`](CLA.md)) with a CLA-signature gate on pull requests (contributors keep their copyright and grant VEDTECH Solutions relicensing rights); `CONTRIBUTING.md` and the PR template now document the CLA + DCO flow.

## [5.4.0] - 2026-08-29

### Added

- Published `cairn-contract@1.0.0-dev.0` to npm under MIT (LICENSE, README, and repository metadata added) — the standalone integration contract for adapter authors; the `cairn-memory` runtime is unaffected and keeps bundling its own copy.

- Added `cairn import --from codex-memories|claude-mem|memory-md`: one-way, idempotent migration of existing memories through the standard scrubbing/dedup pipeline, with dry-run preview and a reported exclusion list.
- Added marketplace plugins: the repository now serves as a plugin marketplace for both Claude Code (`/plugin marketplace add vedtechsolutions/cairn-memory`) and Codex CLI (`codex plugin marketplace add vedtechsolutions/cairn-memory`). Thin plugins — the `cairn-memory` npm package remains the one runtime; the Claude plugin wires hooks + MCP, the Codex plugin wires MCP (hooks stay with `cairn init` so their one-time trust approval survives updates).
- Added `docs/INSTALL.md` — one install guide covering npm, both plugins, hook trust, and migration imports.

### Removed

- Removed the never-functional `FileChanged` hook from `cairn init`'s wiring: the event's matcher is a literal filename watch list where empty means watch nothing, so the entry had never fired; `cairn init` now also removes the stale entry from existing settings on re-run.

### Changed

- Changed `cairn init` to support `--statusline-only` for marketplace-plugin users (a full init alongside the plugin would fire every hook twice).

- Changed memory dedup to always merge into an exact-content row when one exists (a dedicated indexed lookup, independent of full-text search) — identical content is never merged into a near-duplicate row again.
- Changed merge tag unions to cap growth at the 5-tag limit without ever shrinking a row that already carries more.

- Added `cairn report` — an honest tokens-saved report: gross (client-reported compaction savings + a clearly-labeled estimated impact proxy), injection cost per surface, and net; `--days=N` selects the window.
- Added durable telemetry rollup (schema v30): per-session token aggregates persist past the 7-day telemetry prune (own 1-year retention); disable recording with `{"report":{"rollup":false}}` in the config file or `CAIRN_ROLLUP=0`.

- Added scope controls: projects marked private in `~/.cairn/config.json` (env override `CAIRN_CONFIG_PATH`) never surface in other projects on any surface — briefings, prompt/pitfall injections, subagent context, and recall including graph enrichment.
- Added `from_private` acknowledgment requirement to `cairn_promote` when promoting a memory out of a private project.
- Added `scope: "project"` parameter to `cairn_recall` for project-only results (globals excluded).
- Added session binding for explicit reads of private projects: `cairn_recall`, `cairn_export`, `cairn_expand`, `cairn_plan`, `cairn_reminder_list`, cleanup/stats previews, and the plan/briefing resources return private content only from a session inside that project.
- Added mutation binding for private projects: forget/correct/strengthen/weaken, cleanup execution, and reminder management refuse private targets from other sessions; promote and restore scope changes require running inside the project as well as `from_private: true`.
- Added a warning when the config file is present but invalid or wrong-shaped (a broken privacy setting no longer fails open silently).
- Added `from_private` acknowledgment requirement to restore-mode `cairn_ingest` when a record would change a private memory's project scope.

- Added `cairn-contract`: the integration contract (client identity, hook events, route classification, memory-path grammar, portable round-trip format, client-adapter interfaces) as a zero-dependency types package, bundled into the npm tarball.
- Added a client-neutral `/post-tool` hook route; `/codex-post-tool` remains served as a deprecated alias so existing trusted wiring keeps working.
- Added `cairn init --migrate-routes` to modernize deprecated hook routes explicitly (one re-trust in Codex; unrelated hook trust is preserved).
- Added a doctor check that detects a running daemon left over from a previous install (missing routes or contract-revision drift) and says to restart it.

### Changed

- Re-running `cairn init` now preserves Codex hook trust precisely: merges keep every hook's position, and only hooks whose command actually changed are re-reviewed.
- Client-specific behavior now dispatches through a per-agent adapter registry (capabilities), so adding an agent no longer touches core hook logic.

### Fixed

- Fixed silent PostToolUse capture loss on shell-relay installs when the daemon is down or serving an older route table (direct-node fallback added).
- Fixed `cairn init` wiping trust for a user's own unrelated Codex hooks when Cairn's commands changed.

## [5.3.1] - 2026-08-28

### Changed

- npm package metadata and README now lead with the v5.3 cross-agent story: one shared memory across Claude Code and Codex, per-agent provenance, and the `cairn init` setup path; keywords added for Codex/cross-agent discoverability; stale tool count corrected.

## [5.3.0] - 2026-08-28

### Added — Codex parity step 5: zero-config wiring + per-agent doctor

- **`cairn init` now wires Codex automatically** when `~/.codex` exists: generates `hooks.json` from the install's resolved relay (all ten events, `--client codex`, Codex's 3s SessionEnd cap respected, context limits explicit), merges idempotently with any non-Cairn hooks preserved, and registers the MCP server in `config.toml` via a scoped append — no TOML dependency. Prints exactly what the one-time trust review will show.
- **`cairn doctor` gained a `codex parity` check** — wired / awaiting-trust / not-installed, with trusted-hook counts read from `[hooks.state]` and MCP registration status — and the hook-socket check now says "owner unknown — likely a sandboxed environment" instead of implying the daemon is down when `/proc` is invisible (as observed from Codex's own sandbox).
- README documents the Codex setup, the trust step, and the `codex exec --approve-for-me` requirement for MCP tool calls in scripts.

### Added — Codex parity Slice C: file-aware patches, anchored lessons, briefing framing

- **`apply_patch` is now a first-class edit tool.** A shared patch-envelope parser (`*** Add/Update/Delete File:` headers only, never bodies) feeds Codex patch targets into the same file-level loop Claude's Write/Edit use: pre-edit pitfall warnings, post-success confidence boosts, per-file edit counts, and failure events — verified live with a patch touching a file carrying a known pitfall.
- **Sentence-final filenames now anchor.** Distilled lessons end "… in file.ts. Fix: …", and the anchor extractor's path pattern treated the sentence period as a non-terminator — every such pitfall stored with an empty file anchor and was invisible to file-anchored recall. `.` is now a valid path terminator.
- **Briefings inform, never task.** Non-Claude clients get an explicit framing line ahead of the briefing ("shared memory CONTEXT … not tasking — act only on your own user's instructions") after a live Codex session read the injected plan state and began executing the plan unprompted.

### Added — Codex parity Slice B: auto-capture demux + rollout tailer

- **Codex errors and successes now feed the shared learning loop.** Codex fires PostToolUse with no failure signal in the payload, so a demux route joins the hook's `tool_use_id` against the session's rollout JSONL for ground truth: failed commands route to error-learning (pitfall with codex provenance), completed ones to success-tracker, and a missing record is recorded as outcome-unknown — which can never count as a success. Verified live end-to-end: a failing Codex command became a codex-authored pitfall that a Claude session then warned about.
- **Zero-config capture fallback.** A daemon-side tailer watches `~/.codex/sessions` rollouts and feeds newly appended command records through the same demux when hooks are untrusted or disabled; seen-markers written by the hook path keep it naturally quiescent when hooks are live, with no historical backfill and subagent threads skipped. Disable with `CAIRN_TAILER=0`.
- **Known v1 gap (documented):** code-mode sessions wrap `apply_patch` in a script; when that script fails Codex emits neither a rollout item nor a PostToolUse, so failed code-mode patches are not capturable at this seam.

### Added — Codex parity Slice A: client adapter, briefing, provenance

- **Codex sessions now receive the Cairn session-start briefing and ambient wiring foundation.** The hook relay accepts a `--client <name>` flag (forwarded as an `X-Cairn-Client` header on the daemon socket and as `CAIRN_CLIENT` env on direct-node fallback paths), and a shared client adapter normalizes payload deltas in one place for both transports — declared identity, never sniffed, with declared identity overriding anything the payload asserts. For declared non-Claude clients only, `SessionStart.source` maps onto the `type` field the handlers read, so startup/resume/clear/compact (including post-compaction recovery) behave identically across agents — Claude sessions keep their existing inference-derived session typing, verified byte-identical.
- **Schema v29: per-memory client provenance.** New `memories.origin_client` column (default `claude`, idempotent guarded migration) records which agent authored each memory — stamped at every hook-path write site (decision mining, corrections, pitfalls, patterns, profile/reference capture, across daemon and fallback transports) and on MCP-tool writes from the connecting client's `clientInfo`. This is the seam Phase-2 author attribution builds on.
- **Complete Codex hooks wiring template** at `deploy/codex-hooks.json` — every event wired through the relay from day one so the user's interactive hook-trust review happens exactly once, with later slices activating server-side.
- **PreToolUse warnings are Codex-compatible.** Codex 0.150.1 rejects `permissionDecision: "allow"` from PreToolUse hooks (found live in the first trusted session), so pitfall warnings for Codex emit `additionalContext` alone; Claude keeps the explicit allow it has always sent.
- **Codex-aware guards:** Claude's transcript parser is skipped for Codex sessions (their `transcript_path` is a rollout JSONL — snapshot enrichment degrades to empty instead of mining garbage), and tier-3 sigil nudges are suppressed for Codex sessions where Socratic reflection can never run (no MCP sampling).

## [5.2.0] - 2026-08-28

### Fixed — reliability pass (cross-agent audit)

- **Stable project identity.** Project ids now derive from the normalized `origin` git remote (stable across clones/machines/paths) instead of a filesystem-path hash, with a non-destructive lazy migration of existing memories and a bare-name resolver so `cairn` resolves to the full id. Fixes recall/plan misses and is the prerequisite for team sync.
- **Cross-project recall leak.** A project-specific memory stored without an explicit project no longer silently lands in global scope — `cairn_learn` now defaults an omitted project to the current project (`user_profile`/`correction` stay global; explicit scope is respected). Active recall stays permissive but filters a global whose fingerprint belongs to a different project.
- **Dead-memory pruning.** The store no longer grows without bound. Decay floors a never-recalled memory's confidence at the delete threshold, so it previously sat just above the strict `< threshold` delete forever; a conservative prune now reaps a memory only when it is floored, never recalled, older than 60 days, and not a high-value kind (corrections, user profiles, decisions, and rules are exempt, and `cairn_weaken`-invalidated memories are excluded — only decay-floored rows are ever pruned). The delete is capped per maintenance run and logged to stderr.
- **Plan completion visibility.** Completing a plan with unfinished steps now reports the open-step count (e.g. `completed (warn: 2 of 3 steps were not done)`) instead of silently marking it done.
- **Local-time display.** Human-facing timestamps (`cairn_stats`) can be shown in a local timezone via the `CAIRN_TZ` env var (an IANA zone like `America/Jamaica`); storage stays UTC for sync, and dates are unchanged when `CAIRN_TZ` is unset.

## [5.1.0] - 2026-08-27

### Changed — repository renamed to `cairn`

- **The GitHub repository was renamed from `cairen` to `cairn`** to match the project name. Added the `repository`, `homepage`, and `bugs` fields to `package.json` (pointing at the new URL) and corrected stale references to the old checkout path in comments.

### Added — secret scanner redacts credentials before storage

- **Memory content is scanned for high-confidence secrets before it is stored**, so a credential pasted into a lesson (an error log, a command, a config snippet) never lands in the database and never rides along a later promote/export/sync. `scrubSecrets` runs on every capture path — `cairn_learn`, `cairn_correct` updates, the decision/pitfall gateways, and `cairn_ingest` learn-mode — covering content, the `why`/`how_to_apply` context fields, memory version history, and the derived embedding. It replaces AWS/GitHub/GitLab/Slack/Google/Stripe/npm/OpenAI tokens, PEM and PGP private-key blocks, JWTs, credentials embedded in URLs, `Bearer` tokens, and secret-ish `key=value` assignments with a visible `[REDACTED:<type>]` marker while keeping the surrounding lesson intact. Patterns are tuned for a coding-memory system — `process.env.X` references, function names, and hyphenated identifiers are not mistaken for secrets — and every pattern is linear-time (the private-key body is length-bounded) so an untrusted memory pack cannot stall the server. Free core.

### Changed — leaner published tarball

- **The published npm tarball no longer ships source maps, `.d.ts` declarations, or the `benchmark/` directory** — `prepublishOnly` strips them after the build (`strip:publish`). The package drops from ~820 files / 0.75 MB to ~200 files / 0.44 MB and no longer hands consumers a source-map reconstruction of the original TypeScript; the ELv2 license and the unpublished paid layer remain the protection model. The runtime JavaScript, the `cairn` bin, and the relay source + shell fallback are unaffected. (Local dev builds still emit maps and declarations.)

### Security — fail-closed same-uid verification on the hook socket

- **The hook socket now proves it is owner-only before serving, instead of trusting a best-effort `chmod`.** After creating the `0700` state dir and binding the `0600` socket, the server verifies (via `lstat`) that each is owned by the current uid with no group/other permission bits; if the verification fails — a silently-ignored `chmod` on an exotic mount, or a pre-existing wrong-owned dir — it refuses to serve and hooks fall back to direct-node execution rather than exposing an unauthenticated socket to other local users. The standalone `cairn-daemon` treats an insecure state dir as fatal (exits non-zero so the misconfiguration surfaces) instead of spinning in its claim loop. The state-dir check follows symlinks so a legitimately symlinked `~/.cairn` pointing at an owner-only target stays valid. This closes the same-uid gap left when cross-UID socket sharing was deferred.

### Added — installable without a C compiler; optional compiled relay

- **The package no longer needs a C compiler to install.** The compiled C hook relay is now a performance optimization rather than a hard requirement. The package ships the relay source, the shell relay (`hook-relay.sh` — a complete bash+curl drop-in that covers every hook, including `governance-gate`), and a `files` allowlist so the built `dist/` actually ships (it was gitignored and would otherwise have been excluded from the tarball entirely). `cairn init` writes hook commands against whichever relay is available — the compiled binary when present and executable, otherwise the shell fallback — and `cairn doctor` reports a missing binary as a **warning**, not a failure. **`cairn build-relay`** compiles the fast binary where a C compiler is available, and `prepublishOnly` builds the published tarball.

### Added — `cairn init` client configuration

- **`cairn init` subcommand** writes Cairn's client config, replacing the manual `settings.json` editing the README documents. It resolves this install's absolute paths, generates the canonical Claude Code configuration (the `cairn` MCP server + StatusLine + the full 13-event hook set), and merges it **idempotently** into `~/.claude/settings.json` — the user's other MCP servers, hooks, StatusLine, and settings are preserved, a backup is written to `<path>.cairn-backup`, and re-running produces identical output. `--dry-run` previews without writing; `$CAIRN_CLAUDE_SETTINGS` overrides the target path. Other MCP-capable clients (Cursor, Codex CLI, Gemini CLI, Windsurf) are detected and reported with the MCP command to register, but not auto-edited since their formats differ.

### Added — `cairn doctor` install health check

- **`cairn doctor` subcommand** verifies an install in one command: the Node runtime, the native SQLite stack (better-sqlite3 + sqlite-vec), the compiled hook relay, the embedding-model pin, the database schema version, and the hook socket. It is diagnostic-only — it never creates or migrates the database, binds the socket, or downloads a model — and exits non-zero when a critical check fails (an unpinned embedding model, which the server refuses to boot on, is a failure; a not-yet-cached model or a behind/ahead schema is a warning), so it can gate CI and setup scripts. The `cairn` bin is now a dispatcher; a bare `cairn` (or `cairn serve`) still starts the MCP server. The shared `resolveDbPath` was extracted to a native-free module so doctor inspects exactly the path the server opens.

### Changed — relicensed to Elastic License 2.0

- **License changed from MIT to the Elastic License 2.0** (`Elastic-2.0`): the source-available core may be used, modified, and redistributed, but may not be offered to third parties as a hosted or managed service — the direct legal defense for the forthcoming team-sync product. Added a `LICENSE` file and updated `package.json` and the README. No MIT release was ever published, so no permissive grant is outstanding.

### Security — pre-publication hardening

- **Hook socket and state directory are now owner-only (0700 directory; 0600 socket, PID file, and database)**: the hook socket has no request authentication, so a world-traversable `~/.cairn` (older installs created it at 0755) let any local user connect to it, forge hook events that poison memory, claim its ownership to return attacker-authored text into the model's context, or read the database. `ensureCairnDirSecure()` now tightens the directory before the socket binds, and the socket, PID file, and DB file are created 0600. Cross-UID socket sharing (a root daemon serving non-root clients) is intentionally no longer supported through filesystem perms and needs a future peer-credential design.
- **Raw shell command lines are no longer persisted by default**: `governance_tool_events.raw_command` previously stored the full command line — inline secrets included — in the local unencrypted database, overreaching the documented redaction guarantee. The plaintext is now opt-in via `CAIRN_PERSIST_RAW_COMMAND=1` (local-only forensics, never synced or exported); the redacted argv and a SHA-256 remain for correlation regardless. The README redaction claim was corrected to match.
- **Memory content can no longer impersonate Cairn's system voice**: stored memories originate from untrusted sources (tool output, transcripts, imported packs) and are injected back into the model via briefings and subagent context. A memory whose text began with the `[CAIRN]` marker used for Cairn's own injected lines could read as a genuine directive. A new `neutralizeMemoryText()` strips leading `[CAIRN…]` prefixes and control characters at every render site (briefing tiers and subagent context), auto-captured error lessons are neutralized at distillation so hostile build/test output can't plant a forged directive (H1/H2), and `context.why`/`how_to_apply` are now sanitized on write (M1).
- **Transcript reads resist symlink redirection** (M4): `isSafeTranscriptPath` now canonicalizes the target and the allowed roots and requires real-path containment, and the bookend reads open with `O_NOFOLLOW`, so a symlink planted inside `~/.claude/` can't redirect a read to an arbitrary file.
- **The hook relay no longer trusts `$PATH` for its Node fallback** (M3): when `CAIRN_NODE` names an absolute path it is `execv`'d directly, so a writable directory prepended to an inherited `$PATH` can't substitute a hostile `node`; the relay is also compiled hardened (`_FORTIFY_SOURCE=2`, stack protector, PIE, `-Werror=format-security`) (L2).
- **The context-pressure state file is validated on read** (L1): a forged `cairn-state.json` (e.g. `mode: "critical"` to suppress memory tooling) is rejected in favor of the safe `normal` default.
- **`cairn_ingest` neutralizes untrusted imports** (M5): `learn`-mode ingest (shared memory packs, repo files) now runs imported content through `neutralizeMemoryText`, so a pack can't plant a memory that later impersonates Cairn's system voice. `restore` mode stays a byte-faithful id-preserving round-trip of the user's own export.

### Added — continuous integration

- **CI pipeline (`.github/workflows/ci.yml`)** — the repository previously had no CI. Runs on every push to `main` and every PR: locked install, TypeScript + C-relay build with a relay-executable check, a native-module (better-sqlite3 + sqlite-vec) smoke test, and the full suite (including the SNR guardrails and LongMemEval retrieval regression) across Node 20/22/24, plus a `better-sqlite3` source-build leg and a dependency **audit gate** (`scripts/audit-gate.mjs` + `.github/audit-allowlist.json`) that fails on any unlisted high/critical advisory or an exception past its review-by date.

### Fixed — better-sqlite3 native crash on current Node in CI

- **Upgraded `better-sqlite3` 11.10.0 → 12.11.1** to stop a teardown crash surfaced by the new CI matrix: on the runners' Node (e.g. 24.19.0), the 11.x native `Statement` destructor tripped `node::RemoveEnvironmentCleanupHook`'s `(env) != nullptr` assertion at process exit, aborting the test process after the suite passed. 12.11.1 handles the current cleanup-hook contract and still supports Node 20–26 (the 13.x line drops Node 20, which Cairn's `engines` floor still requires); `sqlite-vec` loads unchanged and the full suite stays green.
- **Fixed a hardcoded developer path in `staleness.test.ts`**: the `getProjectModuleTerms` tests scanned `/opt/cairn`, so they only passed on that exact machine and failed on any other checkout (CI uses `…/cairn`). They now derive the repo root from the test's own location. This failure was previously masked by the better-sqlite3 crash.

### Fixed — deterministic relay round-trip tests under CI load

- **Relay round-trip tests no longer flake under full-suite concurrency**: `governance-gate-relay`, `hook-relay-status`, and `governance-gate-roundtrip` raced the relay's production timeouts (the 400 ms governance watchdog / 3000 ms daemon poll) against a CPU-starved mock socket, intermittently reading empty. The relay's two timeouts are now overridable via `CAIRN_GOVERNANCE_TIMEOUT_MS` / `CAIRN_DAEMON_TIMEOUT_MS` (defaults unchanged), and the correctness tests set generous values while the watchdog-timing test and the p95 SLA benchmark keep the tight defaults; the warm-daemon round-trip also uses the schema-max 1000 ms evaluation budget. Verified green across 14 consecutive full-suite runs.

### Fixed — concurrent agent clients no longer kill each other's Cairn

- **Hook-socket ownership is now a cooperative claim instead of kill-and-steal**: a starting MCP server probes `/health` and shares a live owner's socket rather than SIGTERM-ing the PID-file process and rebinding — previously a second agent client (e.g. Codex starting beside Claude Code) terminated the first client's live MCP server mid-session. Only dead sockets are claimed; write-tool cache invalidations from non-owning servers relay through the new `/bump-memory-version` route.

### Added — standalone hook daemon service

- **`cairn-daemon` standalone entrypoint plus a systemd unit (`deploy/cairn-daemon.service`)** own the shared hook socket permanently, so any number of agent clients share one warm hook pipeline that survives session churn; without it the first client to start still embeds the socket as before.

### Added — W6 Slice C: opt-in non-controlling governance warnings

- **Explicit warn/block policy can now surface a bounded Stop-time warning without controlling completion**: a dedicated synchronous `governance-gate` relay reaches the warm daemon under a 400 ms process watchdog, emits only Claude Code's non-blocking `systemMessage`, deduplicates by exact policy/worktree fingerprint with a five-warning session ceiling, and degrades silently to the unchanged async Slice B advisory path on capability loss or faults. Block intent is recorded but clamps to warn; no hook response contains a `decision` field.
- **User-confirmed temporary overrides are audit-row backed and exactly bound** to project, session, config SHA, worktree digest, rule revisions, gate set, and a maximum 24-hour expiry. The MCP action derives bindings server-side, requires interactive elicitation, writes its authoritative audit row and linked redacted fact atomically, and invalidates mismatches without granting residual authority.

### Added — W6 Slice B Gate 3: advisory shadow evaluation

- **Every Stop now runs bounded shadow governance evaluation without controlling the client**: the async daemon path and standalone fallback record capability observation, evaluate and persist advisory-only verdict telemetry before decision mining, and fail open without emitting verdicts, decisions, or control output.
- **Governed projects receive a bounded SessionStart governance section**: applicable pre-exit rules, capability degradation reasons, and the last shadow result age are rendered as redacted `advisory; not enforced` context within the briefing tier budget.

### Added — W6 Slice A Gate 5: read-only gate inspector and operator documentation

- **`scripts/inspect-gates.mjs` provides a dry-run governance view by construction**: it validates and canonicalizes `.cairn/gates.json`, expands requested paths, displays normalized gates and effective retention, hashes and redacts package-script proposals without executing them, reads optional client capabilities from a query-only in-memory database snapshot, and reports block unavailable when `FileChanged` is missing or unobserved. Text and JSON output label every configured level `diagnostic only — Slice A does not enforce`; exit codes distinguish valid (`0`), validation (`2`), and inspector self-error (`1`) outcomes. Behavioral tests fingerprint project/database/settings state and trap command/network side effects; a test safety barrier refuses the live default store.
- **Operator examples and retention semantics are now explicit**: README and `.cairn/gates.json` document exact commands, parsers, timeouts, skips, retention, and path rules; projects without a config are documented as keying evidence by raw canonical cwd; lifecycle cleanup keys a retired family on its latest-revision age and prunes all family revisions plus linked audit rows together.

### Added — W6 Slice A Gate 4: governance evidence recorder and baselines

- **Hook handlers tee governance evidence after existing business results without changing hook output**: the fail-open recorder assigns `event_seq` and mutation sequence in one `BEGIN IMMEDIATE` transaction, captures exact-match gate runs and deterministic worktree digests, records client capability observations, and returns only internal diagnostics on failure. Ephemeral `outputText` and `toolInput` never enter persisted or logged fields; only normalized/redacted data and SHA-256 digests cross the boundary.
- **Retention and privacy behavior is regression-locked**: evidence ceilings prune only unreferenced tool/gate evidence, lifecycle cleanup preserves explainability until explicit confirmed cleanup, and the barrier-started concurrency suite proves atomic sequencing under contention.

### Added — W6 Slice A Gate 3: hook adapters and pure evidence classifiers

- **Versioned Claude hook adapters and pure classifiers establish an honest evidence boundary**: PostToolUse, PostToolUseFailure, and FileChanged wire shapes normalize without guessed success; exact argv/cwd/environment matching, faithful Bash tokenization, Node-test/exit-only result parsing, and conservative mutation classification are covered by adversarial tests. Spoofed or shell-composite commands do not match legitimate gate forms.

### Added — W6 Slice A Gate 2: versioned gate configuration contract

- **Versioned `.cairn/gates.json` validation and normalization are deterministic and bounded**: the canonical Zod contract and checked-in JSON Schema enforce the sole config location, project/cwd containment, duplicate-key and unknown-key rejection, bounded commands/aliases/path rules/retention, exact catch-all requirements for block intent, and canonical SHA-256 hashing. Package scripts remain untrusted proposals and are never executed during config discovery; every future enforcement label remains effectively diagnostic in Slice A.

### Added — W6 Slice A Gate 1: schema v28 and governance rule foundation

- **Schema v28 adds the isolated governance persistence surface**: an atomic v27 parent-table rebuild extends the memory CHECK with `rule`, preserves every v27 column/row plus FTS, triggers, indexes, and all foreign-key children, creates the four dedicated governance tables, and updates `schema_version` last. Foreign keys are disabled only outside the rebuild transaction and restored in `finally`; injected failures after the parent swap and after governance DDL prove full rollback to the byte-observable v27 schema with child rows intact and `foreign_keys=ON`.
- **Rules are policy-only, user-confirmed, immutable revisions** through `GovernanceRuleRepository`: exact-project/phase reads, explicit supersede/disable/retire lifecycle, and a required audit row share one immediate transaction. `rule` is intentionally absent from `LEARNABLE_KINDS` and generic create/update/delete, confidence feedback/decay/expiry, recall/briefing/graph enrichment, embedding backfill, stats/StatusLine, repair, memory-tool listings, and export/restore surfaces. No MCP command, automatic creation, hook behavior, or enforcement output is introduced.

### Added — W8–W11 operational-gap workstreams (supervisor findings, docs only)

- Four gaps observed live on 2026-08-25 recorded as design-first roadmap workstreams: **W8 store-health observability** (the store sat floor-compressed for a month with all tests green and the designed repair unexecuted — degradation must surface as an advisory briefing/StatusLine line, not wait to be found), **W9 impact-signal broadening + review-cohort triage** (stack-specific success/error patterns and impact-less kinds strand memories at the floor; the repair's 282-memory review cohort has no triage workflow; exposure-≠-impact constraint preserved), **W10 explicit-channel resilience** (a server restart silently severs `cairn_*` MCP tools for running sessions while hooks continue — needs detection, advisory, and restart sequencing; reconnect may be client-constrained), and **W11 cross-project recall scoping** (global-scope memories crowd project queries; scoping changes benchmark-gated via the W1 harness plus a new pollution fixture, under W3's parameter locks). All four are design-first; no implementation authorized.

### Changed — MCP SDK v1.30.0 lockfile refresh and protocol canary

- **`@modelcontextprotocol/sdk` now resolves to 1.30.0 in the lockfile** while the existing `package.json` range remains `^1.12.1`. A public-surface canary imports `LATEST_PROTOCOL_VERSION` and `SUPPORTED_PROTOCOL_VERSIONS` from `@modelcontextprotocol/sdk/types.js` and locks Cairn's intentional handshake-era posture: latest `2025-11-25`, at least one supported initialize-era version, and no advertised `2026-07-28` support. The separate SDK-v2/stateless-protocol migration remains gated by the W7 spike report.

### Fixed — test harness could pass with zero discovered tests

- **`npm test` now fails when zero tests run** (`scripts/run-tests.mjs`): the previous bare `node --test <glob>` exited 0 when the glob matched nothing (missing build, moved directory, typo), so a broken invocation passed CI silently. The wrapper discovers `dist/tests/**/*.test.js` itself (no shell-glob dependency), fails on zero discovered files, and — fail-closed belt — fails when the TAP plan is absent or reports zero tests. It also strips the inherited `NODE_TEST_CONTEXT` so a nested runner cannot silently "skip running files" (a real zero-test mode the belt caught during development). Guard regressions in `tests/run-tests-guard.test.ts`.

### Changed — roadmap assumptions updated per Codex direction (docs only, 2026-08-25)

- **W4-A2 auto-memory posture DECIDED** (`docs/plans/2026-08-25-w4a2-auto-memory-interop.md`): consent-gated disable of native auto memory plus a one-time stable import is approved, with local-project settings as the safe default, disable-before-snapshot ordering, idempotent/retryable import, and effective-directory resolution. Export/bidirectional stay shelved behind a documented-write-contract trigger. Implementation remains a separately reviewed change.
- **W7 MCP 2026-07-28 spike COMPLETE** (`docs/plans/2026-08-25-mcp-2026-07-28-spike-report.md`): NO-GO on immediate SDK-v2 migration. Audit corrected the initial exposure count (two sampling sites, one cleanup elicitation, ambient context-mode state), selected deterministic nudge fallback for out-of-band Stop reflection, and requires fail-closed MRTR for cleanup. The bounded follow-up landed separately at `42be1f3`: SDK v1.30.0 lockfile resolution plus a public handshake-era protocol canary; modern SDK-v2 migration remains gated.
- **Contextual-eval design v4 APPROVED for evaluation tooling/execution** (`docs/plans/2026-07-22-contextual-embed-production-eval.md`): frozen queries carry provenance records (query source, client, model, runtime, native-auto-memory and persisted-reasoning status); results are reported per provenance stratum with seeded-bootstrap 95% CIs (≥10-query support floor, descriptive below it) while the pre-registered gate stays singular — no multiplicity added; and a claim/non-claim scope section distinguishes Cairn retrieval ranking quality from native persisted-reasoning/auto-memory value, with a support-gated `native_auto_memory: disabled` sensitivity slice. Production wiring remains gated on a pass and a separately reviewed change.
- **W6 governance design REVIEWED; Slice A plan ACCEPTED (2026-08-25)** (`docs/plans/2026-08-25-w6-governance-architect-design.md`, `docs/plans/2026-08-25-w6-slice-a-plan.md`): the four reviewer decisions make `rule` policy-only with override summaries stored as linked `fact` memories, accept 30-day evidence and until-cleanup audit/rule retention ceilings, make block unavailable without FileChanged, and limit the initial client matrix to Claude Code. The Slice A plan outlines schema v28, a versioned hook adapter/evidence recorder, `.cairn/gates.json` schema/validation, a read-only inspector, and one-to-one §14/§15 test mapping. Documentation only; no migration, hook-settings, evaluator, or production enforcement code is authorized.
- Roadmap remaining queue updated: Slice A implementation authorization decision → optional nomic-256 full run → eventual v5.1.0 tag-push decision.

### Fixed — pitfall hook crashed on every Bash command with recall candidates

- **`passesSameProjectRelevance` crashed on Bash tool calls** (observed live 2026-08-25: every matching Bash command failed with `TypeError: Cannot read properties of undefined (reading 'length')` through BOTH the embedded daemon (HTTP 500 → bad-status) and the direct-node fallback, so no pitfall warnings surfaced for those calls). Bash calls have no file path: the handler's `filePath` is `undefined`, not `null` — `filePaths[0]` is inferred as plain `string` without `noUncheckedIndexedAccess`, so the dishonest `PitfallPassCtx.filePath: string` typechecked all the way into a guard that only checked `!== null`. The gate now treats `undefined` and `null` identically ("no file"), the ctx type is honest (`string | undefined`), and the handler annotates the lookup explicitly. Regressions: handler-level Bash reproduction (red against the pre-fix build with the exact live TypeError) plus unit parity (`undefined` ≡ `null` verdicts across memory shapes).

### Fixed — hook-relay truncated oversized hook inputs into unparseable JSON

- **Hook payloads larger than the relay's 256 KB stdin buffer now stream to the direct-node fallback intact** (observed live 2026-08-25: a ~260 KB PostToolUse payload failed success-tracker with `SyntaxError: Unterminated string in JSON` on both delivery paths — the socket body AND the buffered fallback fed the same truncated bytes). The relay detects buffer-full-before-EOF, logs `input-overflow-stream`, skips the socket entirely (its `Content-Length` body would be guaranteed-unparseable), and the fallback pump now relays the buffered prefix plus the unread remainder of stdin chunk-by-chunk to the child — single-armed poll source per round, so a child flooding stdout cannot deadlock the pump. Regression: 500 KB+ payload delivered byte-exact through the real binary; small inputs keep the plain buffered path.

### Changed — W2 gate product decisions recorded; contextual-eval design v3 (docs only)

- **Reranker default flip REJECTED on current hardware** (product decision 2026-07-30): the 150 ms p50 latency budget is retained and the measured representative p50 is 0.84–1.19 s. This rejects only the default flip — `CAIRN_RERANK=1` (jina-turbo-v1, the W2 quality leader with minilm) remains a supported opt-in.
- **Contextual-eval judging method decided: hand labeling, no LLM judge** (product decision 2026-07-30). The canonical design doc (`docs/plans/2026-07-22-contextual-embed-production-eval.md`) is amended to v3 (review corrections incorporated): arms a/b/c defined as the identical production hybrid stack (rerank off) differing ONLY in document embedding text, with the embedding model/artifact manifest, vector, lexical/RRF, corpus-filter, and query-set configuration frozen and sha256-pinned BEFORE any arm retrieval, pool construction, pilot, or labeling (the independent lexical run is pool-only); the shared deterministic contextual-text builder (fingerprint field order, normalization/dedup/term ordering, token-budget/truncation) is an evaluation PRECONDITION used verbatim by any later production wiring (identity tagging/backfill stay post-pass); blinded 3-point rubric with edge rules and a seeded-randomized lock-enforced two-phase workflow; preregistered graded NDCG@10 (gain 2^g−1, log2 discount, judged-pool IDCG, zero-relevance queries excluded and counted) with explicit ≥1 binarization for precision@5/pooled recall; canonical-label rules (the ordinary phase-2 judgment from the FINAL labeling run whose phase-2 reliability passed, superseded by that run's final adjudication row when present; reliability duplicates and superseded/failed runs excluded from all retrieval metrics); per-phase ordinal reliability floor on the 0/1/2 grades (10% blind duplicates compared against the original UNADJUDICATED rows within the same labeling run — adjudicated grades never feed reliability; exact ordinal agreement ≥ 0.75 AND linear-weighted κ ≥ 0.6 on phase-2 grades; floor failure starts a new append-only labeling run with a new `labeling_run_id` and revised rubric version, prior runs kept as audit history only; binarized agreement secondary only); judgment rows carry `labeling_run_id` and the frozen `config_sha256`; second-judge variant constrained to explicit owner authorization, local-only viewing, no artifact transfer; estimated volume ~2,900–4,100 presentations ≈ 12–23 h ≈ 6–9 bounded sittings with a 5-query pilot re-estimate. Raw corpus/queries/judgments stay local (`~/.cairn/benchmarks/contextual-eval/`, outside the repo) and gitignored — design UNAPPROVED, implementation blocked.
- Roadmap and W4 as-built decision records updated consistently. Remaining queue: (1) contextual-eval v3 design approval; (2) W6 governance design document; (3) optional nomic-256 full run.

### Changed — roadmap/status documentation reconciliation (docs only)

- Roadmap and W4 as-built records reconciled with post-review reality: artifact-manifest enforcement recorded as CLOSED at `2cf6f90`; the contextual-embed production eval is NOT approved — its design doc remains DRAFT v2 pending a judging-method decision (hand labeling vs LLM judge); the W6 governance design document is restored to the remaining-work queue. Current queue recorded in the roadmap: contextual-eval design approval + judging-method decision → reranker latency product decision → W6 governance design doc → optional nomic-256 full run.

### Added — production artifact-manifest enforcement (W2 flip-precondition gate closed)

- **Production model loads now verify provenance** (`src/utils/artifact-verification.ts` + `src/utils/verified-loader.ts`): both the embedding and reranker pipelines load (a clean cache legitimately downloads), then stream-verify the COMPLETE cached package (config/tokenizer/tokenizer_config/ONNX) against the registry's sha256 manifest before ever serving. The two failure classes are distinct: TRANSIENT download/load failures of a *pinned* model retry and degrade gracefully at runtime (FTS-only embeddings, labeled RRF rerank fallback); CONFIGURATION and PROVENANCE failures are permanent — an unpinned or unknown model is refused, and a missing-file/hash-mismatch verification failure poisons the loader for the process with a one-time diagnostic. Enforcement no longer lives only in benchmark runs: production following floating `main` was the recorded flip precondition, now closed.
- **Unpinned registered models fail the MCP server synchronously at startup** (`src/mcp/server.ts`): the embedding config — and the reranker config when `CAIRN_RERANK=1` — is resolved and `assertManifestPinned` runs BEFORE `openDatabase()`, warmup, model import, or any other side effect; the server exits 1 with the manifest error instead of continuing in silent FTS-only mode. The reranker loader additionally asserts the pin before importing `@huggingface/transformers` (matching the embedding loader), so the "an unpinned registration never downloads" invariant survives even if registry typing or startup wiring regresses.
- **Embedding registry pinned** (`EMBEDDING_MODELS[].artifacts`): complete-package manifests for `minilm-l6` (the default) and both nomic variants (shared package, identical pins), computed from the exact cached bytes the W2 benchmarks ran against. `embeddinggemma-300m` is deliberately unpinned (never benchmarked — no trusted bytes) and now REFUSES to load in production before any download starts; the same rule applies to any future unpinned registration.
- The reranker's `verifyArtifacts` is now a label-binding over the shared implementation (benchmark runner unchanged); loader retry/poison semantics are unit-tested via the shared factory, the unpinned-model refusal is proven in a subprocess against the real module (before the transformers import — no network touched), the real server binary is proven to exit 1 on `CAIRN_EMBEDDING_MODEL=embeddinggemma-300m` with the manifest error and no database file created, and an environment-gated suite verifies the checked-in pins against the locally cached benchmarked packages for all four pinned models.

### Added — memory-tool adapter documentation and final W4 validation (roadmap W4 close-out)

- `docs/memory-tool-adapter.md`: the as-built adapter contract — quick start via `betaMemoryTool(createMemoryToolHandlers(...))`, virtual-filesystem layout and ownership, CAS tokens and the §5 edit grammar, command guarantees (transactions, raw-row existence, frozen paging, caps), round-trip v2 learn/restore, SDK contract and upgrade policy, module map.
- README: memory-tool backend section (`### 6.`) and updated `cairn_ingest`/`cairn_export` tool descriptions.
- `docs/plans/2026-07-22-w4-as-built.md`: final W4 validation record — delivered slices, design-checklist cross-check, documented limitations (plan.md read-only, no directory renames, restore ≠ backup), and carried items: the pre-existing flaky `tests/hook-relay-status.test.ts` (intermittent single failure under full parallel runs, passes in isolation and on reruns — stabilization item), plus the four unchanged W2 gates.

### Added — adapter-level frozen-paging regressions across ranking changes (roadmap W4 §7)

- Test-only slice completing the §11 paging plan at the ADAPTER surface: an out-of-band ranking change between pages (a decay/feedback-style write that bypasses the handler cache) must never duplicate or omit a record — pages serve ONE frozen rendering, proven through `MemoryCommandHandlers.view` and again through `betaMemoryTool` `view_range` pages; an expired freeze (5-minute TTL, injectable clock) falls back statelessly with the visible `[fresh rendering …]` notice and the NEW ranking; a successful mutation unfreezes so post-commit pages see the edit.

### Added — round-trip format v2 and strict restore mode (roadmap W4 §6)

- **Format v2** (`src/memory-tool/round-trip.ts`, pure): each exported section pairs a human heading with ONE line of canonical JSON (recursively sorted keys) — delimiter-safe and lossless for multiline context, `##`/`data:`-bearing content, fenced bodies, and full fingerprint arrays. Free-form files export as `## File:` sections. The portable contract is the ENUMERATED twelve fields (id, kind, content, confidence, source, tags, context, fingerprint, project, expires_at, anchor, created_at); revision, telemetry, embeddings, graph edges, and inactive/superseded/task_state records are out of scope by design — into an EMPTY target, revision starts at 1 and telemetry is zeroed; on ID overwrite, portable fields are replaced and the embedding cleared while existing telemetry remains, revision advances through the semantic trigger, and existing graph edges stay untouched.
- **`cairn_ingest` gains `mode`**: `learn` (default — current gateway semantics: dedup, merge, confidence boost, conflict detection) vs `restore` (strict upsert-by-FULL-id via `repo.restore`: no merge, no boosts, no conflict detection, id-preserving, reactivates the row, and CLEARS `embedding`/`embedding_model` on overwrite so the backfill worker re-embeds the restored content). Restore mode is whole-document atomic: parser errors, v1 sections, missing ids, duplicate record ids, and duplicate file paths all reject BEFORE any mutation, then every record and file write runs in ONE immediate transaction — any constraint, path, or cap failure rolls the whole document back with `isError`, and the session cache bumps only after commit. v1 documents still parse with unchanged semantics and diagnostics in learn mode (backward compatible); a malformed v2 payload is a per-section error, never silently reparsed as v1.
- **File restores respect the VFS boundary**: every imported file path routes through the memory-tool router and must be an EXACT canonical free-form path — root, directories, materialized/read-only files (facts.md, plan.md, …), traversal (raw or encoded), and noncanonical spellings reject at parse AND at write.
- **`cairn_export` emits v2**: active rows only (`invalidated = 0 AND superseded_by IS NULL`, never task_state), deterministic order (kind, confidence DESC, id); free-form files ride along ONLY on fully unfiltered exports (no project, kind, or min_confidence filter); file restores go through the adapter's 64KiB/256-file/16MiB caps. Export is a fidelity boundary: every candidate record validates through the SAME gate the parser applies on import (a document the export emits ALWAYS reparses cleanly — invariant-tested), so corrupt stored fields — unparseable JSON, NULL/out-of-range confidence, NULL source, empty content — fail the export naming the record id and field, never silently coerced or dropped (the SQL confidence predicate applies only under an explicit min_confidence filter). Fingerprints require own `lang`/`framework`/`module` facets (each an array of strings, `Object.hasOwn`-checked; typed future facets allowed) — a `{}` or partial fingerprint used to parse and then crash `fingerprintOverlap`.
- Tests: export→restore field-exact equality into an empty store across all eight learnable kinds with a hostile corpus; learn-vs-restore divergence (same content: learn merges/boosts, restore reproduces); end-to-end tool round trip through the MCP harness; scope/strictness/validation coverage.

### Added — memory-tool command handlers: six commands over the live store (roadmap W4)

- **`MemoryCommandHandlers`** (`src/memory-tool/command-handlers.ts`, with `block-parser`, `cas`, `gateway-planner`, `record-updater`, `free-form-store`, `listings`, `view-renderer`, `active-rows`, `token-codes` as separate ≤300-line modules): view/create/str_replace/insert/delete/rename per the frozen v3.1 design. Every mutating command — free-form included — runs ONE immediate write transaction covering its reads, validation, and writes; the render cache is invalidated only after a successful commit; every error path leaves the database byte-identical (snapshot-diff tests including induced failures at the final statement of both materialized and free-form transactions).
- **Strict §5 block grammar** (`parseBlocks`): tokened `- [kind:id@rev] content:` and token-less create blocks, fixed-order why/how/tags one-line-JSON continuations, null=clear vs omission=preserve, fail-closed on any deviation, `confidence:` rejected as system-managed.
- **Stateless CAS with canonical verification** (`resolveAndCheck`/`verifyOldBlocks`): exact-scope prefix resolution with ambiguity/wrong-kind/no-match/stale-revision errors; one stale token in a mixed edit rolls the whole edit back; every old_str block must equal its canonical rendered form verbatim (collision-extended prefix included) — a token alone never authorizes replacing unseen content; duplicate record identities in old_str or new_str are rejected.
- **Existence from RAW active rows** (`active-rows`): create/delete/rename/listings decide file existence from exact-scope SQL rows, not successful domain mapping — corrupt-but-active rows keep their file existing, listed, wholly movable, and deletable.
- **Scope isolation**: directory deletion matches free-form paths with LIKE-escaped literals (base64url project segments legitimately contain `_`), invalidates ONLY VFS-owned kinds (`vfsOwnedKinds` — unmapped `task_state` records are invisible to the tool and never mutated; a task-state-only directory stays nonexistent and untouched), and the active-plan rejection check runs inside the delete transaction; `p-4KC_` vs `p-4KCA` sibling-project regression included.
- **Canonical cache keys**: materialized renderings cache and invalidate under one canonical path spelling, so aliases (`//`, re-encodings) can never serve a stale frozen view.
- **Shared create planner** (`executeCreatePlan`): findSimilar preflight and insert in the SAME transaction — duplicates rejected, would-be supersessions rolled back, contradictions allowed as non-destructive edges. Gateway errors carry marker ids out of the transaction and the handler renders the collision-extended canonical CAS token only AFTER the outer rollback — reported prefixes and revisions always describe the restored store, never transient in-transaction state; a block duplicating OR superseding another NEW block in the same command gets a dedicated tokenless error (its twin will not exist after rollback), and a post-rollback token target that cannot be re-read yields a safe view-and-retry error — never a raw unusable identity.
- **Check/write races closed**: insert's existence, rendering, and insert_line validation moved inside the immediate write transaction (lock-boundary regression proves the first observable act is taking the write lock); lowercase-only canonical UUIDs in the materializer (an uppercase id would render a token the §5 lowercase-hex grammar can never parse back — such rows are unrenderable, fail closed).
- **One contract error table** (`errors.ts`): every SDK-visible message is built by the `ERR` table; no contract message text lives in any other module.
- **Free-form files**: 64KiB/256-file/16MiB caps enforced in-transaction (overwrites counted by delta), contract str_replace/insert/rename/delete semantics.
- **Views**: contract line numbering (6-wide right-aligned, tab), `view_range` validation that rejects ends beyond EOF (only `-1` is open-ended), 16,000-char truncation at a whole line — zero content lines when even the first exceeds the cap — root/directory listings with rendered sizes (plan-only projects included), and read-only token-less plan.md rendering backed by PlanRepository.
- **SDK contract (§9–10)**: `@anthropic-ai/sdk` exact-pinned devDependency (0.113.0); `sdk-adapter` exposes locally-typed `betaMemoryTool` handlers (zero runtime SDK dependency); `sdk-canary` fails the normal tsc build on handler-shape drift; behavioral layer (a) drives every command through `betaMemoryTool().run()` with success AND error coverage for all six commands, layer (b) proves the SDK-visible `is_error` tool_result through the PUBLIC runner with a fake client — the single `Error: ` prefix comes from the runner, never our thrown messages.

- **`memories.revision`** incremented by a DATABASE TRIGGER over the explicit rendered-semantic column list (content, kind, project, tags, confidence, source, context, anchor, invalidated, expires_at, superseded_by, superseded_at) — never by caller discipline, since decay/repair/maintenance/hooks/feedback/consolidation all write outside the repository layer (tested: a decay confidence write and a truth-maintenance supersession both bump it). Embeddings and telemetry are excluded. The design is pragma-independent: the trigger's inner update mentions only `revision`, which appears in no trigger's `UPDATE OF` list, verified under BOTH `recursive_triggers` settings.
- **`memories_au` narrowed to `AFTER UPDATE OF content, tags`** (fresh schema AND migration drop-and-recreate): the old broad trigger rebuilt FTS on every column write and would have been re-fired by the revision trigger's internal update. Tested: exactly one FTS refresh for content changes, zero for revision-only writes.
- **`memory_files`** for W4 free-form memory-tool files: path PK, `CHECK(length(CAST(content AS BLOB)) <= 65536)` — a true BYTE cap (SQLite `length(TEXT)` counts characters; verified with multibyte content) — and its own content-triggered revision.
- Exact-scope partial index `idx_memories_project_kind_active`; `revision` added to the Memory/MemoryRow types; existing rows backfill to revision 1; induced-failure migration test proves atomic rollback leaves the schema version unchanged with no partial v27 objects. Shared `stripV27Surface` test helper keeps the older rewind-style migration tests (v24/v25 shapes) exercising the real upgrade path.

### Changed — scoring unification: shared primitives, two documented profiles (roadmap W3)

- **Characterization first**: `tests/scoring-characterization.test.ts` locks the full drift set with hand-computed goldens (never generated from the implementation) — `computeScore`, `multiSignalScore` (lang-mismatch penalty, precision cap, unproven proxy), the hook-side `scoreRelevance`, recency buckets, tokenOverlap anchors, and the entire parameter surface. All passed against the pre-refactor code on first run.
- **Shared signal primitives** (`src/utils/scoring-primitives.ts`): `recencyBucketBoost` (previously one duplicated implementation — scoring.ts plus a byte-for-byte copy in relevance.ts — consumed by three paths), `recencyBucketNormalized` (the surfacing form's 0–1 signal), and `precisionRatio` (impact/surface with the conservative unproven proxy). Both scoring families and the hook path now consume the same implementations.
- **Authoritative weight profiles** (`SCORING_PROFILES` in constants): `RECALL` (source weights — aliasing `SOURCE_WEIGHT`, which decay also consumes — plus relevance floor/gain), `SURFACING.MULTI_SIGNAL` (signal weights aliasing `FINGERPRINT.WEIGHTS`, lang penalty, unproven proxy, `MIN_SCORE` injection floor), and `SURFACING.TAG_RELEVANCE` (the hook path's formerly-inline extension/path/command/message weights plus the strict-`>` injection threshold). All scoring consumers — both families, the tag path, and the pitfall-hook `MIN_SCORE` filters — read through the profiles; values unchanged, aliases verified by identity in the characterization suite, which also locks the tag weights, `MIN_SCORE`, and threshold-boundary behavior. The multiplicative (recall) vs additive (surfacing) FORMS are retained per the roadmap decision — convergence/tuning is a later, benchmark-driven exercise that must consciously edit the characterization goldens.
- **Behavior-preserving, proven**: every characterization golden unchanged post-refactor; full suite green.

### Changed — W2 closed with an explicit defaults matrix (roadmap)

- **Defaults unchanged**: embedder `minilm-l6`, reranker off, contextual embed off, schema v26. Opt-in surface: `CAIRN_EMBEDDING_MODEL=nomic-v1.5` / `nomic-v1.5-256` (new 256-dim MRL variant — smoke-equivalent quality to 512, 1 KB stored vectors, faster vector scans per the committed probe (p50 9.2/10.0/13.5 ms for 256/384/512 @5k rows, `docs/benchmarks/nomic-256-evidence/`); full-run quality unproven) and `CAIRN_RERANK=1` (jina-turbo — the W2 quality leader with minilm, +0.0525 official session recall_all@5). Nomic decision: **opt-in challenger** — real quality gain, but minilm+rerank beats it outright and the resource cost is unjustified for a default.
- **Contextual embeddings**: LongMemEval stratified smoke recorded as a SAFETY verdict only (non-inferior on a context-free corpus; no efficacy claim). Production-memory evaluation design doc v2 (`docs/plans/2026-07-22-contextual-embed-production-eval.md`) incorporates review corrections: generic retrieval comparator (no LongMemEval namespace reuse), arm/ranking-blind judging over complete memory records with a secondary content-only label, ≥20-deep pooling plus an independent lexical retriever with pooled-recall naming and NDCG/precision primary, exhaustive 8-way field-presence bitmask over relevant documents, a pre-registered gate (c−b NDCG@10 ≥ +0.02, CI excluding 0, per-stratum floor, two-strike insufficient-movers → UNPROVEN), and local-only raw artifacts (hashes/aggregates/tooling committed). Hardening: `runBenchmark` itself rejects `contextualEmbed` without hybrid embeddings; the embed-text helper trims and omits whitespace-only segments; deterministic fingerprint flattening + token-budget design is a recorded precondition for production wiring.
- Open gates carried out of W2: reranker latency product decision (representative p50 0.84–1.19 s vs 150 ms budget), production artifact-manifest enforcement, contextual production eval, optional nomic-256 full run.

### Added — reranker A/B: minilm+jina-turbo is the W2 quality leader (roadmap W2 slice 4)

- **Full 500-question A/B** (`docs/benchmarks/w2-rerank-ab-report.md`, report `longmemeval-s-hybrid-rerank.{json,md}`): official_compat session recall_all@5 **0.8473 → 0.8998** (+0.0525; sign test p=0.0001; bootstrap 95% CI [+0.0286, +0.0788]); turn recall_all@10 +0.074; no aggregate metric regressed. Gains land on the weakest abilities (multi-session +0.099, temporal-reasoning +0.063). minilm+rerank beats nomic-without-rerank (0.8783) — the budget-compliant configuration wins. Remains opt-in (`CAIRN_RERANK=1`).
- **nomic+rerank stopped at smoke** (tightened three-arm gate): identical to minilm+rerank on session recall in every ability bucket (all ties, Δ 0.0000) and slightly regressive vs nomic alone — the ~5 h full run was not spent; the 405 MB combined configuration cannot become default regardless.
- **Continuity**: the fresh baseline leg reproduced the recorded `d4a6881` baseline exactly (aggregates + all 500 rows) — third consecutive exact reproduction.

### Added — cross-encoder reranker behind CAIRN_RERANK=1 (roadmap W2 slice 4)

- **Reranker service** (`src/utils/reranker.ts`, registry in `src/constants/reranker-models.ts`): opt-in via `CAIRN_RERANK=1` (unset/`0` off; any other value fails closed), model via `CAIRN_RERANK_MODEL`. Default is **jina-reranker-v1-turbo-en**, reversing the roadmap's bge-reranker-base pick on smoke evidence: bge (278M params) measured +681 MB incremental RSS and 1132 ms p50 per complete 20-pair rerank on this hardware — 2.3× the entire combined RSS budget and 7.5× the 150 ms latency budget — while jina-turbo (38M) measured 158 ms p50 / 278 ms p95 and won the ordering sanity probe; bge stays registered for faster machines. Invalid configuration fails closed at server startup (process-level tests); transient model-load failure degrades explicitly — `cairn_recall` returns RRF order with a visible `[rerank unavailable]` label, and the benchmark runner refuses to score a mislabeled run.
- **Pipeline**: RRF top-20 (`RERANK.CANDIDATES`) fetched read-only → cross-encoder → top max_results, with recall side effects applied to the direct top-k ids only (`markRecalled` — supplemental graph neighbors are excluded) so side-effect semantics match the non-rerank path; deterministic tie handling (score desc, original RRF rank asc); behavior byte-identical when disabled (identity-rerank equivalence test). MCP-server only — hooks never load models.
- **Benchmark support**: `run.mjs --rerank` (hybrid variant only) reranks the RRF window per question, labels the variant `hybrid+rerank`, and records reranker model/dtype in report meta. The comparator now compares `variant` + `embedded` instead of `variant_label` — the label carries the experimental variable (e.g. `+rerank`), so comparing it would block exactly the A/Bs the tool exists for, while fallback-vs-real and fts-vs-hybrid still fail closed.
- **Resource measurement corrected and checked in** (`scripts/longmemeval/resource-probe.mjs`, raw samples in `docs/benchmarks/resource-probe/`): the initial session-only probe used short synthetic candidates and a mislabeled p95 index — its "158 ms p50" is superseded. The corrected probe (40 iterations/process, nearest-rank quantiles, raw samples retained, five fresh processes + four ONNX thread settings with a byte-identical score-preservation check) shows representative retrieved windows — length-spanning real turn chunks, a pessimistic upper bound under batch padding — at **p50 ≈ 0.84–1.19 s vs the ≤150 ms budget**, unfixable by score-preserving thread tuning. **Latency gate recorded FAILED/OPEN**; minilm+rerank stays opt-in; any budget revision is a separate product decision, and a smaller window or model change requires a fresh quality A/B. Combined RSS: warm steady-state 204–242 MB (pass with margin), cold first-download 294 MB (narrow pass, 6 MB under); nomic-v1.5 + jina-turbo 405 MB (over budget). Additional flip precondition (review): production loading still follows floating `main` — the artifact manifest is enforced only by benchmark runs, which is acceptable while reranking is experimental, but production must enforce the manifest (or pin a revision) before any default flip.
- **Fail-closed inference output** (slice-4 review): raw cross-encoder output must be exactly one finite logit per candidate — short, long, NaN, or infinite logit vectors become an explicitly logged null fallback in production and a thrown error in the benchmark. The benchmark additionally enforces that a rerank result is an exact one-to-one permutation of its candidate window (omission, duplication, and foreign-id injection all throw; regression-tested).
- **Production path proven at the MCP level** via an injectable reranker seam on `registerMemoryTools`: real registration + in-memory transport tests cover successful reorder, visible `[rerank unavailable]` fallback labeling, and recall-count changes for the direct top-k ids only (pool candidates and supplemental graph neighbors are never marked — matching non-rerank behavior). Reranked output labels its number honestly as `rrf_score` (the order is the cross-encoder's; the score is still the RRF fusion score).
- **Immutable reranker provenance — complete package, not just weights**: the registry pins a sha256 manifest of every file the pipeline loads (`config.json`, `tokenizer.json`, `tokenizer_config.json`, `onnx/model_quantized.onnx`) for both models — tokenizer/config drift alters rankings just as surely as weight drift, and both `from_pretrained` calls otherwise track floating `main`. `run.mjs --rerank` loads first (a clean cache legitimately downloads), then stream-verifies the cached package against the manifest (streaming so the hash never inflates the recorded peak RSS) and refuses to score on any missing file or mismatch, recording the verified hashes in report meta; markdown reports render the reranker identity line with the weight hash. Tested: match, non-weight drift (tokenizer mismatch with intact weights — exactly the gap a weights-only pin leaves), and missing-cache.

### Added — nomic-v1.5 challenger A/B on LongMemEval-S (roadmap W2 slice 3)

- **Quality gate PASS** (`docs/benchmarks/w2-nomic-ab-report.md`, challenger report `longmemeval-s-hybrid-nomic-v1.5.{json,md}`): paired same-commit comparison — official_compat session recall_all@5 0.8473 → 0.8783, turn ndcg_any@5 +0.069; per-question 21 improved / 9 regressed / 440 unchanged; gains concentrated on the weakest abilities (multi-session +0.074, temporal-reasoning +0.032). Paired uncertainty: exact two-sided sign test p=0.0241 (official_compat) / p=0.0428 (unique_session); seeded paired-bootstrap 95% CIs exclude zero in both namespaces. Stratified 24-question smoke gated the full run.
- **Checked-in comparison tooling** (`scripts/longmemeval/compare.mjs`): paired deltas, per-ability movers, exact sign test, and a deterministic seeded-bootstrap CI (mulberry32(42), 10,000 resamples — byte-identical output across runs), so recorded A/B conclusions reproduce from the checked-in report JSONs with one command instead of session-only tooling. Fails closed (exit 1) on any comparability violation — mismatched dataset identity/sha256, variant, corpus mode, ks, pool/candidate depth, duplicate or missing question ids, question-type drift, or one-sided namespace scoring — and on harness-commit mismatch unless `--allow-harness-mismatch` is passed for a continuity-proven pair. Seven process-level contract tests spawn the real script and assert nonzero exits.
- **Continuity check**: the minilm-l6 baseline re-run at the current commit reproduced the recorded `d4a6881` baseline exactly (identical aggregates, 0/500 per-question rows differ) — registry/roles/v26 changes are behaviorally inert for the default model and the embed pipeline is machine-deterministic.
- **Resource gate remains open**: nomic-v1.5 measures +289 MB incremental RSS (controlled probe; warm p50 53 ms vs 9 ms for minilm) against the ≤300 MB combined embedder+reranker budget — default flip deferred to the reranker slice's combined measurement; quality and resource gates are independent.

### Added — schema v26: per-row embedding-model isolation (roadmap W2 slice 2)

- **`embedding_model` column** on `memories` and `context_vectors`; migration backfills every pre-v26 vector as `'minilm-l6'` (hardcoded to what those vectors actually are, not the default-model constant). Every embedding write stamps the active model: `create`, `storeEmbedding`, the smart-merge embedding gap-fill, the context-vector worker, and benchmark corpus ingestion.
- **Every vector read filters on the active model**: `vectorSearch` (both sqlite-vec and JS-fallback branches), `searchByProxyEmbedding` (the proxy's own vector must match), consolidation's pairwise cosine map, and the hook-side cached context-vector query — cross-model cosine is meaningless and mixed dims make `vec_distance_cosine` a per-row runtime error.
- **Model switch = staged re-embed**: `memoriesWithoutEmbeddings` now also selects rows whose `embedding_model` differs from the active model, so the existing backfill worker re-embeds the store in batches after a switch while FTS+RRF carry retrieval; the context-vector worker discards (never blends) a stale-model rolling vector. The context-vector worker moved to its own module (`src/mcp/context-vector-worker.ts`) with an injectable embed seam for tests.
- **Challenger gate lifted**: `CAIRN_EMBEDDING_MODEL=nomic-v1.5` / `embeddinggemma-300m` now resolve (prefixes verified against the official model cards); unknown keys still fail closed. Covered by a twelve-test isolation suite: write stamping, read filtering, re-embed candidacy, v25→v26 migration backfill, stale-vector discard, and the dedup/merge/edge paths below.
- **Dedup, merge, and edge paths isolated too** (isolation review): `findSimilar`'s cosine-dedup leg compares only active-model candidates — identical vector bytes under a foreign tag can no longer collapse lexically dissimilar memories into one row; `getEmbedding` returns null for foreign-model rows, so cross-kind edge creation never compares cross-model; the smart-merge "has embedding" presence check now means *has an active-model embedding*, so a foreign-model row accepts and re-stamps an incoming active vector instead of silently keeping stale bytes. `MemoryRow` carries `embedding_model`; `cairn_stats` embedding coverage counts active-model vectors only and reports the stale-model re-embed backlog separately.

### Added — embedding model registry (roadmap W2 slice 1)

- **Model registry** (`src/constants/embedding-models.ts`): `minilm-l6` (current default), `nomic-v1.5` (first challenger — q8, 512 MRL dims, asymmetric `search_query:`/`search_document:` prefixes), `embeddinggemma-300m` (second — q4, 768-dim). Selected via `CAIRN_EMBEDDING_MODEL`; unknown keys fail closed listing valid keys, and challenger selection fails closed until schema v26 per-row model tagging lands (mixing dims in `vec_distance_cosine` is a per-row runtime error). Challenger prefix strings are re-verified against the model card before each first A/B run.
- **Role-aware embedding API**: `embed(text, role)` applies the model's asymmetric task prefix (documents by default; `embedQuery` for the retrieval side — recall queries and rolling context-vector prompts are query-side, backfill/create/correct are document-side). MRL outputs follow the official Nomic procedure — layer-normalize the FULL native vector, then truncate, then L2-normalize (shift-invariance regression-tested; plain truncate+renormalize produces wrong vectors). Raw model output must match the registry's native dim exactly or the embed fails closed — a short vector can never be stored silently. No behavior change for the symmetric default model; `EMBEDDING_DIM`/`EMBEDDING_MODEL` constants replaced by `getEmbeddingModelConfig()`, and benchmark report metadata now reads model/dim/dtype from the active config instead of hardcoding.
- **Server fails closed on embedding misconfiguration**: the MCP server resolves the model config synchronously at startup and exits 1 on unknown or v26-gated keys — previously the lazy warmup swallowed the rejection (correct for transient download failures) and left a misconfigured server silently alive in FTS-only mode. Covered by real server-process spawn tests.
- **Benchmark embedFn is role-explicit**: the LongMemEval runner requires `(text, role)` — corpus documents embed as `document`, each benchmark question as `query` (spy-based regression test). A role-less fn embedded the query as a document, which would have silently invalidated challenger A/B results.

### Changed — LongMemEval harness upstream compatibility (Codex harness review, 5 blockers)

- **Two explicit metric namespaces.** `official_compat` literally mirrors the upstream evaluator (`eval_utils.py`): DCG leaves positions 1–2 undiscounted (a single evidence item at rank 2 scores NDCG 1.0, vs 0.6309 under the standard formula), ideal DCG sorts the full corpus relevance vector, and session metrics from turn retrieval use the upstream turn2session expansion (strip turn suffix, expand the ranked prefix until it covers k unique sessions, score at that effective k with repeated session gains). `unique_session` keeps the cleaner deduplicated standard metrics. Turn-level NDCG added to both. Reports label every number with its namespace; only `official_compat` is comparable with published results.
- **Duplicate corpus occurrences preserved in official_compat ranking** (second harness review): the runner previously deduplicated ranked turns by doc id before official scoring, silently inflating official metrics — upstream keeps every corpus copy of a duplicated session, so identical filler duplicates consume top-k ranking positions. Ranked and corpus lists are now occurrence-preserving for `official_compat` (turn doc ids still collide by design, matching upstream), while split chunks of a single turn occurrence still collapse to one entry and `unique_session` remains fully deduplicated. Regression-tested with a duplicated filler session that pushes evidence out of official top-5 while unique_session still recalls it.
- **Official corpus protocol.** Default corpus mode is `user-only` (upstream's flat turn index ingests user turns only — assistant paraphrases inflate session recall); `all-roles` remains as a separately-labeled Cairn experiment. Turn doc ids use 1-indexed ORIGINAL turn positions (`sessionId_3`), matching upstream enumeration over the full session.
- **Verbatim-corpus guarantee.** `skipDedup` alone was insufficient: truth-maintenance conflict detection still ran on ingest and superseded the older of two opposing version claims, hiding it from search (reproduced: one of two semver facts retired). New internal `skipConflictDetection` flag on the create path; benchmark ingestion sets both. Regression test asserts opposing version claims both remain active and retrievable.
- **Fail-closed dataset parsing.** Locale-dependent `Date.parse` + silent fallback dates replaced with an explicit `Date.UTC` parser for the official format that throws on malformed or impossible dates (fallbacks would corrupt temporal-reasoning evaluation). Validation now also enforces: string ids/dates, `answer_session_ids ⊆ haystack`, `role ∈ {user, assistant}`, strictly-boolean `has_answer` when present (null fails closed — a full scan of the manifest-pinned file found 235,790 absent / 896 true / 10,064 false / **zero null** labels; an earlier claim that the real data used null was wrong and has been reverted), unique question ids. Duplicate session ids within one haystack are accepted **only with byte-identical turn content** — the real data has 13 such cases, all non-answer filler replayed at different dates (each occurrence keeps its own date); a duplicate id with conflicting content fails closed. Non-abstention questions with no user-side evidence labels are excluded from `official_compat` (upstream renames those sessions out of the answer space) and counted separately as `skipped_no_evidence_turns` — distinct from abstention skips.
- **Auditable reports.** Meta now records dataset revision + sha256 (from the manifest), harness commit + package version, corpus mode, variant label, pool size, hybrid candidate depth, and embedding model/dim/dtype when enabled; per-question rows carry evidence session/turn ids and ranked session/turn ids (capped at max k). Markdown reports render the per-ability (question type) session-recall breakdown for both namespaces, matching the JSON `by_type` block. Hybrid without embeddings is labeled `hybrid-fts-fallback` (it is NOT equivalent to the fts runner — recallHybrid caps candidates at 20/leg below the 50 pool). `splitTurn` hard-slices single over-limit tokens; `dbPathFor` removed from the runner (`:memory:` only — strongest isolation).

### Added — LongMemEval retrieval harness scaffolding (roadmap W1, three slices)

- **Read-only retrieval option** (`RecallOptions.readOnly`, slice 1): `recall()` and `recallHybrid()` skip the `last_recalled`/`recall_count` side effects when set, so benchmark queries are order-independent and never perturb spaced-repetition state. Default (mutating) behavior unchanged and regression-tested; internal-only — not exposed through any MCP tool schema.
- **Benchmark harness** (`src/benchmark/longmemeval/`, slices 2–3): dataset validation with official-format date parsing; per-question isolated stores (`:memory:` default) with a hard guard refusing any path under `~/.cairn`; turn-preserving ingestion (one memory per turn, oversized turns split on whitespace, dedup bypassed via internal `skipDedup`, `created_at` backdated to session dates via internal `createdAt`, uniform confidence in retrieval-only mode); official `recall_all@k` / `ndcg_any@k` metrics plus turn-level recall from `has_answer` labels, abstention items excluded from retrieval scoring; `fts` and `hybrid` runners (hybrid degrades to FTS-backed ranking without embeddings — the CI path); deterministic reports (stable key order, no timestamps unless `--timestamp`, byte-identical across runs).
- **CI fixture, not downloads**: `scripts/longmemeval/fixture/harness-fixture.json` is a checked-in synthetic six-question fixture in the official format (five ability types + one abstention, a designed-miss question, duplicate turns proving dedup bypass). The harness test suite runs entirely on it — no network, no model downloads. The designed-miss question immediately caught a real bug: session/role tags written to the FTS-indexed `tags` column made every user-role memory match any question containing "the user"; benchmark metadata now lives only in in-memory maps, never in searchable columns.
- **Pinned dataset manifest**: `scripts/longmemeval/manifest.json` pins `xiaowu0162/longmemeval-cleaned` at revision `98d7416c…` with per-file sha256 (HF LFS oids) and byte sizes; `fetch.mjs` downloads at the pinned revision to `~/.cairn/benchmarks/longmemeval/` and refuses to install on checksum mismatch. Lifecycle replay remains a distinct future mode.
- **Recorded LongMemEval-S baselines** (`docs/benchmarks/longmemeval-s-{fts,hybrid}.{json,md}`, 500 questions, user-only corpus, single harness commit, aggregates independently recomputed from per-question rows before recording): official_compat session recall_all@5 — fts 0.7279, hybrid+embeddings 0.8473 (@10: 0.8544 / 0.9499); turn recall_all@5 — 0.4749 / 0.6110. 419 officially scored (30 abstention + 51 no-evidence-turn skips). README documents the exact regeneration commands.

### Fixed — compounding confidence decay (roadmap W0, Codex-reviewed)

- **Decay is now a function of wall-clock time, not invocation count.** The old `applyConfidenceDecay` recomputed retention from *total* age and multiplied it into the already-decayed confidence on every fresh session start, with no rate limiter — compounding per session until the store collapsed onto the confidence floors (live store before fix: pitfall avg conf 0.15, fact 0.18, pattern 0.10). The new incremental model (`src/db/decay.ts`) charges only the effective age accrued since the previous charge (`Δ = effectiveAge(now) − effectiveAge(last_decayed_at)`, `conf ×= e^(−Δ/S)`); consecutive charges telescope, so 30 daily runs equal one 30-day run (property-tested to 1e-9).
- **Grace period is subtractive, not a cliff**: an 8-day-old memory is charged 1 day, not 8 (old code skipped 6 days then charged the entire elapsed age).
- **Source trust moved out of the per-update factor into stability** (`S ×= SOURCE_WEIGHT`): per Codex review, `min(1, sourceMult × e^(−Δt/S))` freezes decay entirely for trusted sources under frequent small increments; folding provenance into S preserves slower decay for corrected/user memories without breaking telescoping.
- **Atomic updates with sub-threshold carry-forward**: confidence and `last_decayed_at` update in one statement; deltas under `MIN_CHARGE_DAYS` (0.01d) skip *without* advancing the epoch, so no accrued age is ever dropped (the old 0.001 "meaningful change" gate silently discarded small decrements).
- **Maintenance rate gate**: `runMaintenance` no-ops within 12h (`maintenance_meta.last_run_at`) unless `force: true` — a sweep-cost bound, not a correctness mechanism, since decay is now time-idempotent. Injectable clock (`nowMs`) throughout for deterministic tests.
- **Schema v25**: adds `memories.last_decayed_at` (backfilled to migration time so the first post-migration run charges nothing against the already-over-decayed store) and the `maintenance_meta` table. ISO-UTC timestamps in migration SQL.
- **TTL expiration decoupled from the rate gate** (Codex integration review): `expireTtlMemories` runs on every `runMaintenance` entry *before* the gate — tag recall, vector search, and briefings don't filter `expires_at`, so a gated sweep previously left expired memories surfaceable for up to 12h (reproduced via `recallByTags`/`topPitfalls`). Regression-tested: gated runs still expire, and expired memories are unreachable via tag and briefing recall. TTL comparison uses the injected clock (ISO, exact for tool-validated timestamps).
- **Repair TOCTOU + backup ordering hardened** (Codex integration review): dry-run now opens a read-only raw connection (cannot migrate; "no confidence changes" wording — the review CSV is intentional output); `--execute` takes its online backup from the read-only connection *before* the writable open migrates, so a v24 operator gets a pre-migration backup; analysis re-runs post-backup; `executeRepair` re-checks `invalidated`/`superseded_by`/`confidence < target` at write time with a monotone `MAX(confidence, target)` lift — a concurrently boosted memory (analyzed 0.15, raised 0.90) is no longer lowered to its 0.70 target.

### Added — explicit confidence repair (roadmap W0)

- `scripts/repair-confidence.mjs` + `src/db/repair.ts`: operator-driven repair for stores crushed by the pre-v25 bug. Dry-run by default; `--execute` takes an online backup (SQLite backup API) first. Lifts only evidence-backed memories (impact_count > 0, user/corrected provenance, or a `led_to_success` session record) to just above their surfacing gates (pitfall 0.70, fact 0.60 — `REPAIR.TARGETS`), and resets their decay epoch so the next sweep doesn't re-crush them. Recall count alone is not evidence (per Codex live-store check: the recall_count 2–4 cohort had zero positive impacts) — recalled-but-never-impactful memories are exported to a review CSV, never auto-lifted. Original values are documented as unrecoverable; repair restores surfaceability, not history.

### Removed — dead and redundant decay paths (roadmap W0)

- Removed `decayStaleConfidence` (the second, stacked multiplicative decay on the session-start path) — its temporal purpose is owned by the corrected Ebbinghaus model; surfaced-but-unused feedback remains owned by `applyPrecisionFeedback`.
- Removed dead constants `DECAY_FACTOR_BY_KIND`, `CONFIDENCE.DECAY_FACTOR`, `CONFIDENCE.DECAY_INTERVAL_DAYS`, `CONFIDENCE.STALE_DECAY_30_DAYS/90_DAYS`, `RECALL_DECAY_SLOWDOWN` (zero call sites), and the false "falls back to kind-specific fixed factors" docstring.
- Suite: 1522/1522 green, 0 skipped (1487/1487 at v5.1.0; new decay/repair property suites added, dead-path tests removed).

### Added — improvement roadmap (validated, pending Codex review)

- Added `docs/plans/2026-07-20-improvement-roadmap.md`: validated P0–P2 implementation plan covering decay-correctness fix (W0), LongMemEval harness (W1), embedding/reranker modernization (W2), scoring unification (W3), Anthropic memory-tool backend adapter (W4), bi-temporal validity (W5), and governance layer design (W6). Validation upgraded the decay finding to a live correctness bug: `applyConfidenceDecay` compounds per session start (no rate gate, non-idempotent retention math) and stacks with `decayStaleConfidence` on the same session-start path — live store confidences are collapsed onto the decay floors (pitfall avg 0.15, fact 0.18). Also identified dead decay constants (`DECAY_FACTOR_BY_KIND`, `CONFIDENCE.DECAY_FACTOR`, `CONFIDENCE.DECAY_INTERVAL_DAYS`) and a stale README schema-version reference (23 → actual 24).

### Added — contradiction detection + truth-decay (facts & decisions)

- **Supersession (semver version drift only).** A new fact/decision giving a newer semver value for the same subject ("node 18.1" → "20.3") retires the older claim: the old row gets a `superseded_by` pointer, is excluded from active recall/briefings, but is kept queryable (bitemporal, non-destructive). This is the only path that hides a memory, so it is gated to the unambiguous case — a lower-authority observation never silently retires a higher-authority claim; it's flagged for review instead. **Bare-number metric divergence** (error codes, ports, key sizes, counts — a number that may be a distinct entity, not a changed magnitude) is treated as a standing contradiction (flag both), never a supersession — a real-data adversarial sweep showed metric-drift auto-supersede false-fired ~50% on short high-overlap facts.
- **Standing contradiction.** Two memories that genuinely disagree (negation-parity flip or antonym flip on a shared subject) now create a `contradicts` edge — previously a defined-but-unused relation. Both sides keep surfacing and the session briefing lists them under "Conflicting memories — verify & resolve"; nothing is auto-resolved.
- **Structural, not similarity-based detection.** Conflict requires topical relatedness AND an explicit opposition signal, with a scope-guard veto so "use X for A" vs "avoid X for B" (same tokens, different scope) is correctly treated as coexisting, not conflicting. Dedup no longer merges opposed pairs, so a conflict can't be silently absorbed as a duplicate.
- **Truth-decay flagging.** Facts and decisions carrying time-sensitive claims (versions, counts, dates, "currently") render with a "(verify — Nd old)" marker once past a claim-type half-life (version 90d / metric 120d / date 180d / volatile 60d — erring long, calibrated against real data to a ~3% flag rate). Read-time and non-destructive — stale-but-possibly-true information is flagged, never dropped or deleted. Durable facts, user preferences, and finalized/historical records ("migration completed, 580 partners") never decay.
- **Value-drift is context-aware.** Supersession compares a value against others sharing a context word ("775 tests" vs "1487 tests"), and vetoes unit mismatches ("30 seconds" vs "30000 milliseconds" is the same value, not a drift) — calibrated from an adversarial false-positive sweep over the real store (0 false positives on 277 real fact/decision memories).
- **Shared suppression policy.** Superseded memories and `contradicts` edges are both excluded from graph-neighbor expansion, so a suppressed memory can't leak back into recall as a "related" neighbor.
- **Observability.** Writes report `supersededId` / `contradictionWith` / `conflictSignal`; `MemoryRepository.getContradictions(project)` exposes unresolved pairs; the staleness classifier returns a structured reason. Schema v24 adds `superseded_by` + `superseded_at`.

### Changed (2026-07-09 refactor — god-file splits + dedup)

- Split the five audit-flagged god files (all 2–5x over the 300-line standard) into cohesive modules behind facades that re-export the full public surface — zero consumer/test import changes, zero behavior change: `briefing-compiler.ts` (1,559→121) → `briefing/`, `memory-repository.ts` (1,380→299) → `memory-repository/`, `transcript-parser.ts` (1,045→22) → `transcript/`, `pitfall-handler.ts` (700→198) → `pitfall/`, `prompt-handler.ts` (674→188) → `prompt/`.
- Extracted duplicated goal-continuity/project-goal resolution from `precompact.ts` and `session-end.ts` into shared `goal-resolver.ts` (the two copies had a history of silent column-list drift disabling briefing staleness gates).
- Unified the duplicated error-learning pipeline: the standalone entry script (339 lines) is now a 59-line wrapper delegating to the daemon handler, which owns the single implementation.
- Unified the drifted `BRANCH_NOISE` sets (pitfall-handler + briefing-compiler) into a shared `branchSignalTokens()`.
- The SNR banned-pattern lint now globs the whole `briefing/` module directory, not just the facade, so a reintroduced guard-bypass ternary in any renderer is still caught.

### Fixed (2026-07-09 audit remainder — A1, M1–M4, M11, H6 race)

- Briefings no longer vary with the checkout directory's name (A1): the cwd-basename query-fingerprint signal is injectable via `CAIRN_QUERY_CWD` and its tokens are excluded from the narrow-policy count — a last-resort signal may help relevance but can never narrow the SNR gate and drop same-project memories.
- Graph traversal cycle guard is delimiter-exact (M11): an id that was a substring of an earlier id in the visited path (e.g. `no` after `node`) was silently skipped by the old substring LIKE.
- Transcript parsing trusts only `~/.claude/` in production (M3); the world-writable OS tmpdir is admitted solely under the test-env flag `CAIRN_ALLOW_TMP_TRANSCRIPTS`.
- Session-end's resume cursor is at most one turn stale instead of up to 60s (M2): the `/stop` route flushes dirty trackers every turn. Session-end's dynamic imports (including one inside a loop) are now static.
- Closed the standalone-hook lost-update race on the edit tracker (H6 residual): new lock-wrapped `updateTracker(fn)` (mkdir lock, 2s stale-steal, 250ms fail-open) wraps every standalone load→mutate→save.
- `hook-relay.sh` buffers stdin in a temp file (M1) — a shell variable stripped NUL bytes and double-buffered 256KB — and posts with `--data-binary` (plain `-d` strips newlines).
- Briefing budget reduction happens inside `compileBriefing` (M4): the DB-heavy tiers and query fingerprint are computed once instead of once per reduction pass, and index-mode no longer wastes two identical recompiles.
- `prompt-check.test.ts` now tests the real exported `extractDecision` instead of private regex copies that could never catch a regression.

### Fixed (2026-07-09 findings from MCP test expansion)

- Success classification requires an explicit success pattern in the command output — exit code 0 alone (an `ls` after an edit) no longer mints a "test pass" pattern and a "Verified (tests pass)" plan note.
- `error-dedup.json` honors the `CAIRN_DIR` override like the rest of the tracker state, so sandboxed environments stay off the real `~/.cairn`.
- Hook socket can no longer SIGTERM its own process on an in-process restart (the stale-daemon killer now refuses its own PID), registers a single process-exit cleanup listener instead of stacking one per start, and derives socket/PID paths lazily honoring `CAIRN_DIR`.
- Fired reminders returned by `checkAndFire`/`checkFileReminders`/`checkTimeReminders` carry post-fire `fire_count`/`active` values instead of stale pre-increment ones.
- `cairn_stats` no longer renders `null/0` embedding/anchor/reminder aggregates on an empty store (SQL `SUM` NULLs coalesced).
- `handleSessionStart` reports the token estimate of the text it actually emits — Stage-2 recovered pitfalls and appended reminders were previously excluded from the telemetry estimate.
- `SessionStartInput.type` is optional, matching the wire contract (Claude Code omits it on post-compaction restarts); the handler's internal cast is gone.

### Added (2026-07-09 test batch — MCP layer + handlers)

- MCP tool-surface tests over the real registration path (`InMemoryTransport` client pairs, in-memory DBs): memory tools, plan tool, reminder tools, portability/stats tools, and MCP resources.
- Embedded hook-socket router tests: route dispatch, 404s, `/statusline` state-file side effects, `/stop` tracker flush, stalled-client teardown, malformed-JSON survival.
- `session-start-handler` orchestration tests (session typing, interruption detection, briefing content/budget, tracker seeding, maintenance) and `error-learning`/`success-tracker` handler tests (pitfall creation/dedup/escalation, auto-weaken vs impact-credit, investigation chains, resume cursor, surfaced-pitfall confirmation).

### Fixed (2026-07-08 resilience batch)

- Startup now detects and repairs FTS index cardinality drift (kill mid-migration previously left `memories_fts` empty forever, silently breaking keyword recall). Detection counts rows in the `memories_fts_docsize` shadow table — `COUNT(*)` on an external-content FTS5 table reads through to the content table and can never see drift. Scope is row-count drift only; same-count stale-term corruption would need FTS5's full `integrity-check`, deliberately not run on the per-hook startup path.
- Consolidation cluster merges are now transactional — a crash mid-merge can no longer strand invalidated members whose representative was never updated.
- Consolidation batch-loads candidate memories via new `findByIds` (one query) instead of up to 150 single-row `findById` round-trips.
- Hook-socket `readBody` now destroys the request and detaches listeners on timeout, so stalled clients no longer leak buffered chunks.
- A failed embedding-pipeline load now clears the cached promise so the next call retries — one transient model-download failure no longer disables embeddings for the life of the process.
- `hook-relay.sh` routes standalone hooks (`precompact`, `session-end`) directly to node instead of through the daemon socket, which has no route for them.
- Test suite is now hermetic: a `--require` preload (`tests/hermetic-env.cjs`) points `CAIRN_DIR` and new `CAIRN_STATE_PATH` override at a per-process temp dir, and `isSafeTranscriptPath` allows the OS `tmpdir()` instead of hardcoded `/tmp/`, so tests pass on macOS and sandboxed hosts without touching real `~/.cairn` or `~/.claude` state.
- Added regression tests for the hook-relay binary's HTTP correctness fixes (non-2xx fallback, NUL-byte bodies, 2xx passthrough) from the correctness batch.
- Hook-relay fallback failures are now observable: the fallback child exits with sentinel codes (126 setup / 127 exec, shell convention) that the parent logs to `~/.cairn/hook-relay-fallback.log` (`fallback-exec-node-fail`, `fallback-child-setup-fail`, plus `fallback-pipe-fail`/`fallback-fork-fail`/`fallback-script-path-fail`, and `fallback-script-missing:<resolved path>` with errno), instead of a hook silently vanishing with exit 0 and no trace. Signal deaths (`fallback-child-signal-N`, e.g. SIGSYS 31 = seccomp denial), non-sentinel script failures (`fallback-child-exit-N`), and unwaitable children (`fallback-wait-fail`, e.g. ECHILD auto-reap) are all logged too — no child outcome is untraceable. Stdout stays clean for Claude Code. Over-long log lines truncate instead of being dropped.
- Hook-relay fallback no longer relies on the child inheriting the relay's stdout: the child's output now returns through an explicit pipe (`dup2`'d onto the child's `STDOUT_FILENO`, which also clears any close-on-exec flag) and the parent pumps it to its own stdout via a `poll()` loop that feeds stdin and drains stdout concurrently (no deadlock when a hook emits more than a pipe buffer before finishing its stdin read; verified with 1MB output and a 256KB-before-stdin-read interleave). Sandboxes that revoke inherited fds across the grandchild's `execve` previously lost hook output silently; new `fallback-stdout-pipe-fail`/`fallback-stdout-write-fail`/`fallback-pump-poll-fail` diagnostics cover the new failure surface.
- Hook-relay resolves its sibling hook scripts via `/proc/self/exe` (argv[0] fallback on non-Linux) — sandbox shims that rewrite argv[0] to a bare basename previously made the relay look for `./<hook>.js` in an arbitrary cwd and silently skip the fallback.
- Hook-relay now ignores SIGPIPE — a daemon dropping the connection mid-write or a fallback child dying pre-exec previously could kill the relay via the default SIGPIPE action instead of surfacing as an EPIPE write error the fallback paths handle.
- Relay tests now run through a shared async-spawn harness (`tests/relay-harness.ts`) with a 10s kill timer — `spawnSync(..., { input })` is avoided entirely because some sandboxes never deliver stdin EOF on that path, blocking the relay's read loop; async spawn with explicit `stdin.end()` matches production shell-pipe delivery and works there. Tests asserting real `git` output probe spawn capability first (shared `tests/spawn-probe.ts`) and skip or assert the documented `no-git` fail-safe when Node cannot spawn git.

### Fixed (2026-07-08 audit correctness batch)

- Fixed hook-relay C binary out-of-bounds read when the HTTP request neared the input buffer cap — headers and body are now written as separate syscalls with a truncation guard.
- Fixed hook-relay C binary truncating request bodies at NUL bytes while Content-Length claimed the full size, which hung the daemon read.
- Hook-relay C binary now falls back to direct-node execution on non-2xx daemon responses instead of printing the error body as hook output and silently dropping the hook (e.g. 404 for an unrouted hook type).
- Capped the JS cosine-similarity vector-search fallback at 200 rows (`RELEVANCE.VECTOR_FALLBACK_SCAN_LIMIT`) so recall without sqlite-vec no longer scans the whole store on the MCP hot path.
- Memory dedup is now scope-exact: a project-scoped lesson can no longer merge into (and overwrite) an identical global memory, or vice versa.
- `recallByAnchor` now escapes SQL LIKE wildcards in file paths (shared `escapeLikePattern` util), so underscores in file names no longer over-match unrelated anchors.
- `cairn-state.json` and edit-tracker saves now use atomic temp-file+rename writes, eliminating torn/partial reads. (The standalone-mode load→mutate→save lost-update race is NOT closed by this — it needs a lock-wrapped `updateTracker(fn)` API, deferred to the resilience batch; daemon mode is unaffected.)
- Edit-tracker directory is now overridable via `CAIRN_DIR` env var (mirrors `CAIRN_DB_PATH`), so tests and sandboxed environments stay off the real `~/.cairn`.
- Auto-promotion no longer creates a self-referential `generalizes` edge, which made promoted memories surface themselves as their own graph neighbor on every recall.
- Pitfall-check reuses the shared `InvestigationRepository` from the hook context instead of re-preparing statements on every tool call.
- Decision-reflector clears its 10s sampling-timeout timer once the race settles instead of pinning one timer per Stop event.

### Changed (Docs — README sync for v5.0.0 SNR family)

- **`README.md` Key Design Decisions section** expanded with eight new v5.0.0 bullets that surface the post-v4.2.0 SNR work the README had fallen behind on: SNR v3 trust plan + guardrail test suite, project-identity token exclusion, always-on guard fallback + cold-start queryFp synthesis, `isMetaGoal` resume-prose coverage, three-tier goal rendering (Now/Feature/Project), goal ship-detection via `shippedByCommit`, the SNR v3.1 prompt-handler goal-kind staleness gate, and `recoverDroppedPitfalls` quality-floor parity. All eight already existed in this `[Unreleased]` section — the README change is pure doc sync with no code impact.

### Added (SNR v3 — trust plan: six commits + audit)

The SNR v3 trust plan closes the measurement loop for the briefing compiler so every subsequent change can be measured against a locked-in guardrail suite instead of claimed. Six commits (0-4 + follow-up) land the infrastructure, fixes, and rendering overhaul; the audit commit (5) tightens the correction pass and documents its invariants.

- **Commit 0 — Guardrail infrastructure (`7957241`).** New `tests/snr-guardrails.test.ts` locks in three SNR probes (warm compact, post-restart startup, cold-start startup) plus an inverse probe that asserts 100% recall of known-relevant memories. Each probe seeds the memory store with a mix of relevant + distractor + foreign-project items and asserts the noise budget from the compiled briefing. Shared constants (`PROBE_SIGNAL_FLOOR`, `COLD_START_NOISE_CAP`) give every subsequent commit a measurable target.
- **Commit 1 — Project-identity token exclusion (`525941c`).** `deriveProjectIdentityTokens(project)` strips the project slug tokens from both sides of the same-project relevance check. Previously a pitfall tagged `['cairn', 'hooks']` (cairn's top-level area labels) trivially overlapped any queryFp containing the project identity, so they surfaced on every briefing regardless of task topic. The gate now also requires a surviving non-identity token match — generic area labels alone can't pass. Regression test locks 0/5 noise count on post-restart and cold-start probes.
- **Commit 2 — Always-on guards via `BRIEFING_BROAD_FP` fallback (`1365cbd`).** Replaces the `queryFp ? guard : raw` bypass ternary in `renderTier3` + `recoverDroppedPitfalls` with `guard(queryFp ?? BRIEFING_BROAD_FP)`. A banned-pattern test asserts zero occurrences of the bypass ternary going forward. The fallback `{ lang: [], framework: [], module: [] }` triggers `passesSameProjectRelevance`'s broad-query short-circuit so cold-boot briefings still surface same-project memories; the cross-project guard still blocks unfingerprinted globals because `fingerprintOverlap(…, broadFp) = 0`.
- **Commit 3 — Cold-start queryFp synthesis + narrow-overlap policy (`9d248d0`).** `buildBriefingQueryFp` now always returns a `ContextFingerprint` (never `undefined`), so the downstream guards can run unconditionally. New `meaningfulTokenCount(fp, identityTokens)` strips project-identity + generic-area tokens before counting; when the count falls below `NARROW_OVERLAP_MIN_MEANINGFUL_TOKENS` (2), the compiler uses the broad variant of the fingerprint for the same-project gate (so task-specific filtering doesn't starve cold briefings) while keeping the full synthesised fp for the cross-project guard (so unfingerprinted globals still get blocked). Pitfall cap lowered to 2 on the cold path.
- **SNR v3 follow-up — Meta-goal filter for resume-session prose (`64f32a6`).** Out-of-plan side fix for a live DB finding: `compaction_snapshots.initial_goal` was storing verbatim session-resume prose ("Continue this was where you were before we cot disconnected: Next: Commit 2 — …") and `buildBriefingQueryFp` was leaking 21 English words (`continue`, `disconnected`, `ternary`, `both`, `places`, `banned`, `proceed`, …) into `queryFp.module` via the goal tokenizer. `isMetaGoal` missed it because the message was >60 chars, so none of the `shortMetaPatterns` fired. Two-layer defence-in-depth: four new `resumeProsePatterns` on `isMetaGoal` catch long-form resume prose ("this was where you were", "where you left off … before", "before we (got|cot) disconnected", "ready to proceed$"); `buildBriefingQueryFp` now filters `initialGoal`, `plan.name`, and in-progress step descriptions through `isMetaGoal` before tokenizing. Probe on the affected snapshot: 36 → 16 queryFp tokens (21 prose tokens gone), 286 → 189 briefing tokens (−97), polluted goal suppressed.
- **Commit 4 — Three-tier goal rendering (`9bae049`).** Replaces the monolithic "Goal / Previous goal / Project goal (source)" rendering with a three-tier taxonomy. Each tier has its own staleness policy and age-metadata pipeline:
  - **Now** — session-scoped per-turn task (from `compactionSnapshot.initialGoal`). Staleness: session-boundary (drops when `snapshotSessionId !== ctx.currentSessionId`) plus the existing `isMetaGoal` / branch / carry / shipped gates.
  - **Feature** — branch-scoped work (branch-source `project_goal`). Staleness: branch mismatch + completed-step + shipped-by-commit.
  - **Project** — durable branch-spanning intent (plan/user/transcript source). Staleness: explicit pivot only — never auto-drops on branch change or shipped detection.
  Cross-tier dedup prevents the same text surfacing twice: tiers are added in order Now → Feature → Project and each candidate's tokens are Jaccard-compared against already-accepted tiers (threshold `GOAL_TIER_DEDUP_JACCARD` = 0.55). Each rendered line carries a compact age suffix via `formatAgeCompact`: `Now: … (2m ago)`, `Feature: … (branch, 3h ago)`, `Project: … (plan, 8d ago)`. **Schema v23** adds `goal_captured_at` and `project_goal_captured_at` columns to `compaction_snapshots`; both writers (`precompact.ts` + `session-end.ts`) populate them and carry them forward on inheritance so the age clock doesn't reset on every compaction. `session-start-handler.ts` now runs two independent per-tier queries so Feature + Project can coexist on the same branch (previously mutually exclusive on a single `project_goal` field). New `tests/goal-tiers.test.ts` (+27 tests) covers label taxonomy, session-boundary + branch + shipped + completed-step staleness, cross-tier dedup, `formatAgeCompact`, index-mode parity, and schema round-trip.
- **Commit 5 — `recoverDroppedPitfalls` audit + quality-floor parity (this commit).** Verdict: keep + patch + document. Two gaps found and fixed: (1) recovery was sorting by raw `impact_count` without applying `LOW_EFFECTIVENESS_THRESHOLD`, so a pitfall with `impact=10 / surface=100 / effectiveness=0.22` would be correctly dropped by `topPitfalls` under budget pressure and then resurrected by the recovery pass — undoing main's effectiveness filtering; (2) `CORRECTION_PASS_MIN_CONFIDENCE` was defined as a constant (0.5) but never enforced in the function body. Fix: recovery now applies both `computeEffectiveness(m) >= LOW_EFFECTIVENESS_THRESHOLD` and `m.confidence >= CORRECTION_PASS_MIN_CONFIDENCE` filters after the cross-project + same-project gates, giving recovery the same quality floor as the main briefing. Expanded JSDoc documents the five invariants recovery now maintains (post-budget only, exclusion-respecting, quality-floor parity with main, same SNR guards, capped output). Three new regression tests in `tests/briefing-recovery.test.ts` lock the contract: pitfall below effectiveness floor blocked, pitfall below confidence floor blocked, healthy pitfall still recovered.

**Verification (final):**
- `npm run build` — clean, `tsc --noEmit` zero errors.
- `npm test` — all passing (1253 + audit regression tests).
- `node scripts/snr-probe.mjs` (compact) — 197-token briefing, queryFp 16/16 legitimate tokens, `Feature: Primary memory integration (branch, 1h ago)` renders with age label. Zero prose tokens leaked.
- `node scripts/snr-probe.mjs --cold` — 108-token briefing, queryFp 4/4 legitimate, no goal lines (correct — no `ctx.featureGoal`/`projectGoal` in cold boot).

**SNR baseline after v3:** warm compact briefing 100% signal (16/16 legitimate tokens, zero noise), cold startup briefing 100% signal, post-restart noise 0/5 on both project-identity and disjoint-module probes.

### Fixed (SNR v3.1 — prompt-handler goal-kind staleness gate)

Out-of-plan follow-up after a live-session finding: the v3 trust plan scoped the **briefing compiler**, but the `prompt-handler` recall paths (goal pre-flight + Layer 1a broad recall + Layer 1b co-recall prediction + Layer 1c vector search) are a **parallel code path** that v3 never touched. A `kind: 'goal'` memory written via `cairn_learn` in a past session — specifically the live-DB row `4ab27ef4-db94-4c3a-aef9-65c9e9500d39` with content `"Resume point: uncommitted 4 SNR fixes … Next: re-run snr-probe … then commit."` — had no TTL and no staleness check, so it kept surfacing on every matching prompt weeks after the work shipped. The briefing compiler would correctly filter this through `evaluateCarriedGoal` / `isMetaGoal`, but the prompt-handler had no equivalent gate.

- **`src/hooks/shared/transcript-parser.ts` — `isMetaGoal` resume-prose pattern extension.** Adds `^resume point:\s` to the `resumeProsePatterns` array. The four existing patterns covered the "this was where you were / before we cot disconnected / ready to proceed" shape but missed the "Resume point: … Next: …" shape that was actually in the live DB. One-line addition with a comment documenting the live-DB trigger (memory id `4ab27ef4…`) so future readers know why the pattern exists.
- **`src/constants/index.ts` — new `LIMITS.GOAL_REMINDER_MAX_AGE_HOURS = 72`.** Age threshold for recalled goal memories. 72h (3 days) covers overnight + long-weekend continuity without holding last week's resume prose as "similar prior goal". Chosen over 24h (too tight — loses Friday-to-Monday continuity) and 168h (too loose — a full week of stale context is noise by default).
- **`src/hooks/handlers/prompt-handler.ts` — new `isGoalMemoryStale(mem, nowMs?)` helper + four call sites.** The helper applies two rejection rules: (1) `mem.kind === 'goal'` AND `isMetaGoal(mem.content)` (catches session-continuity blurbs at recall even if they sneak past ingest), (2) `mem.kind === 'goal'` AND age > `GOAL_REMINDER_MAX_AGE_HOURS`. Non-goal memories pass through unchanged. Conservative on invalid dates (returns `false` — cannot prove stale). Applied at the four recall sites:
  - **Task-intent goal pre-flight** (`recall(kind: 'goal')` → `[CAIRN goal] Similar prior goal: …`). Added after the existing `passesCrossProjectGuard` filter.
  - **Layer 1a broad recall** (`search()` → `[CAIRN] <kind>: <content>`). Applied in the same filter chain so goal-kind results get checked while pitfall/decision/fact results are untouched.
  - **Layer 1b co-recall prediction** (`predictRelated()` → `findById()` → surface). Added as a `continue` guard immediately after the existing `invalidated` / `confidence` filter so stale goals are skipped before preferred-kind scoring.
  - **Layer 1c vector search** (`recallHybrid()` / `searchByProxyEmbedding()`). Applied in both branches of the `cached` conditional so the fallback proxy-embedding path gets the same treatment.
- **One-off DB cleanup.** Marked the specific stale memory `4ab27ef4-db94-4c3a-aef9-65c9e9500d39` as `invalidated=1` via direct SQL so it stops firing immediately, without waiting for the recall-side filter to catch it on the next prompt. This is a one-time manual remediation of already-poisoned data — the recall-side filter and the `isMetaGoal` pattern extension prevent the same shape from persisting in the future.
- **`tests/prompt-handler-goal-staleness.test.ts` (new file, +9 tests).**
  - Unit tests for `isGoalMemoryStale` (7): non-goal kinds pass through regardless of age/content; `Resume point:` content trips the `isMetaGoal` rule; long-form `"this was where you were … ready to proceed"` prose trips the existing pattern; age > 72h trips the age rule; fresh clean goal passes; invalid `created_at` returns `false` (conservative); exact 72h boundary is still fresh (strict inequality).
  - End-to-end tests (2) using the same `handlePromptCheck` + in-memory DB harness as `prompt-handler-nudge.test.ts`: seeded `Resume point: …` goal memory is filtered out of the output; seeded clean "three-tier goal renderer" goal memory still surfaces via the pre-flight match when the prompt is semantically similar.
- **Verification.**
  - `npm run build` — clean, `tsc --noEmit` zero errors.
  - `npm test` — **1265/1265** passing (1256 → 1265, +9 new in `tests/prompt-handler-goal-staleness.test.ts`).
  - `node scripts/snr-probe.mjs` — unchanged (probe exercises the briefing compiler, not the prompt-handler — this is correct, the probe's scope never covered the affected surface).
  - `node scripts/snr-probe.mjs --cold` — unchanged (101 tokens, 4/4 legitimate queryFp tokens).
  - `node scripts/snr-inverse-probe.mjs` — 3/3 = 100.0% recall, 0 leaks. No regression.

**Scope discipline.** Intentionally *not* in this commit: staleness gates on `kind: 'fact'` memories (e.g. the `SNR v5+phase6a 50%` fact that also surfaced in this session), `cairn_learn`-side validation that rejects time-sensitive content at ingest for `kind: 'goal'`, and any changes to the briefing compiler or its probes. Each of those is a separate surface with its own design tradeoffs — lumping them into one commit would have made the fix harder to review and the rollback noisier.

**Trust impact.** The v3 plan's four trust breakers (false positives, honest sparsity, stale state shown as fresh, unmodelable behavior) were all addressed in the briefing compiler but a *parallel* instance of breaker 3 lived in the prompt-handler recall path. v3.1 closes that gap with the same structural approach: a one-sentence rule per rejection path, applied uniformly at every call site, locked by tests.

### Fixed (Briefing SNR v2 — stale-error filter, bare-dir cleanup, narrow relevance gate)

- **`src/hooks/shared/transcript-parser.ts` — stale-error bucket resolution.** The briefing's `Errors:` section previously surfaced error strings from the compaction snapshot even after the underlying file had been fixed. The parser now resolves each error against current tsc bucket state and drops entries whose target lines/symbols no longer trip the compiler. Bare path segments (`opt`, `.claude`, etc.) are filtered out of `queryFp.module` tokens so unrelated root-path noise can't match same-project memories.
- **`src/utils/cross-project-guard.ts` — narrow vs broad module-overlap gate.** Pitfall surfacing now requires a meaningful surface overlap: the task's modules must intersect the memory's fingerprint, OR an anchor in the memory must reference a query-module token. Prevents project-scoped but task-irrelevant pitfalls from leaking into briefings.
- **`scripts/snr-probe.mjs` — deterministic live SNR sniff.** Probe now reads the `compaction_snapshot` row directly for a session-independent measurement, instead of synthesising a fake briefing from DB state. Output is reproducible across runs against the same snapshot.
- **`src/hooks/hook-relay.c` — fallback-path instrumentation.** The C relay now logs each fallback reason (`socket-missing`, `connect-fail`, etc.) to `~/.cairn/hook-relay-fallback.log` so three-layer-pipeline bypasses are diagnosable instead of invisible. Binary rebuilt via `npm run build:relay`.
- **Ten new tests** across `tests/hooks.test.ts` (6) and `tests/pitfall-same-project-relevance.test.ts` (4) cover error-bucket resolution, bare-dir token filtering, and narrow vs broad same-project relevance edge cases. Full suite 1196/1196; `tsc --noEmit` clean.
- **Expected live SNR lift:** briefing quality 77.8% → ~86.7% once the next compaction writes a fresh snapshot with the new parser active. Pending post-compaction verification via `node scripts/snr-probe.mjs`.

### Fixed (Briefing SNR v2.2 — intra-T1 snapshot-decision dedup)

- **`src/hooks/shared/briefing-compiler.ts` — Tier 1 snapshot decision dedup.** `renderTier2` already collapses near-duplicate decisions across tiers via jaccard+prefix, but the snapshot-sourced branch in the Tier 1 renderer pushed every entry from `snap.recentDecisions` verbatim. Sigil-captured decisions that re-articulate the same insight across turns with different truncation would therefore accumulate as visibly-duplicate briefing lines. T1 now applies the same `DECISION_DEDUP_JACCARD` / `DECISION_DEDUP_PREFIX` filter to its own snapshot list before rendering.
- **Two new tests** in `tests/briefing-recovery.test.ts` cover the collapse of near-duplicate snapshot decisions and the preservation of genuinely distinct ones. Full suite **1201/1201** passing; `tsc --noEmit` clean.
- **Live probe verification:** duplicate `Mirror system-root path segments…` entry collapsed; SNR probe reports **8 signal / 0 noise content items = 100.0%** (up from 88.9% under v2.1), briefing token estimate 355 → 290.

### Fixed (Briefing SNR v2.1 — filesystem-root segment filter)

- **`src/utils/fingerprint.ts` + `src/hooks/shared/briefing-compiler.ts` — system-root segment filter.** The v2 commit message claimed `queryFp.module` filtered bare path segments like `opt` and `.claude`, but in practice only the `Recently read` file list was guarded (via `looksLikeFilePath`); absolute paths like `/opt/cairn/src/hooks/...` were still leaking `opt` as a module token. Added `opt|usr|var|home|root|tmp|etc` and `.claude|worktrees` to both `GENERIC_PATH_SEGMENTS` (memory-store side) and `BRIEFING_GENERIC_SEGMENTS` (briefing-query side) so filesystem structure never pollutes either fingerprint path. Real project identity tokens (`cairn`, `hooks`, `handlers`, …) still flow through.
- **Three new tests:** `tests/fingerprint.test.ts` (+2) cover absolute-path root filtering and Claude Code worktree path filtering; `tests/hook-gap-briefing-relevance.test.ts` (+1) asserts `buildBriefingQueryFp` drops these segments end-to-end. Full suite **1199/1199** passing; `tsc --noEmit` clean.
- **Live probe verification:** `queryFp.module` before filter = `['opt', 'cairn', 'changelog', 'hooks', 'stop', 'mcp', 'hook', 'socket', 'primary', 'memory', 'integration']`; after = same set with `opt` dropped. No spurious broad-memory matches from this leak path are now possible.

### Added (Layer 1c — Socratic Stop reflection + tier-3 nudge)

- **`src/hooks/shared/decision-reflector.ts` (new file, ~240 lines).** Three exports: (1) `countDecisionMarkers(text)` — cheap regex pre-gate that counts decision-indicative phrases in an assistant turn without trying to extract content; (2) `reflectOnTurn(message, innerServer)` — capability-gated LLM extraction that asks a host-side Haiku (via MCP sampling, same pattern as `utils/distillation.ts`) to return decisions as strict JSON, with timeout/parse/API error all resolving to `[]`; (3) `renderReflectedDecision(d)` — formats structured `{chose, why}` output into the `"X because Y"` shape the memory store expects, with 200-char truncation.
- **Three-layer Stop-handler pipeline.** `handleStop` is now async and runs Layer 1a (sigils) → Layer 1b (legacy prose extractor) → Layer 1c (Socratic reflection). 1a is authoritative — when sigils are present, 1b and 1c are skipped. 1b fires on short unformatted turns the legacy regex can parse. 1c runs only when 1a and 1b both miss AND the turn has ≥`REFLECTION_MIN_MARKERS` (2) decision markers — below that threshold the inference call is skipped entirely.
- **Tier-3 nudge flag.** When Layer 1c returns an empty array (sampling unavailable, API error, LLM found nothing), the Stop handler writes `tracker.pendingDecisionNudge = markerCount` to the session tracker. The next `UserPromptSubmit` reads the flag, emits a single-line reminder (`[CAIRN] Last turn had N decision markers but no sigil and no auto-extraction...`), and clears the flag. At-most-once per drop, fires regardless of context mode because it's tiny and high-signal.
- **MCP inner server threaded through the hook socket.** `startHookSocket` now accepts an optional `innerServer?: Server` parameter, which `server.ts` passes as `server.server`. `CachedHookContext` carries it so hook handlers that want host-side capabilities (sampling, elicitation) can access them the same way MCP tools already do via `memory-tools.ts`. The hook-socket route dispatcher awaits async handlers so Layer 1c can make its inference call without blocking the sync handlers.
- **`EditTracker.pendingDecisionNudge: number`** — new session-tracker field, defaults to 0, persists across hook processes via the existing `loadTracker`/`saveTracker` path and the shared `SessionCache`.
- **39 new tests across three files:**
  - `tests/decision-reflector.test.ts` (24 tests) — `countDecisionMarkers` on recommendations / architecture framing / tradeoff framing / fenced code / inline backticks / pattern dedup; `renderReflectedDecision` formatting / truncation / empty-why / blank-chose; `reflectOnTurn` with mock `Server` covering sampling-capable vs not, happy-path JSON, markdown-fenced JSON, leading-prose tolerance, malformed JSON, empty decisions, thrown errors, `REFLECTION_MAX_DECISIONS` cap, short-chose rejection, shape-mismatch rejection.
  - `tests/stop-handler-reflection.test.ts` (8 tests) — layer precedence (1a wins over 1b+1c, 1b wins over 1c), Layer 1c fires when markers + no sigils + no prose hit + sampling available, Layer 1c sets nudge when reflection returns empty, Layer 1c sets nudge when `innerServer` is undefined, Layer 1c does NOT fire below marker threshold, sigil confidence is LEARNED (0.65) not AUTO_DETECTED (0.55).
  - `tests/prompt-handler-nudge.test.ts` (5 tests) — nudge line emitted when flag > 0, flag cleared after emission (at-most-once), nudge absent when flag = 0, singular vs plural marker count, fires regardless of context mode.
- **Rule file update** (`.claude/rules/cairn.md`) — documents the three-layer pipeline and tier-3 nudge semantics under "After EVERY significant decision".
- **SNR preservation verified.** `scripts/snr-probe.mjs` output is deterministic and the briefing-compiler / relevance-gate / memory-repository files are **zero-diff** from their post-Design-1 state (`git diff HEAD -- src/hooks/shared/briefing-compiler.ts src/utils/cross-project-guard.ts src/db/memory-repository.ts` → 0 lines). The probe token count actually dropped from 299 → 285 because the plan state advanced during the audit (step 5/8 → 7/8, with step 8's description shorter than step 6's). No broad memories leak, no new sections, no noise added. Full suite: **1186/1186 passing** (was 1147, +39 new).
- **Research-backed novelty.** Web-verified against mem0, Cline Memory Bank, Aider, A-MEM (NeurIPS 2025), Letta, and Cursor Rules. State of the art in April 2026 is LLM extraction at ingest (mem0/A-MEM/mem-agent — high cost) or pure social enforcement (Cline/Aider/Cursor — unreliable). Sigils + gated reflection is a hybrid third path: explicit-authorship primary, LLM safety net, cheap counter-based nudge as last resort — each layer catches what the previous one misses without paying the previous's cost unnecessarily.

### Added (Decision sigils — explicit-authorship capture path)

- **`extractDecisionSigils(text)` in `src/hooks/shared/transcript-parser.ts`.** Parses inline `[dec: chose X over Y because Z]` markers out of assistant text as a cheap, zero-false-positive alternative to the brittle prose extractor. Strips fenced code blocks and inline backticks first so sigil examples in documentation and code are never self-captured. Caps at 8 sigils per turn, 200 chars per sigil, and deduplicates identical sigils within the same turn. Case-insensitive marker.
- **Stop handler two-layer capture.** `handleStop` now runs sigil extraction first; when sigils are found, each is persisted via `storeDecision` at `CONFIDENCE.LEARNED` (0.65) with `source: 'learned'`, and the legacy prose extractor is skipped for that turn. When no sigils are emitted, it falls back to the existing `extractAssistantDecision` path unchanged. New `StopResult` fields: `sigilCount`, `sigilDeduped`. New action value: `'sigil-mined'`.
- **Why this exists.** A live-DB audit against this branch showed the legacy miner captured 0/5 of this session's architectural decisions. The root cause is structural: `extractAssistantDecision` rejects text with `length > 500`, `≥3 ** markers`, or `^# headers` — which eliminates every modern markdown-heavy assistant response before pattern matching. Widening the regex risks false-positive explosion; sigils sidestep the problem by making authorship explicit. State-of-the-art memory systems (mem0, A-MEM, mem-agent) all use expensive LLM extraction passes; user-driven markdown systems (Cline Memory Bank, Aider `CONVENTIONS.md`, Cursor Rules) rely on pure social enforcement that fails the same way regex does. Sigils are a third path: explicit-authorship with ~0 parsing cost and no tool-call overhead.
- **11 new tests** in `tests/compliance.test.ts` cover: single sigil in prose, multiple sigils per turn, empty-input safety, fenced-code-block stripping, inline-backtick stripping, length truncation, case-insensitivity, intra-turn dedup, empty-sigil rejection, and the per-turn cap.
- **Rule file update.** `.claude/rules/cairn.md` documents the convention under "After EVERY significant decision" so the agent learns to emit sigils naturally alongside `cairn_learn(decision)` calls.
- **SNR impact: zero.** `scripts/snr-probe.mjs` against the live `~/.cairn/cairn.db` produces byte-identical output before and after this change — sigils persist through the existing `storeDecision` path and the briefing compiler is untouched.

### Fixed (Briefing SNR — goal ship-detection)

- **New staleness gate in `evaluateCarriedGoal`: `shippedByCommit`.** When the goal's meaningful tokens (length ≥3, non-stopword) are covered by the union of recent commit-subject tokens at ≥ `GOAL_SHIPPED_COVERAGE` (0.6), the goal is suppressed as "already in git history". Conservative: requires ≥3 goal tokens and ≥1 recent commit before the gate runs, so trivial/short goals are exempt.
- **`GitWorkingState.recentCommits?: string[]`.** `getGitWorkingState` now also fetches the last 8 commit subjects via `git log -8 --pretty=%s` so the briefing can compare goal text against git history. Optional field — existing test fixtures and callers that don't populate it remain backwards-compatible and the gate silently skips.
- **Four new tests** in `tests/hook-gap-briefing-relevance.test.ts` cover: goal suppressed when commits cover its tokens, goal kept when commits are unrelated, backwards-compat when `recentCommits` is undefined, and no crash on sub-3-token goals.
- **Measured impact:** live-DB probe now drops the "Primary memory integration — North-Star Phases 3+4+5" goal line (the phases already shipped in commits `be8250f`, `f97a25a`, `4418831`, `700fa15`), trimming the briefing to 8 items with ≥87% SNR.

### Fixed (Briefing SNR — broad-memory leakage)

- **`passesSameProjectRelevance` no longer lets broad same-project memories ride through task-specific briefings.** The previous "broad↔broad symmetry" branch passed any memory with `fingerprint.module=[]` (or null fingerprint) when the query itself had module signal — so empty-module Cairn pitfalls and null-fingerprint decisions leaked into every startup briefing regardless of topic. The gate now requires a concrete relevance signal: non-empty `module` intersection OR an anchor whose text contains any query module token. True broad↔broad symmetry (query has no file AND no module) is preserved by the earlier early-return.
- **`topPitfalls` re-rank scores empty-module fingerprints at 0** when the query has modules. Previously a stored fingerprint with `module=[]` still scored `fw_weight + lang_weight ≈ 0.5`, tying with genuinely task-relevant candidates and competing for briefing slots. The rewritten scoring breaks the tie so relevant memories consistently rank above broad ones, complementing the same-project relevance gate.
- **Test updates:** `pitfall-same-project-relevance.test.ts` flipped the "broad memory on module-only query" case from pass to block and added two anchor-based cases. `briefing-recovery.test.ts` decisions in two tests now carry realistic fingerprints matching the task context they're tested against.
- **Measured impact:** ad-hoc `scripts/snr-probe.mjs` against the live `~/.cairn/cairn.db` on the `feat/primary-memory-integration` branch context — compact-mode briefing dropped from ~20 items (50% signal) to 9 items (≈89–100% signal). Removed: broad-module Cairn pitfalls and stale null-fingerprint Phase 6d decisions. Kept: all structural header/git/user/plan/goal/recent-files lines plus module-matched pitfalls.

### Added (North-Star Phase 5 — Recall precision feedback loop)

- **`memoryRepo.applyPrecisionFeedback(sessionId, strengthen, weaken)`.** Walks `session_memories` for a session and nudges confidence: `led_to_success = 1` rows get a gentle strengthen (`+0.05`), `led_to_success = 0` rows get a mild weaken (`× 0.97`, floored at `DELETE_THRESHOLD + ε` so the gentle pass never auto-invalidates — that's what explicit `weakenConfidence` is for). Closes the feedback loop from the North Star plan: recalled-and-used rises, recalled-and-ignored sinks.
- **SessionEnd invokes the precision feedback pass** right before the "dream" consolidation. Best-effort — never blocks session end. Constants: `LIMITS.PRECISION_STRENGTHEN_INCREMENT`, `LIMITS.PRECISION_WEAKEN_FACTOR`.
- **7 new tests** in `tests/north-star-phase5-precision-feedback.test.ts` covering strengthen, weaken, floor protection, skip-not-recalled, skip-invalidated, mixed pass, and idempotency (confidence stays in `[0, 1]` across 10 repeated passes).

### Added (North-Star Phase 4 — Goals as first-class memories)

- **New memory kind `'goal'`** (schema v22, bundled with `'pattern'` in a single `memories` table rebuild). Added to `MEMORY_KINDS`, `LEARNABLE_KINDS`, `DECAY_FACTOR_BY_KIND` (0.92 — goals decay slowly, they anchor cross-session retrieval), `STABILITY_BY_KIND` (90 days — highest-stability kind after user profiles and references).
- **`cairn_plan(create)` stores the plan name as a goal memory.** Cheap dedup against existing same-project goals prevents duplicates when a plan is recreated with the same name. Tagged `plan-goal` so downstream consumers can distinguish plan-derived from prompt-derived goals. Failures are swallowed — goal storage never blocks plan creation.
- **Prompt-handler goal pre-flight match.** When a task prompt arrives, `handlePromptCheck` runs a new `recall(prompt, {kind: 'goal'})` call alongside the existing pitfall + decision recalls. The top matching goal (if similarity passes `MIN_SCORE_FOR_INJECTION` and the cross-project guard) is surfaced as `[CAIRN goal] Similar prior goal: …`. This is the single biggest compounding-learning lever: every new task starts with the prior attempt's goal rationale surfaced next to the new prompt.
- **5 new tests** in `tests/north-star-phase4-goals-as-memories.test.ts` covering create/retrieve round-trip, content-match recall, project isolation, global (null-project) goals, and minConfidence gating.

### Added (North-Star Phase 3 — Positive pattern learning + iteration-cost tracker)

- **New memory kind `'pattern'`** (schema v22). Patterns are distilled wins from smooth sessions — "used the two-step refactor approach, tests passed first try". Decay factor 0.94, stability 50 days. Stored via `cairn_learn(kind: pattern)` or auto-mined by SessionEnd.
- **`extractWinningPattern(text)` in transcript-parser.** Requires BOTH an approach signal (used/adopted/strategy/pattern/refactor) AND a success signal (first try, tests pass, clean build, zero regressions). Rejects markdown reports, bullet lists, conversational openers, generic "all tests pass" lines, and victory laps. Same conservative gating as `extractAssistantDecision` but tuned for positive patterns.
- **Iteration-cost tracker in `EditTracker.editCountsByFile`.** Incremented by success-tracker-handler on every Write/Edit/MultiEdit. MultiEdit increments each unique target file once (semantically one round of work per file). Cleared on session boundary via the existing sessionId-change path.
- **SessionEnd retrospective learning loop** runs BEFORE `deleteTracker`:
  - Files with `editCountsByFile[file] > ITERATION_COST_THRESHOLD` (default 5) produce an auto-pitfall: `"X required N edits in one session — read the file more carefully and plan the full change before editing next time."` Capped at `ITERATION_COST_MAX_PER_SESSION` (default 3) so a single thrashy session can't flood pitfall memory. Sorted by count DESC so the worst offenders land first when the cap is tight.
  - Smooth sessions (quality label `smooth`, steps completed > 0, NO iteration-cost pitfalls this session) mine up to `PATTERN_MINE_MAX_PER_SESSION` (default 2) winning patterns from `snapshot.approachNotes` via `extractWinningPattern` and store them as `kind='pattern'` memories.
  - The "no thrashy session → no pattern mining" gate prevents a session that needed 6 edits on one file from also claiming a winning pattern.
- **13 new tests** in `tests/north-star-phase3-learning-loop.test.ts` covering schema v22 accepting both new kinds, pattern+success gating, noise rejection (markdown headers, bullet lists, conversational openers, short text, very long recaps, generic status lines), and a positive example with clean build + adopted strategy.
- **New `LIMITS` constants:** `ITERATION_COST_THRESHOLD`, `ITERATION_COST_MAX_PER_SESSION`, `PATTERN_MINE_MAX_PER_SESSION`, `GOAL_MATCH_MIN_SIMILARITY`, `PRECISION_STRENGTHEN_INCREMENT`, `PRECISION_WEAKEN_FACTOR`.

### Added (North-Star Phase 2 — reassessment fix: cursor persistence)

- **Schema v21: `compaction_snapshots.last_edit_cursor TEXT`.** Reassessment after Phase 2 identified a gap: `session-end.ts` calls `deleteTracker(sessionId)` on clean /exit, wiping the cursor. Next session's startup briefing couldn't render "Resume:" because the tracker was gone. Fix: PreCompact + SessionEnd now serialize `tracker.lastEditCursor` into the snapshot as JSON. Session-start-handler reads the tracker first (still present on compact) then falls back to the most recent snapshot's `last_edit_cursor` (survives exit+return). Both INSERTs now have 18 placeholders and stay in lockstep (parity test in `north-star-phase2-resume-cursor.test.ts`).
- **Parity test** verifies PreCompact and SessionEnd INSERT column counts match, so the prior column-drift pitfall cannot recur silently.

### Added (North-Star Phase 2 — Resume cursor)

- **Last-edit resume pointer in the briefing.** After `/compact` or exit+return, the briefing renders `Resume: <basename>:<line> (<tool>, Nm ago)` so the next turn knows exactly where you left off. Populated by `success-tracker-handler` on every successful Write/Edit/MultiEdit PostToolUse. Line extracted by reading the file and locating the Edit anchor (`old_string` → `new_string` fallback); Write always resolves to line 1; MultiEdit uses the first edit. Read size-gated at 1 MB so huge generated files don't slow the hot path.
- **`ResumeCursor` type + `lastEditCursor` field in `EditTracker`.** Persisted alongside the rest of the tracker so it survives compaction via the existing disk-backed store. Shape: `{ file, line: number | null, tool, at }`. `line` is null when extraction fails (racing reformat, unreadable file); the cursor still carries file + tool + timestamp in that case.
- **Staleness gate in the briefing compiler.** `renderResumeCursor` suppresses cursors older than `LIMITS.RESUME_CURSOR_STALE_MS` (30 minutes) — a longer context switch is cheaper to resolve by re-reading than trusting a pointer. Also suppresses cursors pointing to files that no longer exist (e.g. `git clean` between sessions) and cursors with `at` in the future (clock skew guard). Both full and index briefing paths call the same helper so the logic stays in one place.
- **Session-start handler loads the cursor from the persisted tracker** into `BriefingContext.lastEditCursor`, passed through auto-mode dispatch so both `renderTier1` and `compileIndexBriefing` can emit it.
- **11 new tests** in `tests/north-star-phase2-resume-cursor.test.ts` covering: fresh cursor with line number, cursor with line=null, "just now" label for sub-minute cursors, stale cursor suppression, non-existent file suppression, null cursor, absent field (back-compat), compact-session rendering, clock-skew future-dated cursor, index-briefing parity, and default tracker shape.

### Added (North-Star Phase 1 — Goal continuity)

- **Sticky project goal across meta turns.** `compaction_snapshots` gains two columns (`project_goal`, `project_goal_source`) and `sessions` gains `project_goal`. Schema v20 migration is additive and idempotent. The new ambient goal slot is distinct from the per-turn `initial_goal` — it persists across SNR audits, `/compact`, and exit+return cycles so the briefing can surface "what this branch is FOR" even when the current turn is a side-quest. Priority chain: (1) transcript mine of `cairn_plan(create)`, (2) carry-forward from prior snapshot within the goal-scan window, (3) active plan name, (4) branch synthesis from `feat/*` / `fix/*` / bare branches enriched with the latest commit subject. Rendered as a source-labelled line: `Project goal:` (transcript/user), `Project goal (plan):`, or `Project goal (branch):` so Claude can weight confidence.
- **Branch-goal synthesizer** (`src/utils/branch-goal.ts`). Last-resort fallback that turns `feat/primary-memory-integration` into `"Primary memory integration"`, optionally enriched with a novel-token commit subject (`"User auth — Add email verification flow"`). Rejects base branches (main/master/dev), chore/ci/docs prefixes, and results shorter than 12 chars. Commit enrichment is skipped when the subject is a chore/wip/revert or adds no novel tokens.
- **`getLatestCommitSubject(cwd)`** helper in `src/utils/project-scanner.ts` (thin `execFileSync` wrapper with the same timeout + stdio posture as `getGitHash`). Used exclusively by the branch-goal synthesizer for enrichment.
- **Project goal loading in `session-start-handler.ts`.** Loaded into `BriefingContext.projectGoal` on both compact paths (from the resolved snapshot) and startup/clear paths (from a time-bounded lookup against prior sticky snapshots). Passed through the auto-mode dispatch so both `renderTier1` and `compileIndexBriefing` can render it.
- **Dedup against per-turn goal.** The new rendering dedups via token-set Jaccard (threshold `DECISION_DEDUP_JACCARD = 0.55`) so paraphrased duplicates collapse. Prevents the briefing from showing `Goal:` and `Project goal:` with essentially the same text.
- **Column parity between PreCompact and SessionEnd.** Both hooks now write the full 17-column `compaction_snapshots` shape (was 15). Mirrors the fix pattern from the prior `goal_branch` / `goal_carry_count` drift pitfall — the parallel INSERTs must stay in lockstep or briefing features silently disable.
- **`TranscriptSnapshot.projectGoal`** mined from `cairn_plan(create, name)` tool calls with last-write-wins semantics (most recent create beats earlier ones so plan pivots are respected).
- **23 new tests** in `tests/north-star-phase1-goal-continuity.test.ts` covering: branch-goal synthesizer edge cases (feat/fix/chore/main/bare/multi-segment/enrichment/commit-skip), schema-v20 column presence, startup-path rendering, compact-path rendering, source-aware labels (plan/branch/transcript), short-goal suppression, Jaccard dedup against per-turn goal, index-briefing path parity, and INSERT/SELECT round-trip for both `compaction_snapshots` and `sessions`.

### Fixed (SNR hardening — post-gap-closure leaks)

- **`isMetaGoal` now rejects synthetic "user stopped / interrupted" notices.** Observed in two consecutive SNR samples (pre- and post-compaction, both at ~80% signal): the single remaining noise source was a stale goal `"The user stopped the ultraplan session above. Do not respond to the stop notification — wait for the next message"`. Claude Code injects interrupt notices as plain-text user-role messages on Esc/stop/slash-command cancellation; they pass `isHumanMessage` (no XML tag) and the prior `isMetaGoal` patterns (no "continue"/"compact"/"proceed"). Fix: new `stopNoticePatterns` regex group in `src/hooks/shared/transcript-parser.ts` catches `^the user (stopped|interrupted|cancelled|halted|aborted|paused)`, `^request interrupted`, `do not respond`, `wait for (the|user|next) … (message|prompt|instruction|response|reply)`, and `stop(ped) (the )?(ultraplan|session|run|turn) … above`. Seven new tests in `tests/briefing-recovery.test.ts` cover the observed case, self-directives, and false-positive guards for real tasks mentioning "stopped".
- **`session-end.ts` snapshot INSERT was dropping `goal_branch` + `goal_carry_count`.** `precompact.ts` writes the 15-column snapshot shape but the parallel block in `session-end.ts` only wrote 13 columns, so final snapshots had `goal_branch = NULL` and `goal_carry_count = 0`. The briefing's `branchMismatch` gate requires `snap.goalBranch != null`, and the `carryCount >= GOAL_MAX_CARRY_COUNT` gate never triggers on 0 — both gates were silently disabled for SessionEnd-sourced snapshots, allowing stale goals to survive branch switches forever. Fix: `session-end.ts` now mirrors the PreCompact goal-continuity logic in full — reads `goal_branch` + `goal_carry_count` from prior snapshots on inheritance, computes `currentBranch` via `getGitWorkingState`, increments carry on inheritance, writes all 15 columns. New regression test `tests/session-end-goal-branch.test.ts` asserts the INSERT shape via source inspection (column presence, 15 placeholders, `getGitWorkingState` call, carry increment).
- **`compileIndexBriefing` goal path missed three of four staleness gates.** The full briefing (`renderTier1`) ran branch-mismatch + carry-count + completed-step-match (GAP E) + `isMetaGoal`, but the index briefing (compact-mode path, where stale goals are most visible) only ran `isMetaGoal`. A goal that slipped past the meta filter would surface unchecked in the compact briefing even if the branch had changed, the carry count was exhausted, or a done plan step had already satisfied it. Fix: extracted a shared `evaluateCarriedGoal(snap, plan, gitState)` helper in `briefing-compiler.ts` that runs all four gates and returns `{ text, label }`; both `renderTier1` and `compileIndexBriefing` now delegate to it. Label switches between `Goal:` (fresh/new) and `Previous goal:` (carried once). Five new tests in `tests/hook-gap-briefing-relevance.test.ts` cover branch mismatch, carry-count cap, completed-step overlap, synthetic-stop-notice rejection in index mode, and the happy path.

### Fixed (Hook-system gap closure A–K)

- **GAP A — hook-relay.c silent death on missing socket.** The C relay binary (invoked by every relay-routed hook) exited silently when `~/.cairn/hook-daemon.sock` was absent, turning pitfall-check, prompt-check, success-tracker, plan-bridge, error-learning, subagent-stop, and postcompact into no-ops during MCP server restart / crash / cold-boot race. Fix: source-controlled `src/hooks/hook-relay.c` now execs `node <script_dir>/<hook-type>.js` via fork+pipe on stat/connect failure, forwarding buffered stdin. Compile step added to `package.json` (`build:relay`). Tested via `tests/hook-gap-relay-fallback.test.ts` which spawns the binary with a fake `$HOME` and asserts the JS fallback ran with stdin forwarded; unknown hook names still silent-exit 0.
- **GAP B — `handlePostCompact` bypassed the `SessionCache` tracker.** The handler called `loadTracker`/`saveTracker` on the file directly, racing the 60-s cache flush and clobbering in-memory `injectedMemoryIds` / `surfacedPitfalls` that prompt-check and pitfall-check had just written. Fix: `handlePostCompact(input, client?)` prefers `client.cache.getTracker(sessionId)` and writes back via `cache.setTracker`; the socket route in `hook-socket.ts` now passes the shared `CachedHookContext`. Standalone cold-boot path still uses file I/O. Tested via `tests/hook-gap-postcompact-cache.test.ts` which verifies prior injected IDs survive and `lastCompactAt` is set.
- **GAP C + D — briefing path missed the same-project relevance gate and used a project-wide query fingerprint.** `renderTier2/3/4` and `compileIndexBriefing` only applied `passesCrossProjectGuard`; `passesSameProjectRelevance` (Phase 6d) was never invoked in the briefing path, and the queryFp was built from `projectContext` alone — no goal tokens, no recent-file tokens, no branch tokens — so every same-project memory trivially overlapped and the gate would have been toothless anyway. Fix: new `buildBriefingQueryFp(ctx, plan)` helper enriches the base fingerprint with (a) module tokens from `compactionSnapshot.recentFiles`/`recentReadFiles` basenames + path segments, (b) goal + plan-name + in-progress-step tokens (lowercase, stop-word filtered, ≥4 chars), (c) branch tokens. Both guards (`passesCrossProjectGuard` + `passesSameProjectRelevance`) now run on T2 decisions, T3 pitfalls, T4 corrections, and all three index-mode blocks, and the recovery pass in `session-start-handler.ts` reuses the same enriched fingerprint. Tests in `tests/hook-gap-briefing-relevance.test.ts`.
- **GAP E — goal staleness had no plan-step-completion signal.** `renderTier1` only suppressed goals on `branchMismatch || carryCount >= MAX`. A goal that paraphrased an already-done plan step stayed in the briefing as stale instruction. Fix: tokenise both the goal and each `done` step description with the shared `tokeniseForOverlap` helper; suppress the goal when any done step's token-set Jaccard against the goal ≥ `GOAL_STALE_JACCARD` (0.6). Tested in `tests/hook-gap-briefing-relevance.test.ts`.
- **GAP F — T1↔T2 decision dedup used prefix match.** `LIMITS.DECISION_DEDUP_PREFIX` cut off at a fixed byte count, so two decisions expressing the same idea with different leading phrasing ("Use X because Y" vs "Decided: use X — Y simpler") both survived. Fix: replace prefix compare with token-set Jaccard ≥ `DECISION_DEDUP_JACCARD` (0.55); prefix check kept as a cheap fast-path for exact matches. Tested in `tests/hook-gap-briefing-relevance.test.ts`.
- **GAP G — post-compact index briefing re-surfaced memories Claude already saw.** `compileIndexBriefing` ranked unconditionally by effectiveness, wasting the tight index budget on memories that were in context 5 minutes earlier. Fix: extend `BriefingContext.compactionSnapshot` with `alreadySurfacedMemoryIds?: string[]`, populated in `session-start-handler.ts` from the persisted `tracker.injectedMemoryIds` (which survives compaction via the edit-tracker file). In compact mode the index briefing over-fetches candidates and drops any matching IDs before slicing to `INDEX_MAX_*`. Only applied in compact mode — startup/clear briefings are unchanged. Tested in `tests/hook-gap-briefing-relevance.test.ts`.
- **GAP H — SessionStart standalone cold-boot path does not use `SessionCache` (verified no-op).** The cache lives in the MCP server process and cannot cross into a separate node process; on cold boot the cache would be empty anyway. Added a doc comment to `src/hooks/session-start.ts` explaining the intentional asymmetry so future readers don't try to "fix" it.
- **GAP I — subagent-stop and success-tracker plan notes duplicated on repeat fires.** Both handlers called `planRepo.addNote` unconditionally; long sessions accumulated dozens of identical `Verified: foo.ts (tests pass)` and subagent summary entries. Fix: compare the normalised new note (lowercase, whitespace-collapsed) against the last note on the in-progress step and skip the append when they match. Tested in `tests/hook-gap-plan-note-dedup.test.ts`.
- **GAP J — `plan-bridge-handler` hard-coded file I/O for the tracker.** On `ExitPlanMode` the handler called `loadTracker(sessionId)` and missed mid-session `Write` events still sitting in the in-memory cached tracker. Fix: accept `HookDbClient | CachedHookContext` and prefer `cache.getTracker(sessionId)`. Tested in `tests/hook-gap-plan-bridge-cache.test.ts`.
- **GAP K — prompt-handler missed the cross-project guard on recall paths.** `memoryRepo.recall` / `search` / `recallHybrid` filter by `(project = ? OR project IS NULL)`, so null-project globals (e.g. Odoo 19 pitfalls with no lang fingerprint) leaked into TS/Node projects via the task-intent injection path. Fix: `handlePromptCheck` now applies `passesCrossProjectGuard` against the already-computed `fp` after every recall/search path — task pitfall recall, task decision recall, question fact recall, broad auto-recall search, hybrid vector recall, proxy-embedding search, and reference surfacing. Tested in `tests/hook-gap-prompt-cross-project.test.ts`.

### Added

- **Phase 6d — same-project anchor/fingerprint relevance gate** (`passesSameProjectRelevance` in `src/utils/cross-project-guard.ts`). Phase 6a.2 closed the cross-project leak, but mid-session SNR was still dominated by intra-project irrelevance: a pitfall authored against `src/db/connection.ts` would fire on unrelated test edits because `FINGERPRINT.MIN_SCORE = 0.15` is trivially passed by same-lang, same-confidence matches. Gate admits a memory only when the current operation has a concrete relevance signal: (1) anchor match — the current `filePath` basename or full path appears in `memory.anchor`, or (2) module intersection — `memory.fingerprint.module ∩ queryFp.module` is non-empty. Broad memories (no module, no anchor) are symmetric — they surface only on broad queries (SessionStart, bare Bash, no module dim), never on file-specific edits. Wired into the two fingerprint recall paths in `pitfall-handler.ts` (pitfall path and decision path). 12 new tests in `tests/pitfall-same-project-relevance.test.ts` covering the regression case (connection.ts schema pitfall must not fire on `tests/plan.test.ts`), anchor basename match, db↔db module overlap, cross-module blocking, null-fingerprint blocking, broad↔broad symmetry, and module-only (tag-driven) recall.
- **`Memory.anchor`** is now surfaced from `rowToMemory` (previously the anchor JSON column existed but was not read back into the `Memory` interface). Required for the same-project relevance gate's anchor check.

### Fixed

- **Phase 6a.3 — `recoverDroppedPitfalls` correction pass was bypassing `passesCrossProjectGuard`.** Even after phase 6a.2, post-restart SNR measurement still showed 2 Odoo 19 items leaking into Cairn TS briefings via the `[!]` correction pass. Root cause: `memoryRepo.highImpactPitfalls()` SQL-filters `(project = ? OR project IS NULL)` with no fingerprint check, and `recoverDroppedPitfalls` fed the result straight into the output. High `impact_count` Odoo pitfalls (accumulated from pre-guard surfacings) rode the recovery path in. Fix: `recoverDroppedPitfalls` now accepts an optional `queryFp` parameter; when provided, results pass through both `passesCrossProjectGuard` and `passesSameProjectRelevance` before the token-budget check. `session-start-handler.ts` builds the fingerprint from `projectContext` and threads it through. 4 new tests in `tests/briefing-recovery.test.ts`: blocks Odoo null-project globals, preserves same-project recovery, allows lang-matching globals, and preserves legacy behavior when `queryFp` is omitted (backward compat).
- **SNR measurement (post-restart, this session briefing): 50% signal (10/20)**, regression from step 1's clean warm sample of 75%. Root causes identified and fixed: (a) `recoverDroppedPitfalls` bypass (above), (b) intra-project irrelevance from `FINGERPRINT.MIN_SCORE` floor trivially cleared by same-lang matches (addressed by Phase 6d gate above). Live evidence collected during implementation: editing `memory-repository.ts` fired `connection.ts` schema-migration + `LEARNABLE_ERROR_PATTERNS` pitfalls; editing `session-end.ts` fired `PostToolUse hook registration` pitfall — zero task relevance for any of them. Phase 6d blocks all three.

### Fixed (Phase 6a.2)

- **Phase 6a.2 — briefing path now enforces the cross-project guard.** Phase 6a only patched the runtime injection path (`pitfall-handler.ts`); the briefing path (`briefing-compiler.ts` → `topPitfalls` / `topDecisionsRanked` / `activeCorrections`) still leaked null-fingerprint global memories into unrelated projects. Live SNR re-measurement showed 3 Odoo 19 items (2 pitfalls + 1 decision) surfacing in a Cairn TS startup briefing despite phase 6a tests passing. Fix: extracted `passesCrossProjectGuard` into `src/utils/cross-project-guard.ts` (re-exported from `pitfall-handler.ts` for backward compat) and applied it at all four briefing-compiler call sites — `renderTier2` (decisions), `renderTier3` (pitfalls, with 2× over-fetch so the post-filter slice still respects `pitfallCount`), `renderTier4` (corrections — replaces the prior soft `overlap > 0` check with the strict `>= CROSS_PROJECT_MIN_OVERLAP` threshold), and the INDEX-mode path (decisions/pitfalls/corrections). Falls back to legacy behavior when no `projectContext` is supplied. 6 new tests in `tests/briefing-cross-project-guard.test.ts` cover same-project pass-through, null-fingerprint Odoo blocking, overlap pass-through for global TS pitfalls, decision/correction blocking, INDEX-mode enforcement, and the missing-projectContext fallback. Full suite: 1013/1013.

### Added

- **Cross-project fingerprint overlap guard** (`passesCrossProjectGuard` in `pitfall-handler.ts`) — same-project memories pass unconditionally. Cross-project (global → current project) memories must have (a) a non-null fingerprint AND (b) pure `fingerprintOverlap` ≥ `PROACTIVE.CROSS_PROJECT_MIN_OVERLAP` (0.2, exactly the `LANG` dimension weight) with the current query fingerprint. Applied to the pitfall fingerprint recall path, the pitfall anchor recall path, the decision anchor recall path, and the decision fingerprint recall path. Prevents e.g. Odoo 19 global pitfalls (`kanban_image`, `website.snippets`, `ir.cron numbercall`, `useService("user")`, `settings view app name`) from leaking into Cairn TypeScript sessions via FTS content matches on common English words. 18 new tests in `tests/pitfall-cross-project-guard.test.ts` covering same-project pass-through, null-fingerprint blocking, overlap threshold boundary cases, and the Odoo 19 regression fixtures.
- **Session-aware warning cooldown** (A1 recent-failure, A2 edit-fail loop, A3 rapid re-edit) — new `PROACTIVE.WARNING_COOLDOWN_MS` (60 s) and `EditTracker.recentWarningFired` map keyed by `"<type>:<file>"`. Each warning fires at most once per 60 s per file, preventing flood on consecutive edits of the same file. Cooldown keys are included in `sessionStateHash` so the skip-gate cache invalidates on fire; stale entries are pruned each call at 2× cooldown. 6 new tests in `tests/pitfall-warning-cooldown.test.ts` covering first-fire, suppression within window, re-fire after expiry, per-file isolation, A1 behavior, and pruning.
- **95 new `isReadOnlyCommand` tests** in `tests/pitfall-readonly-command.test.ts` covering the expanded allowlist.
- **`isReadOnlyCommand` and `passesCrossProjectGuard` are now exported** from `pitfall-handler.ts` for unit testing.

### Fixed

- **`defaultTracker()` factory replaces shared `DEFAULTS` constant** in `edit-tracker.ts` — previously `loadTracker` did `{ ...DEFAULTS, toolChain: [], surfacedPitfalls: {} }`, a shallow spread that left `recentlySurfaced`, `sessionErrorCounts`, `injectedMemoryIds`, `successDedup`, and `briefingEffectiveness` aliasing the same module-level objects across every tracker. Any mutation of those fields (e.g., recording a surfaced pitfall) poisoned every subsequent `loadTracker` call in the same process. Latent bug that only surfaced when a new cooldown map was added in phase 6b; fix: factory function returning fresh containers on every call.
- **`isReadOnlyCommand` allowlist was too narrow** — read-only Bash commands like `sqlite3 ... SELECT`, `grep`, `rg`, `find`, `jq`, `tree`, `ps`, `sort`, `node -v`, `npm ls`, `tsc --noEmit` were falling through the gate and running the full fingerprint pipeline, surfacing unrelated code-edit pitfalls on pure investigation commands. Measured SNR impact: mid-session pitfall stream dropped to 0% signal on a telemetry-analysis session.
- **Allowlist now splits on `&&` / `||` / `;` / `|`** and requires every sub-command to be read-only (so `cd /opt/cairn && ls` works). Strips leading env-var assignments, `sudo`, `time`, `nice`, `nohup`. Strips string literals and heredoc bodies before splitting so `;` inside SQL or quoted args no longer splits commands incorrectly.
- **`sqlite3` special case** — classified read-only unless the command contains write keywords (`INSERT`, `UPDATE`, `DELETE`, `CREATE`, `DROP`, `ALTER`, `REPLACE`, `ATTACH`, `VACUUM`, `REINDEX`, `BEGIN`, `COMMIT`, `ROLLBACK`) or dot-commands (`.import`, `.restore`, `.backup`, `.read`, `.load`, `.save`, `.output`, `.once`, `.shell`, `.system`). Check runs on the original (unsanitized) command line so write keywords inside quoted args are still caught.
- **`find` special case** — classified read-only unless the command contains `-delete`, `-exec`, `-execdir`, `-fprint`, or `-ok` flags.
- **Stale `connection.js` pitfall invalidated** — `pit:13263723` claimed `/opt/cairn/src/db/connection.js` was missing, but the file is `connection.ts` and the `.js` import path is correct ESM+TypeScript resolution. The pitfall had been surfacing 14 times and gaining confidence (0.905) from unrelated success signals — a classic success-tracker feedback loop on a misphrased warning.
- **Stale `better-sqlite3` pitfall invalidated** — `pit:830abfec` flagged a missing `better-sqlite3` module, but the dependency is present in `package.json`.

### Added

- **95 new tests** in `tests/pitfall-readonly-command.test.ts` covering the expanded allowlist: classic commands, investigation tooling (grep/rg/find/jq/tree/ps/sort), language version/list commands, `sqlite3` read-vs-write classification (including heredocs and dot-commands), `find` flag rejection, compound commands with `&&`/`||`/`;`/`|`, env-var/sudo/time prefixes, and negative cases (`rm`, `mv`, `npm install`, `git commit`, `curl POST`).
- **`isReadOnlyCommand` is now exported** from `pitfall-handler.ts` for unit testing.

## [5.0.0] - 2026-04-10

### Performance + Architecture: Hook Socket, Skip Gates, Fast Token Estimator

The v5 release is a performance-focused rewrite of Cairn's hot path. Real 24 h telemetry showed `pitfall-check` averaging 1,113 ms per call over 526 invocations and `session-start` averaging 13.5 s over 10 invocations — most of the lag coming from a single tokenizer call that dominated briefing compilation. v5 attacks both with measured, SNR-preserving changes.

#### Added

- **Embedded hook socket** (`src/mcp/hook-socket.ts`) — replaces the standalone `hooks/daemon.ts`. Runs inside the MCP server process, sharing the DB connection (~74 MB RAM saved) and enabling in-process skip-gate invalidation with a staleness bound of zero.
- **`SessionCache.memoryVersion`** — monotonic counter bumped by MCP write tools (`cairn_learn`, `cairn_correct`, `cairn_forget`, `cairn_weaken`, `cairn_strengthen`, `cairn_promote`, `cairn_cleanup`, `cairn_ingest`), `cairn_plan` create/step/decide/note/complete, `cairn_remind`/`cairn_reminder_delete`, and the error-learning handler's auto-pitfall creation path. Metric-only updates (`incrementSurface`, `incrementImpact`) intentionally do NOT bump to avoid self-invalidating the cache.
- **Skip-gate cache** on `SessionCache` — per-hook cached output with composite key (hook + tool + filePath + memoryVersion + sessionStateHash + contextMode) and 60 s hard TTL. Null outputs from `pitfall-handler` and `prompt-handler` are served from cache in <1 ms instead of running the full handler.
- **`estimateTokensFast(text)`** — char-based approximation (~microseconds/call) replacing `@anthropic-ai/tokenizer.countTokens` (~130 ms/call warm, 783 ms cold) in the hot path. Real tokenizer is still used for the final `truncateToTokenBudget` safety net where exact precision matters.
- **FTS + fingerprint-score cache** for `recallByFingerprint` in `pitfall-handler` — candidate memory IDs cached per (fingerprint + kind + project + query) with 30 s TTL; per-(memoryId, queryFpKey) overlap scores cached session-lifetime. Mutable fields (confidence, surface_count, impact_count, last_recalled, invalidated) are re-fetched live via `findById` on every cache hit so no stale authority state is served.
- **Progressive-disclosure index briefing** — `compileIndexBriefing()` in `briefing-compiler.ts` emits a compact structured index with stable type-coded ID prefixes (`dec:xxxxxxxx`, `pit:xxxxxxxx`, `cor:xxxxxxxx`, `inv:N`). Auto mode picks full on startup/clear and index on compact/resume, following the claude-mem and Anthropic Skills progressive-disclosure pattern.
- **`cairn_expand` MCP tool** — takes up to 10 memory IDs from the index briefing and returns full content + `why` + `how_to_apply` + confidence + surface/impact counts. Same SNR gates as `cairn_recall` (no invalidated, quality-filtered). Requires `MemoryRepository.findByShortId(prefix)` which resolves 8-char IDs from the briefing index back to full rows.
- **`handleSessionStart` pure handler** — `session-start.ts` business logic extracted into `src/hooks/handlers/session-start-handler.ts`. Same behavior as before, but runs in-process via the embedded hook socket when available, sharing the session cache. Standalone direct-`node` fallback preserved for cold-boot.
- **`/session-start` route** in `hook-socket.ts` and added to the sync-hooks list in `hook-relay.sh`.
- **Project context cache** — `SessionCache.setProjectContext` is now wired after every `contextRepo.get()` in pitfall, prompt, error-learning, and session-start handlers. Eliminates the repeat DB round-trip on warm calls.
- **20 new tests** covering SessionCache skip gates (9), fast token estimator (5), pitfall-handler skip-gate integration (5), progressive disclosure briefing + `findByShortId` (9).

#### Changed

- **Briefing compile time** dropped from 2,200–4,760 ms to **9–13 ms** (200–500× speedup) via the `estimateTokensFast` swap in `briefing-compiler.ts`. Every in-loop `estimateTokens` call was replaced — 11 hot-loop call sites + `truncateToTokenBudget` safety net. Authoritative `estimateTokens` is still exported for external callers that need exact counts.
- **Session-start wall time** dropped from ~13.5 s avg to ~1–2 s warm, ~2–3 s cold on direct-`node` runs. Measured with per-phase instrumentation; the chunk 5 tokenizer fix accounted for the majority of the gain.
- **Test suite runtime** dropped from ~29 s to ~7.5 s as a side effect of the tokenizer fix (briefing tests were doing hundreds of real tokenizer calls). Total runtime after v5 additions is ~22 s.
- **`pitfall-check` no longer fires on `Read` tool** — removed `'Read'` from `PROACTIVE.TOOLS` and `PITFALL_CHECK_TOOLS`, removed the Read-mode early-exit and three `isReadTool` branches in `pitfall-handler.ts`. Read was a read-only op with no mutation risk, so firing the full pitfall check was ~30 % of hook overhead for essentially no SNR value.
- **`SessionCache` creation moved to `server.ts`** — single instance is now shared between the MCP tool handlers (for write-time version bumping) and the embedded hook socket (for hot-path reads). `startHookSocket()` takes the cache as an optional second argument.
- **`registerMemoryTools`, `registerPlanTool`, `registerReminderTools`, `registerPortabilityTools`** all accept an optional `SessionCache` parameter for bump wiring.
- **`~/.claude/settings.json`** — `success-tracker` (PostToolUse), `error-learning` (PostToolUseFailure), and `stop-failure` (StopFailure) marked `async: true`. These are write-only handlers whose effects land in the next hook, so async is safe and their tail-latency spikes stop blocking turns.

#### Removed

- **`src/hooks/daemon.ts`** — 366 lines of dead code. `killStaleDaemon()` in `hook-socket.ts` explicitly terminates any running standalone daemon on MCP startup. Historical comment preserved in `hook-socket.ts` for the why.
- **Diagnostic `_phase` instrumentation** from `session-start.ts` — added temporarily in the v5 investigation to pinpoint the tokenizer hotspot, removed after the fix landed.

#### Fixed

- **Correction-to-inject staleness bound is now zero** via the memoryVersion → skip-gate invalidation path. Any MCP write tool bumps the version in the same JavaScript object the hook handlers read, so the next hook call after a `cairn_correct` / `cairn_weaken` / `cairn_forget` sees fresh memory state without IPC or polling.
- **`setProjectContext` dead-code hole** — the getter was used in all three handlers but the setter was never called, so every call hit the DB. Wired all three handler paths.
- **TypeScript unused-variable artifacts** in the Read-removal cleanup — `isReadTool`, the Read mode early-exit, and the Read-specific `maxPitfalls` branch.

#### SNR Protection

All v5 caching is **structurally SNR-safe**:
- `memoryVersion` is bumped only by writes that change memory content or authority — metric updates (surface_count, impact_count) flow through without invalidating the cache, so the hot path actually gets hits.
- Skip-gate cache is **null-output-only** in both pitfall and prompt handlers. Non-null outputs always run the full handler so cooldown enforcement and flag-based once-per-session logic stay correct.
- FTS candidate cache stores memory IDs only. Mutable fields are re-fetched via `findById` on every cache hit.
- Fingerprint overlap scores are deterministic (same fingerprints → same score) so session-lifetime caching is safe.
- The briefing compiler still queries live DB state on every call; `estimateTokensFast` only changes *how* tokens are counted, not *which* memories are included or how they're ranked.

#### Measurements

| Metric | v4.2.5 | v5.0.0 | Delta |
|---|---|---|---|
| Briefing compile (in-process) | 2,200–4,760 ms | 9–13 ms | **200–500× faster** |
| Session-start wall time (warm) | ~3–4 s | ~1–2 s | ~2× faster |
| Session-start wall time (cold) | ~13 s | ~2–3 s | ~5× faster |
| Test suite runtime | ~29 s | ~22 s | 24% faster |
| Test count | 864 | **893** (+29) | — |
| Correction → next-inject staleness | DB poll | **in-process, zero latency** | — |

#### Migration notes

- **No schema migration.** v5 is additive infrastructure; all SQLite schema is unchanged.
- **Backward compatibility:** `BRIEFING_MODE.DEFAULT` is `'full'`, so existing direct `compileBriefing` callers see no behavior change. Only `session-start-handler` opts into `'auto'` mode, which uses the full format on startup/clear and the index format on compact/resume.
- **Hook wiring:** `~/.claude/settings.json` async flags are optional — v5 works with or without them. Applying them is recommended for the tail-latency benefit.

## [4.2.5] - 2026-04-05

### Briefing Goal & Approach Budget Increase

#### Changed
- Goal distillation limit raised from 120 to 500 chars — goals no longer truncated mid-sentence
- Goal extraction limit raised from 300 to 500 chars to match
- Approach rendering budget raised from 200 to 500 chars — approach notes render fully instead of truncating
- Approach extraction wired to `TOKEN_BUDGET.APPROACH_NOTE_MAX_CHARS` constant (was hardcoded 400, now 600)
- `BRIEFING_GOAL_MAX_CHARS` 300→500, `BRIEFING_APPROACH_MAX_CHARS` 200→500

## [4.2.4] - 2026-04-04

### Cross-Hook Briefing Dedup

#### Fixed
- UserPromptSubmit hook re-injecting decisions, pitfalls, and corrections already shown in the session briefing
- `compileBriefing()` now returns `renderedMemoryIds` — all memory IDs rendered across tiers 2-4
- `session-start.ts` seeds `tracker.injectedMemoryIds` with briefing IDs so downstream hooks skip them

### Investigation Chain Quality Gate

#### Fixed
- Generic "Exit code N" investigation chains rendering as truncated noise in briefings
- Added render-time quality filter in `briefing-compiler.ts` — skips chains with generic triggers
- Invalidated generic "Bash error: Exit code 1" pitfall (zero learning value)
- Cleaned up 4 garbage investigation chains from DB

## [4.2.3] - 2026-04-04

### Goal Staleness Detection: Branch Tracking + Carry Counter

#### Added
- Goal staleness detection via two cheap signals: git branch comparison and inheritance carry counter
- `goal_branch` column in compaction_snapshots — records the branch where a goal originated
- `goal_carry_count` column — increments each time a goal is inherited without reinforcement
- Graduated goal rendering: fresh (carry=0) → "Goal:", tentative (carry=1) → "Previous goal:", stale (carry≥2 or branch mismatch) → omitted
- Schema v19 migration for new columns
- 5 new tests: fresh/carried/stale/branch-mismatch/pre-v19 backward compat

#### Fixed
- Stale goals from previous sessions persisting in briefings (e.g., "Find out why #12 is not rendering" shown while working on SNR analysis)

## [4.2.2] - 2026-04-04

### Goal Distillation: Vague Completion Detection + Filler Stripping

#### Added
- `isMetaGoal()` detects vague completion directives ("just complete the task", "fix all issues", "finish everything", "just do it") — prevents them from persisting as task goals
- `distillGoal()` iterative filler prefix stripping — handles chained fillers ("let's just so please...") and mid-sentence "so ple"/"so please" typos
- 9 new tests: vague completion detection (5), filler stripping (4)

#### Fixed
- Stale goal "Just complete the task so ple fix all issue" rendered in briefing — now detected as meta-goal and stripped by improved distillation

## [4.2.1] - 2026-04-04

### SNR Hardening: Meta-Reasoning Filter, Investigation Chain Quality, Error Recency

Four targeted fixes eliminate remaining briefing noise sources, pushing SNR from ~78% to ~95%.

#### Added
- `isMetaReasoning()` filter — skips hypothesis/question extraction from text containing backticks, regex syntax, or quoted strings (prevents self-referential noise when discussing reasoning patterns)
- `isMetaGoal()` broadened patterns — detects SNR-target goals ("bring up our snr to 95%", "raise SNR to 100") as meta-goals to prevent them from persisting as task goals
- 17 new tests: meta-reasoning filter (6), multiline+resolution (8), approach note filter (3), isMetaGoal (5)

#### Changed
- Error context extraction uses temporal recency — only errors from the second half of collected outputs are kept, preventing stale early errors from persisting across compactions
- `isApproachNote()` rejects debugging conclusions ("found it", "the bug was") and text with code artifacts (backticks, regex syntax)
- Investigation chain creation uses `classification.errorKey` (normalized error type) as trigger instead of raw error output first line — produces readable briefing entries like "TypeError: Cannot read..." instead of "Exit code 1"
- Investigation chain approach string omits file reference when no file is extractable — shows "Bash" instead of "Bash on unknown"

#### Fixed
- Meta-reasoning self-reference noise — hypothesis extraction no longer triggers on text discussing its own regex patterns or code
- Stale error persistence — old errors from early in a session no longer crowd out recent errors after compaction
- Investigation chain rendering truncation — chains now store meaningful trigger errors and approach descriptions

## [4.2.0] - 2026-04-04

### DRY Write Gateway, Pitfall Scoping, Sentence-Level Reasoning Extraction

Three quality improvements: deduplicated write gateway code, precision pitfall scoping to eliminate cross-language false positives, and redesigned reasoning state extraction with multiline support and resolution detection.

#### Added
- `storeMemory()` private gateway — shared smart-merge logic for both `storeDecision()` and `storePitfall()`, eliminating ~70 lines of duplicated code
- `LANG_MISMATCH_PENALTY` constant (0.5) — applied when query and memory have known but disjoint `lang` dimensions
- Doc-file fingerprint skip — `.md`, `.txt`, `.rst`, `.adoc`, `.mdx` files skip fuzzy fingerprint recall, only anchor-based recall applies
- Sentence-level `extractReasoningState()` — joins multi-line text before splitting on sentence boundaries, enabling hypothesis/question extraction from paragraphs
- Resolution detection — hypotheses/questions resolved in later assistant text (via "confirmed", "the bug was", "found that" + keyword overlap) are automatically excluded
- 5 new reasoning patterns: `probably because`, `still need to understand`, `must investigate`, `have to determine`, `it appears as though`
- 9 new reasoning state tests (multiline extraction, resolution filtering, mixed resolved/unresolved)
- 3 new write gateway tests (shared merge behavior, default confidence, anchor preservation)

#### Changed
- `storeDecision()` and `storePitfall()` are now thin wrappers over `storeMemory()` — zero behavioral change for callers
- `multiSignalScore()` applies lang-mismatch 0.5x penalty when both query and memory have non-empty, disjoint `lang` arrays
- Pitfall-check hook restructured: fingerprint recall, anchor recall, and decision recall are now independent blocks instead of nested inside one `if`
- `extractReasoningState()` patterns use `[^.;!?]{10,}` (sentence-boundary aware) instead of `.{10,150}?` (which couldn't cross newlines)

#### Fixed
- Cross-language pitfall false positives — typescript pitfalls no longer surface when editing markdown files
- Multi-line reasoning extraction — hypotheses spanning multiple lines (e.g., "I think the issue is in\nthe normalization layer") are now captured correctly
- Resolved questions persisting as "open" — questions answered in later assistant text are now filtered out via keyword-overlap resolution detection
- Fragment capture in reasoning state — sentence-level extraction produces complete clauses, not mid-sentence fragments

## [4.1.0] - 2026-04-04

### Write Gateways, Reject-by-Default Error Capture, Dynamic Briefing Budget, SNR ~97%

Three architectural improvements plus SNR hardening. Write gateways unify fragmented storage paths, reject-by-default eliminates error noise at capture time, dynamic budget adapts briefing size to context pressure, and four targeted fixes push SNR from ~81% to ~97%.

#### Added
- `storeDecision()` write gateway — unified decision storage with smart merge: source authority (user>confirmed>corrected>learned), confidence max(boosted, incoming), content length preference, tag union, context gap-fill, fingerprint enrichment, embedding backfill
- `storePitfall()` write gateway — identical smart merge for pitfall storage, with anchor preservation
- `StoreDecisionInput` and `StorePitfallInput` interfaces in memory-repository
- `SOURCE_AUTHORITY` constant — ranked authority for memory source types
- `BRIEFING_BUDGET` constants — STARTUP_MAX:3000, COMPACT_MAX:2000, MINIMAL_MAX:1200, CRITICAL_MAX:600
- `budgetOverride` parameter on `BriefingContext` — allows dynamic budget to thread through compilation
- `isCompletedDecision()` — render-time filter for historical completion language ("all implemented and verified in vX.Y")
- Plan parser rejection patterns — shebangs, encoding declarations, source code, comments rejected as plan names
- Plan bridge `SOURCE_EXTENSIONS` guard — skips `.py`, `.ts`, `.js`, etc. when scanning for plan files
- TS6133/TS6196 transient warning filter in briefing error rendering
- 4 new `LEARNABLE_ERROR_PATTERNS`: npm, build, Python runtime errors, process exit codes
- 5 new plan-bridge tests (encoding declarations, shebangs, source code, comments)
- 6 new briefing-recovery tests (stale error filtering, completed decision filtering)
- 12 new memory tests (`storeDecision` + `storePitfall` smart merge)
- 4 new error capture tests (reject-by-default, LEARNABLE patterns, NOISE patterns)

#### Changed
- `isLikelyErrorOutput()` rewritten from permissive (accept anything with "error/fail/exception") to reject-by-default (accept only known `LEARNABLE_ERROR_PATTERNS`). Exported for testing
- 6 decision storage callers migrated to `storeDecision()`: error-learning, precompact, prompt-check, session-end, stop, plan-tool
- 3 pitfall storage callers migrated to `storePitfall()`: error-learning, stop-failure, memory-tools
- Session-start briefing budget now dynamic — computed from `readState().freeUntilCompact`, replaces all 6 hardcoded `TOKEN_BUDGET.BRIEFING_MAX` references
- T2 decision rendering applies `isCompletedDecision()` filter alongside effectiveness threshold
- `AssertionError|AssertionError` duplicate in LEARNABLE_ERROR_PATTERNS fixed to single `AssertionError`
- Schema version bumped from 17 to 18
- Briefing error filters marked as defense-in-depth (expected unnecessary after reject-by-default capture)
- Cross-tier dedup marked as defense-in-depth (expected unnecessary after storeDecision gateway)

#### Fixed
- Cross-project plan contamination — plan parser fallback no longer accepts source code, shebangs, or encoding declarations as plan names; bridge no longer scans `.py`/`.ts`/`.js` files for plan content
- Stale TS6133/TS6196 "declared but never read" warnings no longer persist through compaction into briefings
- Completed historical decisions ("all implemented and verified in v2.8.0") no longer compete with active decisions in briefing
- Error capture false positives eliminated — generic text containing "error" no longer captured unless it matches a known pattern

## [4.0.1] - 2026-04-04

### SNR Optimization — Briefing Noise ~68% → ~93%

Fifteen fixes across four iterative sessions targeting signal-to-noise ratio in the session-start briefing. Zero actual noise remains; residual ~7% is low-value-but-not-harmful content.

#### Added
- Cross-tier decision dedup — 40-char normalized prefix signature comparison prevents T1 (plan/snapshot) and T2 (memory DB) from rendering the same decision twice
- `DECISION_DEDUP_PREFIX` constant (40) for cross-tier signature length
- `supersededIds()` in EdgeRepository for querying superseded memories
- `filterSuperseded()` in MemoryRepository — filters out decisions replaced by newer ones via `supersedes` edges
- `isLikelyErrorOutput()` — smarter error detection rejecting source code false positives (line-numbered output, code declarations)
- Defense-in-depth error filters: vitest/jest summary lines, Unicode test symbols, progress bars, success messages, `dist/` artifacts
- `isApproachNote` summary/documentation rejection — rejects recap openers, "All changes/fixes" summaries, markdown-header structured reports
- Approach note markdown stripping — `##`, `**`, backticks flattened to clean single-line text
- `errorText` field preserved alongside `errorKey` for human-readable briefing error display
- 4 new tests for vitest summary filtering and cross-tier decision dedup
- 6 new tests for summary/documentation rejection in approach notes

#### Changed
- `LOW_EFFECTIVENESS_THRESHOLD` raised from 0.1 to 0.25 — excludes low-value memories from briefing
- `topDecisionsRanked()` uses composite score with temporal decay (`COALESCE(last_recalled, created_at)` × 0.15 decay) instead of flat `impact > confidence > recency` ordering
- `computeEffectiveness()` applies age penalty to never-surfaced memories (halves every 30 days) — stale unproven decisions no longer compete with recent ones
- `extractReasoningState()` limited to last 15 assistant texts — resolved questions no longer persist as "open"
- `renderTier4` fetches 6 correction candidates (up from 3) then applies fingerprint overlap filtering before slicing to 3 — global corrections from other projects no longer leak in
- `isApproachNote` exported from transcript-parser.ts (was internal) — test file uses real implementation instead of duplicated copy
- Error capture in `parseTranscript` uses `isLikelyErrorOutput()` instead of raw regex

#### Fixed
- Vitest summary lines ("Test Files  2 failed") no longer appear as errors in briefing
- Duplicate decisions no longer rendered in both "Decisions:" (T1) and "Prior decisions:" (T2) sections
- Mangled `errorKey` dedup keys no longer shown to user — `errorText` (original first line) used instead
- Source code containing "error" in identifiers no longer captured as error output
- Global corrections with non-matching fingerprints no longer appear in briefing

## [4.0.0] - 2026-04-03

### Cairn v4.0 — Decision-Centric Memory with Tier-Based Briefing

Seven-phase upgrade shifting Cairn from pitfall-heavy to balanced memory. Decisions, reasoning chains, and pitfalls are now complementary tiers with equal treatment.

#### Added
- **Tier-based briefing allocation** — T1 (plan+goal+git+user), T2 (decisions, 500 token budget), T3 (pitfalls, 500 token budget), T4 (corrections, 150 token budget). Cascading budget prevents any tier from starving another (Phase 1)
- **Investigation chain tracking** — `investigation_chains` table stores debugging sequences as coherent chains: trigger → attempts → resolution. Auto-created on errors, auto-resolved on success patterns. Surfaced in briefings and PreToolUse warnings (Phase 2)
- **Action-triggered chain surfacing** — PreToolUse now surfaces active/resolved investigation chains when editing files, alongside existing pitfall and decision recall (Phase 3)
- **Structured user model** — `user_model` table with queryable dimensions (role, expertise, preference, team, style). Auto-populated from user messages via regex extraction. Renders as compact one-line `User:` in briefings instead of multi-line free-text list (Phase 4)
- **Reasoning state snapshots** — `reasoning_state` and `error_context` columns on compaction snapshots. Mines hypotheses ("I think/suspect") and open questions ("need to check/verify") from assistant text. Renders in compact briefings (Phase 5)
- **Goal distillation** — `distillGoal()` strips filler prefixes ("we need to", "let's start", "please"), capitalizes, caps at 120 chars. Applied in both parseTranscript and precompact goal inheritance (Phase 5)
- **Automatic confidence calibration** — `PREDICTION_VERIFIED_BOOST` (0.08) replaces generic boost when surfaced pitfall leads to success. Double impact credit when surfaced pitfall correctly predicted an error that occurred. Two-tier temporal decay: 30+ days × 0.95, 90+ days × 0.85, floor at 0.15 (Phase 6)
- **Ultra-compact project context** — `formatProjectContextCompact()` merges tech stack + structure into single `Stack:` line on startup. Project context skipped entirely on compact sessions, freeing ~60 tokens (Phase 7)
- `InvestigationRepository` — CRUD for investigation chains with 10-attempt cap, session scoping, cleanup
- `UserModelRepository` — upsert with evidence counting, structured profile rendering, confidence decay
- `topDecisionsRanked()` — multi-signal ranked query (impact > confidence > recency) for tier-based briefing
- `decayStaleConfidence()` — temporal decay during startup maintenance for memories not surfaced in 30+/90+ days
- `extractReasoningState()`, `extractErrorContext()` — transcript mining functions
- `extractProfileDimensions()` — structured dimension extraction from user profile messages

#### Changed
- Briefing compiler refactored from sequential append to 4 tier renderers with cascading token budgets
- `BRIEFING_MAX_DECISIONS` increased from 3 to 8 (tier budget controls actual rendered count)
- `PROACTIVE.MAX_DECISIONS` increased from 1 to 2 for PreToolUse
- `computeEffectiveness()` now applied to decisions (was pitfalls-only)
- Success tracker uses `PREDICTION_VERIFIED_BOOST` (0.08) instead of generic `BOOST_INCREMENT` (0.05)
- Error learning distinguishes correct-prediction-ignored (double impact) from irrelevant-pitfall (weaken)
- Schema version bumped from 14 to 17 (v15: investigation chains, v16: user model, v17: reasoning state)

#### Fixed
- Investigation chains render even when no DB decisions exist (early return bug in T2 renderer)
- SNR quality gates from v3.3.1: meta-goal patterns, correction anti-patterns, extraction quality gate, render-time filter

## [3.3.0] - 2026-04-03

### Infrastructure Wiring — Connecting Existing Subsystems

Focused on wiring underutilized infrastructure together rather than adding new features. Every change is either a hook, background process, or side-effect of existing actions — nothing depends on voluntary tool calls.

#### Added
- Embedding-enhanced memory consolidation — blends cosine similarity (50%) with token overlap (20%) and temporal proximity (30%) for better semantic clustering
- Cross-kind `informs` edges auto-created on `cairn_learn` when new memory is semantically similar to existing memory of different kind (cosine >= 0.6)
- Co-recall pair promotion to `co_occurred` edges during maintenance (co_count >= 3)
- Quality-gated predictions — `predictRelated()` now filters by minCoCount and prefers kind-matched results based on user intent
- Regex-based error distillation — 9 pattern matchers for TypeScript, Python, Node, SQLite, Edit errors. Replaces raw error dump in auto-created pitfalls
- Memory version history — `memory_versions` table preserves old content on `cairn_correct(update)` (schema v14)
- Quality-adaptive briefing — previous session quality adjusts pitfall count ("stuck" +2, "smooth" -1)
- Briefing effectiveness tracking — passive measurement of post-compaction recovery quality via telemetry
- StopFailure hook — learns from API errors (rate_limit, max_output_tokens, server_error), creates actionable pitfalls
- `MemoryRepository.getEmbedding()` — fetch raw embedding buffer for cosine comparison without model
- `MemoryRepository.getVersionHistory()` — retrieve correction history for a memory
- `PREDICTION` constants — centralized configuration for co-recall prediction quality gates
- `CONSOLIDATION.EMBEDDING_WEIGHT` and `TOKEN_OVERLAP_WITH_EMBEDDING` constants

#### Changed
- `computeAffinity()` accepts optional `embeddingSimilarity` parameter for embedding-enhanced clustering
- `findConsolidationCandidates()` accepts optional `EmbeddingSimilarityMap` for pre-computed similarities
- `distillError()` now uses regex distillation as primary path with MCP sampling as upgrade
- `extractLesson()` removed from error-learning — replaced by `regexDistillError()`
- Schema version bumped from 13 to 14

## [3.2.0] - 2026-03-30

### Tier 5 Mastery — Condition Engine, Precision Ranking, Branch Prediction, Sampling Prep

#### Conditional Reminder Engine
- New `condition-evaluator.ts` — whitelist-based, non-Turing-complete DSL for conditional reminders
- Two-tier syntax: shorthand tags (`tests_pass`, `plan_complete`) + parameterized (`branch:feat/*`, `file:auth.ts`, `step_done:3`, `error_count:>=3`)
- Flat AND/OR/NOT composition: `tests_pass AND branch:main`, `NOT mode:critical`
- Safety: max 200 chars, bounded identifiers, `hasOwnProperty` guard, no eval/Function
- `checkConditionalReminders()` wired into pitfall-check and session-start hooks

#### Precision-Based Ranking Signal
- 6th signal in `multiSignalScore()`: proven impact ratio (`impact_count / surface_count`)
- Weights rebalanced to 6 signals summing to 1.0: fingerprint 0.20, vector 0.20, content 0.20, confidence 0.15, recency 0.10, precision 0.15
- High-impact memories now rank higher than unproven ones even with equal confidence

#### Branch-Aware Prediction
- Git branch tokens injected into query fingerprint `module` dimension in pitfall-check
- Branch names like `feat/auth-refactor` extract meaningful tokens (`auth`, `refactor`) for context-aware retrieval
- Common branch prefixes (feat, fix, chore, main, dev) filtered as noise

#### MCP Sampling Preparation
- New `distillation.ts` — capability-gated `distillError()` that will use `server.createMessage()` when Claude Code ships MCP sampling support (Issue #1785)
- Graceful fallback: returns original text when sampling unavailable
- Ready to activate automatically — no code changes needed when client support arrives

### Implementation Details
- New files: `src/utils/condition-evaluator.ts`, `src/utils/distillation.ts`, `tests/tier5-mastery.test.ts`
- Modified: `memory-repository.ts` (precision signal in `multiSignalScore`), `constants/index.ts` (6 weights + `PRECISION`), `reminder-repository.ts` (`checkConditionalReminders`), `pitfall-check.ts` (branch tokens + conditional reminders), `session-start.ts` (conditional reminders)
- 30 new tests (681 total), 0 regressions
- Version: 3.1.0 → 3.2.0

## [3.1.0] - 2026-03-30

### Tier 4 Polish — Ebbinghaus Decay, Enhanced Dedup, Learning Velocity

#### Ebbinghaus Continuous Decay
- Replaced fixed-interval decay with continuous Ebbinghaus forgetting curve: `R = sourceWeight × e^(-t/S)` where `S = stabilityBase × (1 + recall_count × 0.3)`
- Kind-specific stability constants (days): user_profile/reference=120, pitfall/correction=60, decision=45, fact=30
- Source trust multiplier: corrected=1.5×, user=1.2×, confirmed=1.1×, learned=1.0×
- Memories recalled within 7 days skip decay entirely (spaced repetition effect)
- High recall counts dramatically increase stability (S), modeling long-term memory consolidation

#### Enhanced Dedup with Cosine Similarity
- `findSimilar()` now checks cosine similarity (threshold ≥ 0.85) alongside token overlap
- Catches semantically equivalent memories that use different wording (paraphrase detection)
- Falls back gracefully when embeddings are unavailable (token overlap still works)

#### Learning Velocity Dashboard
- New `cairn_stats(action: "velocity")` — comprehensive knowledge health metrics:
  - Weekly memory creation rate (last 4 weeks)
  - Embedding coverage percentage
  - Anchor coverage percentage
  - Knowledge graph density (edges/memory)
  - Consolidation opportunities by kind
  - Cross-project pattern count
  - Recall precision (last 5 sessions)

### Implementation Details
- New constants: `STABILITY_BY_KIND` — kind-specific Ebbinghaus stability values
- Modified: `maintenance.ts` (Ebbinghaus decay), `memory-repository.ts` (cosine dedup in `findSimilar`), `stats-tool.ts` (+velocity action), `constants/index.ts` (+stability constants)
- 10 new tests (651 total), 0 regressions
- Version: 3.0.0 → 3.1.0

## [3.0.0] - 2026-03-30

### Tier 3 Platform — Rich Reminders, New Hooks, Agent Teams Readiness

#### Rich Reminders
- **File-triggered**: `cairn_remind(trigger_type: "file", trigger_config: {filePaths: [...]})` — fires when matching file is touched in pitfall-check
- **Time-based**: `cairn_remind(trigger_type: "time", trigger_config: {nextDue: "ISO date"})` — fires on session-start when due
- Backward compatible: existing prompt-type reminders unchanged (default `trigger_type: "prompt"`)
- `checkFileReminders()` and `checkTimeReminders()` in ReminderRepository

#### New Hooks
- **Stop hook** (`stop.ts`): End-of-turn decision mining — scans `last_assistant_message` for undocumented decisions via `extractAssistantDecision()`
- **SubagentStop hook** (`subagent-stop.ts`): Captures subagent outcomes — extracts summary from last message and records as plan step note
- New hook input types: `StopInput`, `SubagentStopInput` in hook-io.ts

#### Agent Teams Readiness
- **Per-agent edit-tracker**: `loadTracker(agentId?)` / `saveTracker(tracker, agentId?)` — each agent gets its own tracker file (`edit-tracker-{agentId}.json`) to prevent concurrent corruption
- **Optimistic plan step locking**: `updateStep()` with `status: 'in_progress'` now uses `AND status = 'pending'` WHERE clause — prevents two teammates claiming the same step

### Implementation Details
- Schema v12: `trigger_type TEXT` + `trigger_config TEXT` on reminders
- New files: `src/hooks/stop.ts`, `src/hooks/subagent-stop.ts`, `tests/tier3-platform.test.ts`
- Modified: `reminder-repository.ts` (+file/time query methods, `rowToReminder`, `ReminderTriggerType`), `reminder-tools.ts` (+trigger_type/trigger_config params), `plan-repository.ts` (+optimistic locking), `edit-tracker.ts` (+per-agent paths), `hook-io.ts` (+StopInput, SubagentStopInput)
- 20 new tests (641 total), 0 regressions

## [3.0.0-beta] - 2026-03-30

### Tier 2 Intelligence — Code Anchoring, Auto-Promotion, Predictive Pre-Fetching, Session Scoring

#### Code-Location Anchoring
- Memories are automatically linked to referenced file paths and function names via `extractAnchor()`
- `recallByAnchor()` enables file-specific memory surfacing — pitfall-check now queries anchored memories for the current file
- Anchor JSON stored in new `anchor TEXT` column on memories table

#### Auto-Promotion (Cross-Project Pattern Detection)
- `runAutoPromotion()` detects memories that recur across 2+ projects with high impact and confidence
- Criteria: confidence ≥ 0.7, impact > 0, age > 60 days, cross-project FTS match with token overlap ≥ 0.4
- Max 3 auto-promotions per startup maintenance run
- Creates `generalizes` edge on promotion

#### Predictive Pre-Fetching (Co-Recall Tracking)
- New `memory_corecall` table tracks which memories are recalled together across sessions
- New `session_memories` table records per-session recall events with success tracking
- `predictRelated()` returns memories frequently recalled alongside given ones
- `trackCoRecall()` updates co-occurrence counts on every recall batch

#### Session Continuity Scoring
- `markRecallSuccess()` records when surfaced pitfalls led to successful tool use
- `computeRecallPrecision()` calculates ratio of helpful vs. total recalled memories
- `SessionQuality` extended with `recallPrecision` field for cross-session momentum

### Implementation Details
- Schema v11: `anchor TEXT` on memories, `memory_corecall` table, `session_memories` table + indexes
- New files: `src/utils/anchor.ts`, `src/utils/prediction.ts`, `tests/tier2-intelligence.test.ts`
- Modified: `memory-repository.ts` (+`recallByAnchor`, `trackCoRecall`), `maintenance.ts` (+`runAutoPromotion`), `memory-tools.ts` (+anchor extraction in cairn_learn), `pitfall-check.ts` (+anchor-based recall), `success-tracker.ts` (+markRecallSuccess), `session-end.ts` (+recallPrecision)
- 29 new tests (621 total), 0 regressions

## [3.0.0-alpha] - 2026-03-30

### Tier 1 Foundation — Semantic Search, Knowledge Graph, Memory Consolidation

Major upgrade adding semantic search via local embeddings, a knowledge graph for memory relationships, and automatic memory consolidation.

#### Semantic Search (Embeddings + Hybrid RRF)
- **New dependency**: `@huggingface/transformers@4.0.0` — local 384-dim embeddings via `Xenova/all-MiniLM-L6-v2` (quantized, ~15ms warm inference)
- **New dependency**: `sqlite-vec@0.1.8` — SIMD-accelerated cosine distance in SQL (`vec_distance_cosine()`)
- `cairn_recall` now uses hybrid search: FTS5 keyword results + vector cosine results fused via Reciprocal Rank Fusion (RRF, k=60)
- Falls back gracefully to FTS-only when embedding model isn't loaded (hooks, cold start)
- `cairn_learn` generates and stores embeddings automatically when model is ready
- Background backfill embeds existing memories on MCP server startup (batches of 10)
- JS `cosineSimilarity()` fallback when `sqlite-vec` extension unavailable

#### Knowledge Graph (Memory Edges)
- New `memory_edges` table with 7 relation types: `supersedes`, `refines`, `contradicts`, `caused_by`, `informs`, `co_occurred`, `generalizes`
- `EdgeRepository` with CRUD, 1-hop neighbors, N-hop recursive CTE traversal (cycle-safe)
- Graph-enhanced recall: `cairn_recall` in normal mode enriches results with 1-hop neighbors from the edge graph
- Automatic `refines` edge creation during memory consolidation
- Old `co_occurred` edges auto-pruned after 90 days

#### Memory Consolidation
- Affinity-based agglomerative clustering (SimpleMem-inspired): blends content similarity (70%) with temporal proximity (30%)
- Runs during `runMaintenance()` on startup sessions — eligible kinds: pitfall, decision, fact
- Clusters with affinity ≥ 0.7 are merged: representative keeps longest/highest-confidence content, members soft-deleted
- Merged confidence = max(members) + 0.05 per additional member (capped at 1.0), tags union-merged
- Creates `refines` edges from each cluster member to the merged representative
- Safety: min 7-day age, max 50 per kind per run

#### Multi-Signal Scoring Update
- `multiSignalScore` now uses 5 signals: fingerprint (0.25), vector similarity (0.25), content overlap (0.20), confidence (0.20), recency (0.10)
- Previous 4-signal weights rebalanced to accommodate vector signal

### Implementation Details
- Schema v10: `embedding BLOB DEFAULT NULL` on memories, `memory_edges` table + 3 indexes
- New files: `src/utils/embeddings.ts`, `src/db/edge-repository.ts`, `src/utils/consolidation.ts`, `tests/tier1-foundation.test.ts`
- Modified: `memory-repository.ts` (+`recallHybrid`, `vectorSearch`, `enrichWithGraphNeighbors`, `storeEmbedding`, `memoriesWithoutEmbeddings`), `maintenance.ts` (+`runConsolidation`), `server.ts` (+warmup, backfill), `memory-tools.ts` (+embedding gen, hybrid search, graph enrichment), `connection.ts` (+sqlite-vec, v10 migration), `constants/index.ts` (+`CONSOLIDATION`, `HYBRID_SEARCH`, vector weight), `similarity.ts` (+`cosineSimilarity`)
- 47 new tests (592 total), 0 regressions
- Version bump: 2.9.0 → 3.0.0-alpha

## [2.9.0] - 2026-03-30

### TurboQuant-Inspired Briefing Pipeline — Impact-Proportional Allocation + Correction Pass

Two improvements to the briefing compiler inspired by Google's TurboQuant (ICLR 2026) KV cache compression architecture. The core insight: allocate budget proportionally to proven value, then run an error-correction pass to recover critical information lost during compression.

#### Impact-Proportional Token Allocation (Feature #3 — PolarQuant analog)
- **Problem**: All pitfalls in the briefing received uniform rendering (content + why), regardless of whether they had ever actually prevented an error.
- **Fix**: New `computeEffectiveness()` scoring function blends conversion rate (impact/surfaces, 70%) with confidence (30%). Pitfall rendering now uses three tiers:
  - **High effectiveness** (≥0.5): Full rendering — content + why + how_to_apply
  - **Medium effectiveness** (0.1–0.5): Standard rendering — content + why (previous behavior)
  - **Low effectiveness** (<0.1): Excluded entirely from briefing — unproven noise eliminated at source
- **Effect**: Proven pitfalls get more token budget; noisy ones are removed entirely. The 1000-token briefing carries more signal per token.

#### Two-Stage Briefing Correction Pass (Feature #2 — QJL analog)
- **Problem**: Multi-pass reduction (5→3→1 pitfalls) could drop high-impact pitfalls that happened to rank lower on confidence × recall_count.
- **Fix**: After multi-pass reduction completes, a correction pass queries the DB for high-impact pitfalls (`impact_count ≥ 2`) not already in the briefing. Up to 2 are injected as ultra-compact `[!]`-marked one-liners (60 chars max) using remaining token budget.
- **Effect**: Critical warnings survive budget pressure. A pitfall that's proven useful 5+ times won't silently disappear when the briefing is compressed.

#### 100% SNR Briefing — Noise Elimination
- **Problem**: Post-compaction briefings contained ~5% noise: conversational approach notes leaking through `isApproachNote()`, low-effectiveness pitfalls still rendered at 80 chars, approach section competing with higher-value sections for truncation budget.
- **Fixes**:
  - `isApproachNote()` filter strengthened — new patterns catch "Good point", "Here are", benchmark results, "Agreed"
  - `isConversationalApproach()` defense-in-depth gate at render time — catches any remaining conversational text in approach notes
  - `computeEffectiveness()` zero-surface multiplier reduced (0.5→0.3) — unproven memories score lower, weakened ones (conf=0.15) fall below LOW threshold and are excluded
  - Section reorder: corrections before pitfalls (protected from truncation), approach last (drops first)
- **Effect**: Post-compaction briefing measured at 100% signal — every token serves a purpose.

### Implementation Details
- New constants: `BRIEFING_ALLOCATION` — 8 threshold/limit values for allocation tiers and correction pass
- New method: `MemoryRepository.highImpactPitfalls()` — queries pitfalls by impact_count, excluding specified IDs
- New exports: `computeEffectiveness()`, `recoverDroppedPitfalls()` from briefing-compiler
- New helper: `isConversationalApproach()` — defense-in-depth filter for approach note rendering
- Modified: `briefing-compiler.ts` (variable-width rendering, LOW-eff exclusion, section reorder, approach quality gate), `session-start.ts` (correction pass wiring), `transcript-parser.ts` (approach filter patterns), `constants/index.ts` (version bump + new constants)
- 24 new tests (545 total), 0 regressions
- Version bump: 2.8.0 → 2.9.0

## [2.8.0] - 2026-03-28

### NSR Improvements — PostCompact, SubagentStart, MCP Resources, Elicitation

Five targeted improvements pushing Net Session Recovery from ~90% to ~95%+. Based on deep analysis of Claude Code's hook event system, MCP SDK capabilities, and Cairn's recovery pipeline.

#### PostCompact Hook (NSR: +2-3%)
- **Problem**: Session type detection relied on a fragile 60-second DB heuristic to distinguish post-compaction sessions from fresh startups.
- **Fix**: New `postcompact.ts` hook writes `lastCompactAt`, `lastCompactSessionId`, and `lastCompactTokensSaved` to EditTracker on every compaction event. Zero DB connections, runs in ~1ms.
- **Two-tier detection**: SessionStart now checks PostCompact signal first (Tier 1, 30s window), falls back to DB snapshot heuristic (Tier 2, 60s window). Validated in production: both tiers work correctly.
- **EditTracker extended**: 3 new fields with defaults (`lastCompactAt: 0`, `lastCompactSessionId: null`, `lastCompactTokensSaved: 0`).

#### SubagentStart Context Injection (NSR: +0-2%)
- **Problem**: Subagents (spawned via Agent tool) start with no Cairn context — no briefing, no pitfalls, no plan state.
- **Fix**: New `subagent-context.ts` hook injects active plan summary (name + progress + current step), top 2 pitfalls, and top 2 corrections via `outputAdditionalContext`. Runs in ~43ms.
- **Budget**: Concise format (<200 tokens) to avoid overwhelming subagent context windows.

#### MCP Resources for Plan State (NSR: +1-3%)
- **Problem**: Post-compaction plan recovery was limited to the 500-token briefing budget.
- **Fix**: New `resources.ts` registers two MCP resources for richer recovery reads:
  - `cairn://plan/{project}/active` — full plan with all steps, decisions, outcomes, and notes (no token budget)
  - `cairn://briefing/{project}` — full briefing with up to 10 pitfalls, 5 corrections, 5 decisions (no budget constraint)
- **Uses**: `ResourceTemplate` from `@modelcontextprotocol/sdk/server/mcp.js` for parameterized URI resources.

#### MCP Elicitation for Bulk Cleanup (NSR: +0-1%)
- **Problem**: `cairn_cleanup(action: "execute")` could bulk-delete memories without user confirmation.
- **Fix**: Before executing bulk delete, calls `server.elicitInput()` with a boolean confirm schema. User must explicitly confirm deletion.
- **Graceful fallback**: Catches "client doesn't support elicitation" and proceeds without confirmation (backwards compatible).
- **Wiring**: `server.server` (internal `Server` instance with `elicitInput()`) passed through to `registerMemoryTools`.

#### Auto-Memory Suppression
- **Problem**: Claude Code's built-in auto-memory creates MEMORY.md entries that conflict with Cairn's structured memory system.
- **Fix**: `"autoMemoryEnabled": false` in settings.json — enforcement at the harness level, not just advisory rules.

### Implementation Details
- New files: `src/hooks/postcompact.ts`, `src/hooks/subagent-context.ts`, `src/mcp/resources.ts`
- Modified: `session-start.ts` (two-tier detection), `edit-tracker.ts` (+3 fields), `hook-io.ts` (+2 types), `server.ts` (resources + elicitation wiring), `memory-tools.ts` (elicitation)
- Hook events: 8 → 10 (added PostCompact, SubagentStart)
- All 515 tests pass, 0 new test regressions

## [2.7.0] - 2026-03-23

### Schema v9, Auto-Capture Hooks, Session Isolation, Structured Context

See commit `10c4429` for full details.

## [2.6.0] - 2026-03-21

### Behavioral Compliance — Auto-Recall + Decision Mining + Plan Bridge

Five enhancements that close the gap between passive hooks (~90% effective) and active MCP tool usage (~30% utilized). Based on research into MemGPT/Letta, Mem0, Claude Code Stop hooks, and prompt engineering patterns.

#### Layer 1a: Auto-Recall in UserPromptSubmit
- **Problem**: Claude doesn't consistently call `cairn_recall` before starting work.
- **Fix**: UserPromptSubmit hook now runs a broad keyword search across ALL memory kinds (not just pitfalls/facts/decisions by kind) using the user's prompt text. Injects top 2 relevant memories as `[CAIRN] kind: content`. Deduplicates against kind-specific injections.
- **Effect**: Recall happens automatically at the infrastructure level — no explicit tool call needed.

#### Layer 1b: Auto-Decision Mining in PreCompact
- **Problem**: Claude doesn't consistently call `cairn_learn(kind: "decision")` when making architectural choices.
- **Fix**: `extractAssistantDecision()` scans assistant text blocks for decision patterns ("I'll use X because...", "Going with X because...", "chose X over Y because..."). Requires BOTH choice signal AND rationale signal to avoid false positives. PreCompact auto-stores mined decisions with `AUTO_DETECTED` confidence (0.4) so manually stored decisions rank higher. Deduplicates against existing memories via FTS.
- **Effect**: Safety net — decisions are captured even if Claude forgets to store them.

#### Layer 2a: Compliance Nudge in UserPromptSubmit
- **Problem**: Rules in `.claude/rules/cairn.md` fade from attention mid-conversation.
- **Fix**: On first task-intent prompt where no Cairn MCP tools have been called (detected by scanning transcript tail), injects a one-time nudge: "No explicit recall this session. Consider cairn_plan(get) for active plans."
- **Dedup**: Fires once per session via `complianceNudgeFired` flag in EditTracker. Resets on session boundary.

#### Layer 2b: Decision Reminder in UserPromptSubmit
- **Problem**: After successful implementation sequences, Claude doesn't store the decisions that led to them.
- **Fix**: Checks EditTracker's toolChain for recent Edit+Bash(success) patterns. On first detection, injects: "If you made architectural decisions, store them with cairn_learn."
- **Dedup**: Fires once per session via `decisionReminderFired` flag.

#### Plan Bridge — Auto-Persist from Plan Mode
- **Problem**: Claude Code's plan mode (EnterPlanMode/ExitPlanMode) is ephemeral — plans live only in context and are lost on compaction. Cairn's persistent plan system requires explicit `cairn_plan(create)` calls.
- **Fix**: PostToolUse hook on `ExitPlanMode` reads the plan file from the EditTracker's recent Write events, parses markdown (numbered lists, checkboxes, bullets), and auto-creates a persistent Cairn plan.
- **Effect**: Enter plan mode → get approval → exit → plan auto-persists to SQLite. Survives compaction.
- **Parser**: `parsePlanContent()` in `src/utils/plan-parser.ts` handles common plan formats: headings for name, numbered/bullet/checkbox lists for steps.

#### Goal Extraction — Skill Expansion Filter
- **Problem**: Skill invocations (e.g., `/plugin-dev:plugin-structure`) create two user entries in the transcript JSONL: a `<command-message>` entry and a raw skill expansion entry with no XML wrapper. The goal extractor picked up the skill content as the session goal.
- **Fix**: Added `<command-message>` prefix and `"Base directory for this skill:"` pattern to `isHumanMessage()` filter. Same filters added to `isSystemMessage()` in prompt-check.ts.

### Implementation Details
- EditTracker extended with `complianceNudgeFired` and `decisionReminderFired` boolean flags
- TranscriptSnapshot extended with `minedDecisions: Array<{ content: string }>` field
- `extractAssistantDecision()` exported from transcript-parser for testing
- Transcript scan for MCP calls uses last-64KB tail read for performance
- New `src/utils/plan-parser.ts` — markdown plan parser with numbered/bullet/checkbox step extraction
- New `src/hooks/plan-bridge.ts` — PostToolUse hook for ExitPlanMode
- Hook registered in settings.json: `PostToolUse` matcher `ExitPlanMode`
- 32 new tests (420 total): decision mining (10), compliance nudge (3), decision reminder (3), tracker fields (2), plan parser (13), skill expansion filter (1)

## [2.5.1] - 2026-03-21

### Post-Compaction Recovery Fixes

Three fixes closing the gaps identified in post-compaction SNR analysis (100% raw SNR but only ~75% recovery effectiveness).

#### Goal Extraction — Bookend Read
- **Root cause**: For large transcripts (>512KB), only the tail was read. The user's original task goal—in the first few KB—was dropped.
- **Fix**: Added `readHead()` — reads first 32KB of large transcripts to find the initial goal, even when the tail-read optimization activates. Goal extraction now filters meta-goals (`isMetaGoal`) from head lines directly.
- **PreCompact hardening**: Goal inheritance now scans up to 10 previous snapshots (not just the most recent) to find a valid non-meta goal. Prevents chain breakage across multiple compactions.

#### Approach Note Filter — Length-Adaptive
- **Root cause**: Dual-signal AND (approach + reasoning) was too strict for longer texts. Genuine approach reasoning got filtered.
- **Fix**: For texts ≥200 chars, require only ONE signal type (approach OR reasoning). Shorter texts keep dual-signal to prevent false positives. The conversational/status noise filters already reject noise at any length.

#### Git Working Tree State in Briefing
- **Missing feature**: No visibility into uncommitted/unpushed status after compaction.
- **Added**: `getGitWorkingState()` utility — returns branch name, uncommitted file count, unpushed commit count. Rendered as `Git: branch: X, N uncommitted files, M unpushed commits` in the briefing.
- **Budget-aware**: Only non-zero counts are shown. Clean working tree shows only branch name.

### Test Coverage
- 22 new tests (388 total): goal extraction (5), isMetaGoal (5), approach filter (7), git state (2), briefing rendering (3)

## [2.5.0] - 2026-03-21

### Quality Refinements

Three targeted improvements to reduce noise and improve decision context.

#### Approach Notes Quality (#3)
- **Dual-signal requirement**: `isApproachNote()` now requires BOTH an approach signal (approach/strategy/design/pattern) AND a reasoning signal (because/since/trade-off/alternative). Previously, broad words like "then" or "first" alone would match status updates.
- **Status noise rejection**: Explicit blocklist for progress reports ("277 tests passing", "build clean", "exit code: 0") that masquerade as approach notes.

#### Semantic Deduplication (#5)
- **Lower similarity threshold**: `DEDUP.SIMILARITY_THRESHOLD` reduced from 0.6 to 0.5 to catch paraphrased duplicates that express the same lesson with different wording.
- **Confidence boost on merge**: When a duplicate is detected, confidence is boosted by `BOOST_INCREMENT` (0.05) instead of just taking the max. Dedup = reinforcement — learning the same lesson twice increases trust.

#### Plan Decision Reasoning Depth (#8)
- **Rejected alternatives rendered**: `alternatives` field (already stored in DB since v1.0) is now shown in `cairn_plan(get)` output (`rejected: X, Y`) and in the briefing compiler (`not: X, Y`).
- **Richer decide confirmation**: `cairn_plan(decide)` response now echoes back the stored decision including rejected alternatives.

## [2.4.0] - 2026-03-21

### Cross-Session Momentum

Computes a session quality signal at session end from existing telemetry data and surfaces it in the next session's briefing. Informative, not prescriptive (SWE-PRM research: diagnostic guidance outperforms rigid directives).

#### Added
- **Session quality computation** at session end: queries `hook_telemetry` for error count, tool call count, escalation count; counts compactions; reads `EditTracker.sessionErrorCounts` for error diversity.
- **Qualitative classification**: `smooth` (0-1 errors), `productive` (moderate errors, making progress), `rough` (high error rate or escalations), `stuck` (multiple escalations or high error diversity).
- **Compact summary line**: e.g., `Previous session: productive (2 errors / 45 tool calls, 3/5 plan steps done)` — includes task summary for full context.
- **Schema v8**: `session_quality TEXT` column on `sessions` table storing JSON quality metrics.
- **Briefing integration**: session-start fetches previous session quality and renders in briefing. Quality signal takes priority over raw task summary, with task summary appended for context.
- **18 new tests** in `tests/session-quality.test.ts` — classification logic, summary formatting, schema migration, briefing integration.

## [2.3.0] - 2026-03-21

### Stale Memory Detection

Git-aware, three-phase staleness detection that auto-weakens outdated memories on session start. Prevents acting on memories that reference deleted files, removed modules, or repeatedly unproven pitfalls.

#### Added
- **Phase 1 — Zero-impact pitfall weakening**: Pitfalls surfaced 5+ times with 0 `impact_count` are auto-weakened during maintenance. Already suppressed from display (v2.2.0); now fade toward deletion via confidence decay.
- **Phase 2 — Fingerprint staleness**: Compares memory `fingerprint.module[]` terms against current project directory structure (`getProjectModuleTerms()`). Memories with zero module overlap are weakened — they likely reference deleted files/modules.
- **Phase 3 — Git-delta deleted file detection**: On session start, runs `git diff --diff-filter=D` between cached and current git hash to find recently deleted files. Weakens memories whose content references those files via FTS match.
- **`getProjectModuleTerms()`** — Extracts all meaningful directory/file-stem tokens from the project (3 levels deep, filters ignored dirs). Used by Phase 2 for overlap comparison.
- **`getDeletedFiles()`** — Runs `git diff --diff-filter=D` between two commit hashes with a 5-second timeout. Non-fatal on error.
- **`runStalenessDetection()`** — Orchestrates all three phases. Called from session-start after `runMaintenance()` on startup sessions. Best-effort (never blocks startup).
- **`STALENESS` constants**: zero-impact threshold (5), max sweep batch (50), weaken floor (0.15), git diff timeout (5s).
- **18 new tests** in `tests/staleness.test.ts` — all three phases, integration test, project term extraction, constants validation.

## [2.2.0] - 2026-03-21

### Proactive Pre-Tool Warnings

Transforms pitfall-check from generic pitfall matching into session-aware, file-specific proactive warnings. Novel: no existing coding agent implements memory-backed, per-tool-call warning injection.

#### Added
- **Session-aware warnings** (Enhancement A): Loads EditTracker at query time to detect recent file failures, tool chain loop patterns (Edit→Bash(fail)→Edit), and rapid re-edits (same file < 30s).
- **Lower confidence floor for session errors** (Enhancement B): When a file has recent failures, lowers `minConfidence` from 0.6 to 0.3 so fresh auto-detected pitfalls (confidence 0.4) become immediately visible — not buried until next session.
- **Decision surfacing for Write/Edit** (Enhancement C): In `normal` mode, also queries `kind: 'decision'` (max 1, high confidence) so relevant architectural decisions appear at the point of action, not just in session-start briefing.
- **MultiEdit support** (Gap 1 fix): Added MultiEdit to code filter; extracts file paths from `edits[]` array.
- **File-specific labels** (Gap 6 fix): Labels now show `basename(filePath)` (e.g., `[CAIRN] Pitfalls for memory-repository.ts:`) instead of generic `[CAIRN] Pitfalls for ts:`.
- **Warning cap at 3 per tool call**: Research-backed alert fatigue threshold — more than 3 contextual warnings risks being ignored.
- **Failure events in toolChain**: error-learning now records `success: false` ToolEvents in the EditTracker so pitfall-check can see recent failures per file.
- **`PROACTIVE` constants**: max warnings (3), rapid re-edit window (30s), session error confidence floor (0.3), loop lookback (6), decision confidence (0.7).
- **22 new tests** in `tests/proactive-warnings.test.ts` — loop detection, file path extraction, warning cap, confidence floor.

#### Content-Aware Matching
- **Code content FTS** — Extracts `new_string` (Edit), `content` (Write), or concatenated `edits[].new_string` (MultiEdit) and includes in the FTS query. Pitfalls now match on the actual code being written, not just the file path. A pitfall about "transcript JSONL nested format" only fires when the code being written touches transcript parsing — not on every `.ts` edit.
- **`PROACTIVE.CONTENT_QUERY_MAX_CHARS`** (300) — Truncation limit for code content in FTS queries.

#### Surface Dedup
- **Cooldown dedup** — Same pitfall not re-surfaced within 5 minutes (`PROACTIVE.SURFACE_COOLDOWN_MS`). Tracks `recentlySurfaced` timestamps in EditTracker.
- **Impact-aware suppression** — Pitfalls surfaced 5+ times with 0 `impact_count` (never led to a successful outcome) are suppressed until confidence is externally boosted.
- **15 additional tests** for content extraction, surface dedup logic, cooldown/impact thresholds.

## [2.1.0] - 2026-03-21

### Error Pattern Escalation

Detects repeated error patterns within a session and injects escalation messages with category-specific alternatives to break retry loops.

#### Added
- **Session error counting** in EditTracker — tracks error occurrences per session with automatic reset on session boundary.
- **Tiered escalation messages**: 1st occurrence injects lesson (fixes gap — new errors were previously silent), 2nd warns, 3rd+ escalates with category-specific alternative.
- **Category-specific alternatives** — positive-framing suggestions keyed by error classification tags (typescript, python, sqlite, node, testing, etc.). Research-informed: specific instructions outperform generic advice (Renze 2024).
- **Tool-specific fallbacks** — alternatives for Edit ("re-read the file"), Write ("check directory exists"), Bash ("try a different approach").
- **errorKey preservation on dedup** — classifier now returns `errorKey` and `tags` even when deduped (`learnable=false`), separating "don't create duplicate pitfall" from "count for escalation."
- **`ESCALATION` constants**: threshold (3), category alternatives map, tool alternatives map, fallback message.
- **16 new tests** across `tests/escalation.test.ts` — errorKey persistence, positive framing validation, classification→counting pipeline, category resolution.

#### Fixed
- **New errors produced no injection** — first-time errors were silently stored without any feedback to Claude. Now injects the lesson immediately.

## [2.0.0] - 2026-03-21

### Context Fingerprint Retrieval System

Replaces flat tag matching (0.1% surface rate) with multi-dimensional context fingerprints.

#### Fixed
- **PATH_STOPWORDS removed `hooks`, `views`, `utils`, `models`, `controllers`, `schemas`, `migrations`** — the most semantically meaningful directory names were being filtered. Reduced to 10 truly generic stopwords.
- **2-char directory names filtered** (`db`, `ui`, `fs`) — lowered minimum from 3 to 2.
- **Asymmetric scoring** in `relevance.ts` — `path.includes(tag)` caused false positives (`"ts"` matching `"constants"`). Fixed to exact match.
- **Severity tags permanently unreachable** — `high` (58), `critical` (35), `medium` (12) had no generation path. Fingerprints replace tags for retrieval; severity stays as metadata.

#### Added
- **Context fingerprints** (`src/utils/fingerprint.ts`): 3-dimension fingerprint (lang, framework, module) auto-generated at memory creation time from project context + file path + command.
- **Multi-signal retrieval** (`recallByFingerprint()`): Fuses 4 independent signals — fingerprint overlap (40%), content FTS (30%), confidence (20%), recency (10%) — inspired by Stanford Generative Agents + Reciprocal Rank Fusion.
- **Dimension-weighted Jaccard**: module (50%) > framework (30%) > lang (20%) — most specific signal weighs most.
- **Fingerprint-aware briefing**: `topPitfalls()` accepts optional fingerprint for context-aware pitfall ranking in briefings.
- **All creation paths attach fingerprints**: error-learning, success-tracker, prompt-check, cairn_learn — every new memory gets auto-fingerprinted.
- **Backfill utility** (`src/utils/fingerprint-backfill.ts`): Maps existing tags to fingerprint dimensions for the 140 existing memories.
- **Schema v7**: `fingerprint TEXT` column on memories table.
- **New constants**: `FINGERPRINT.WEIGHTS`, `FINGERPRINT.DIMENSION_WEIGHTS`, `FINGERPRINT.MIN_SCORE`.
- **24 new tests** across `fingerprint.test.ts`, `retrieval.test.ts`, updated `path-concepts.test.ts`.

## [1.6.0] - 2026-03-21

### Enhanced Compaction Snapshot: Project Context Recovery

#### Added
- **Project context scanner** (`src/utils/project-scanner.ts`): Lightweight filesystem scan (~180ms) captures project name, tech stack, directory structure, entry points, and key config files. Uses `execFileSync` (no shell injection risk).
- **Context repository** (`src/db/context-repository.ts`): Caches project context by `project + git_hash`. Cache hit avoids rescan. Keeps last 5 per project.
- **`project_context` table** (schema v6): Stores structural snapshots keyed by project + git hash.
- **Briefing integration**: Project context injected into ALL session types (startup, compact, clear) — instant orientation without re-exploration.
- **PreCompact hook**: Automatically scans project on cache miss (git hash changed) during compaction.
- **SessionStart hook**: Loads cached context with 3-tier fallback: exact git hash → latest for project → fresh scan on startup.
- **New constants**: `PROJECT_SCAN` with `IGNORED_DIRS`, `MAX_TOP_DIRS`, `MAX_CACHE_PER_PROJECT`, `CONFIG_FILES`.
- **21 new tests** across `project-scanner.test.ts` and `context-repo.test.ts`.

#### Briefing output example (post-compaction)
```
[Cairn Memory Briefing]
Project: cairn-memory
Tech: TypeScript/Node.js, better-sqlite3, @modelcontextprotocol/sdk, zod
Structure: src/{constants/,db/,hooks/,mcp/,utils/} | tests/ | scripts/
Entry: dist/src/mcp/server.js
Config: package.json, tsconfig.json
Plan: "Fix all review issues" — step 5/7
Goal: implement all code review fixes
...
```

## [1.5.0] - 2026-03-21

### Code Quality & Architecture Improvements

#### Fixed
- **Memory interface missing `surface_count`/`impact_count`**: The `Memory` type and `MemoryRow` type now include `surface_count` and `impact_count` fields added in schema v5, fixing silent field drops in `rowToMemory()`.
- **Stale `DB.SCHEMA_VERSION` constant**: Removed the stale `DB.SCHEMA_VERSION = 1` from constants — the authoritative version lives in `schema.ts` only.
- **MCP server version hardcoded**: Server now reports the correct version from the `VERSION` constant instead of hardcoded `'1.0.0'`.
- **N+1 query in `PlanRepository.listByProject()`**: New `buildPlans()` batch method fetches all steps and decisions in 2 queries instead of 2N.
- **`recordTelemetry()` opened redundant DB connection**: Now accepts an optional `db` parameter to reuse the hook's existing connection.
- **State file race condition**: `readState()` now checks file staleness — if the state file is older than 30s, defaults to `'normal'` mode (fail-open).
- **Error dedup only worked within single invocation**: `classifyError()` now persists dedup state to `~/.cairn/error-dedup.json` for cross-invocation dedup.

#### Added
- **`cairn_reminder_list` tool**: List active reminders by project.
- **`cairn_reminder_delete` tool**: Deactivate or permanently delete reminders by ID.
- **`MemoryRepository.search()` method**: Read-only recall that does NOT update `last_recalled`/`recall_count`. Used by error-learning hook for dedup checks.
- **Shared `buildFtsQuery()` utility** (`src/utils/fts.ts`): Extracted from MemoryRepository and ReminderRepository, eliminating duplication.
- **Shared edit tracker module** (`src/hooks/shared/edit-tracker.ts`): Extracted from pitfall-check and success-tracker hooks.
- **`isCritical()` helper** (`src/mcp/tools/helpers.ts`): Replaced 7 identical critical-mode guard blocks.
- **New constants**: `VERSION`, `PROMOTION`, `HEALTH`, `REMINDERS`, `TRACKER_FILENAME`, `STATE_STALENESS_MS`.
- **21 new tests** across `fts.test.ts`, `reminder.test.ts`, and additions to `memory.test.ts`.

#### Changed
- **Statusline uses lightweight read-only DB**: No longer runs schema migration checks on every status bar refresh.
- **All hardcoded values extracted to constants**: Reminder limits, promotion thresholds, health metric thresholds, zero-impact surface count — all use centralized constants.

## [1.4.3] - 2026-03-19

### Post-Compaction Recovery Fix (Root Cause)

#### Fixed
- **Recovery context never loaded after real compactions**: Claude Code does NOT send a `type` field in the SessionStart hook input after compaction — `input.type` is `undefined`, so `input.type === 'compact'` was always false. Snapshot loading, recovery context (Goal, Decisions, Files, Approach), and all compact-specific logic was completely skipped. Added automatic type inference: when `type` is missing, checks for a recent compaction snapshot (within 60s) to detect post-compaction state. This was the root cause of the entire multi-session investigation.

## [1.4.2] - 2026-03-19

### SNR Audit Fixes

Three fixes from post-compaction briefing audit — correction false positives, missing transcript decisions, and snapshot query diagnostics.

#### Fixed
- **False positive correction detection**: Intent classifier matched `^no[,.]?\s` on discourse markers like "no I just need X". Tightened pattern to require correction follow-up words (that, don't, stop, never, wrong, not, you, i said/told). "no i just compact so i need you to do the analysis" is now correctly classified as `task`, not `correction`.
- **Decisions never captured in transcript snapshots**: Transcript parser only extracted decisions from `cairn_plan(decide)` tool calls. Added extraction from `cairn_learn(kind: "decision")` calls, which is how decisions are actually stored in practice. `decisionsCount` in precompact telemetry will now be non-zero.
- **Missing recovery context undiagnosable**: When session-start's snapshot query returned null, the briefing silently fell through to pitfalls-only. Added stderr diagnostic: `[cairn] No compaction snapshot found for session=X project=Y. Recovery context will be missing.`

#### Changed
- **Test count**: 201 → 211 (7 intent classifier + 3 transcript parser + 1 non-decision filter)

## [1.4.1] - 2026-03-19

### Post-Compaction Recovery Fixes

Three fixes to improve briefing quality after context compaction — goal continuity, approach filtering, and decision visibility.

#### Fixed
- **Goal lost across continuations**: When Claude Code continues a conversation after context overflow, the transcript starts fresh and the original goal is lost. `precompact.ts` now detects meta-goals (short acks, "compact", "proceed", etc.) via `isMetaGoal()` and inherits the previous snapshot's goal.
- **Approach notes too noisy**: Transcript parser captured all assistant text >50 chars as approach notes, including conversational responses ("Here's the summary", "Let me check"). New `isApproachNote()` filter rejects conversational starters and requires strategy-like language (approach, trade-off, because, step N).
- **Decisions invisible after plan completion**: Briefing only showed decisions from active plans. When plans were completed, decisions stored in the memory DB were never surfaced. Added `topDecisions()` fallback in briefing-compiler that queries memory DB when no plan or transcript decisions exist.

#### Added
- **Continuation summary filtering**: `isHumanMessage()` now rejects "This session is being continued from a previous conversation" text injected by Claude Code on context overflow.
- **`topDecisions()` method**: New query on memory-repository returns top decisions by confidence × recall_count, used as briefing fallback.

## [1.4.0] - 2026-03-19

### Precision Recall + Dedup Fix + Auto Decision Capture

Five fixes to improve memory precision, prevent duplicates, rebalance confidence, and reduce injection noise.

#### Fixed
- **FTS query noise**: Added 60+ stopword filter to `buildFtsQuery()`. Common words like "are", "there", "any", "other" no longer produce false FTS matches. Previously, a user asking "are there any gaps?" would match memories containing "are" — now only content-bearing words reach FTS.
- **Query-blind re-ranking**: `computeScore()` now uses token overlap between query and memory content as a relevance factor (0.3x–1.2x). Previously, the `_query` parameter was unused — all candidates with the same confidence ranked equally regardless of actual relevance.
- **Dedup threshold too strict**: Lowered `DEDUP.SIMILARITY_THRESHOLD` from 0.8 to 0.6. Added bigram overlap (word-pair matching) alongside unigram Jaccard similarity, using max of both. Previously, 4 near-identical kanban pitfalls all scored 0.23–0.55 and evaded dedup.
- **New memory confidence penalty**: Increased `CONFIDENCE.LEARNED` from 0.5 to 0.65. Manually learned pitfalls/decisions/facts now start above the 0.6 injection threshold. Auto-detected errors remain at 0.4 (must earn trust). Previously, hand-curated memories ranked below auto-generated ones.
- **Facts injected without confidence floor**: Added `RELEVANCE.MIN_CONFIDENCE_FOR_FACT` (0.5) for fact queries in prompt-check. Previously, any fact with confidence > 0 could be injected.

#### Added
- **Auto decision detection**: `prompt-check.ts` now detects decision language in user prompts (e.g., "let's use X because Y") and auto-encodes as `kind: 'decision'`. Requires both rationale signal ("because", "since") and choice language ("let's use", "decided to", "switch to"). Prevents false positives on action requests.
- **Decision injection on task intent**: Normal mode now injects up to 1 relevant decision alongside pitfalls. Previously only pitfalls were surfaced for task prompts.
- **Minimum score for injection**: All prompt-check injections now require `score >= MIN_SCORE_FOR_INJECTION` (0.3). Low-relevance FTS matches are filtered before reaching Claude's context.
- **Stronger usage discipline rules**: Updated `.claude/rules/cairn.md` with MANDATORY section for active tool usage — cairn_recall before work, cairn_learn after decisions.

#### Changed
- **Similarity function**: `tokenOverlap()` now returns `max(unigram, bigram)` for better paraphrase detection. Bigrams capture word-pair patterns that unigrams miss.
- **Test count**: 188 → 201 (added similarity and decision detection tests).

## [1.3.0] - 2026-03-18

### Semantic Recall + Impact Tracking + Auto Plan Checkpointing

Three features to improve memory precision, measure memory effectiveness, and keep plans current — without degrading the 92% briefing SNR.

#### Added
- **Semantic path-concept extraction**: Pitfall-check hook now extracts concepts from file paths (e.g., `src/auth/oauth_handler.py` → `["auth", "oauth", "handler"]`), bridging the gap between file names and memory tags. Previously only file extensions were used as search tags.
- **Memory impact tracking**: New `surface_count` and `impact_count` columns on memories. `surface_count` increments each time a pitfall is shown to Claude; `impact_count` increments when the subsequent edit succeeds. Enables data-driven memory quality measurement.
- **Impact stats in cairn_stats health**: Shows surfaced-vs-impactful ratio and flags zero-impact memories (surfaced 5+ times with no positive outcome) for review.
- **Automatic plan checkpointing**: When the success-tracker detects a verified tool chain (Read→Edit→Bash(pass)), it adds a progress note to the active plan's in-progress step (e.g., "Verified: oauth.py, views.py (tests pass)"). Advisory only — does not auto-complete steps.

#### Changed
- **Briefing token budget**: Updated from 300 to 500 tokens to accommodate richer recovery context (goal, decisions, approach) added in v1.1.0.
- **Goal/approach truncation**: Goal capped at 150 chars, approach notes capped at 100 chars (last 1 only). Prevents raw transcript text from exhausting the briefing budget.

#### Schema
- **v5 migration**: Added `surface_count INTEGER DEFAULT 0` and `impact_count INTEGER DEFAULT 0` to `memories` table.

## [1.2.0] - 2026-03-18

### Primary Memory Integration

Cairn is now designed to be Claude Code's primary memory system, replacing the built-in file-based auto memory with a structured, confidence-weighted, project-scoped alternative.

#### Added
- **PostToolUseFailure hook wiring**: Error learning now fires on actual tool failures (was previously under wrong event `PostToolUse`). Covers `Bash|Write|Edit|MultiEdit` failures.
- **Read tool pitfall surfacing**: PreToolUse matcher now includes `Read` — pitfalls surface before reading known-issue files (normal mode only, max 1 pitfall).
- **Success pattern detection**: Tool chains (Read→Edit→Bash(pass)) auto-create fact memories when tests pass. Minimum chain length reduced to 2.
- **Hook telemetry**: All hooks record timing, success/failure, and metadata for health monitoring.
- **cairn_stats tool**: Summary, health, by_kind, by_project views with hook telemetry integration.
- **cairn_cleanup tool**: Bulk delete with filters (kind, max_confidence, older_than_days). 100-item safety cap.
- **Cross-session plan continuity**: Previous session summary in briefing, richer session-end data.
- **Importance-weighted TTL**: Kind-specific decay rates (pitfall 0.95, fact 0.90), recall-count slowdown, optional `expires_at`.
- **Transcript parser streaming**: Tail-read for files >512KB instead of loading entire file.
- **5 new error patterns**: TypeScript (`TS\d+`), Node.js (`ERR_MODULE`), SQLite (`SQLITE_ERROR`), JavaScript (`ReferenceError`), system (`ENOENT`).
- **Primary memory rules**: `.claude/rules/cairn.md` rewritten as comprehensive primary memory instructions.
- **Complete installation guide**: README now includes full hook wiring configuration with all 7 events.

#### Changed
- **Context window**: Updated `DEFAULT_CONTEXT_WINDOW_SIZE` from 200K to 1M tokens (Claude Opus 4.6).
- **Autocompact buffer**: Updated from 33K to 50K tokens (~5% of 1M).
- **Briefing decisions**: Last 3 decisions now included in post-compaction briefing.
- **Corrections quality**: All corrections must be distilled one-sentence lessons, not raw user text.
- **MEMORY.md**: Trimmed to bootstrap stub — all knowledge lives in Cairn's database.

#### Fixed
- **error-learning hook on wrong event**: Was registered under `PostToolUse` (receives `tool_response`), but code expects `PostToolUseFailureInput` (with `error` + `is_interrupt`). Moved to `PostToolUseFailure`.
- **success-tracker Bash crash**: `tool_response` is not always a string — added `String()` coercion before `.slice()`.
- **success-classifier threshold mismatch**: Hard-coded `< 3` check now uses `LIMITS.SUCCESS_MIN_TOOL_CHAIN` (2).
- **Read tool not in PreToolUse matcher**: Code handled Read but settings.json didn't route the event.
- **Surfaced pitfalls feedback loop broken**: `pitfall-check.ts` surfaced pitfalls but never wrote their IDs to `edit-tracker.json`, so `success-tracker.ts` could never boost confidence after successful edits. Added tracker write to pitfall-check.
- **Success classifier dedup not persisting**: In-memory `recentSuccesses` map reset per process invocation (each hook is a fresh Node process). Moved dedup state to `edit-tracker.json` for cross-invocation persistence.
- **Initial goal capturing XML**: `isHumanMessage()` filter now skips `<task-notification>`, `<system-reminder>`, `<command-name>`, and other system-injected tags in transcript user entries.
- **Compaction snapshot decisions always empty**: Precompact hook now pulls decisions from DB plan (authoritative source) instead of relying solely on transcript extraction which only sees the tail.
- **Post-compact recovery missing in continued conversations**: Session_id changes when a conversation continues after context overflow. Snapshot query now falls back to most recent project snapshot when session_id match returns nothing.

#### Schema
- **v4 migration**: Added `expires_at` on memories, `plan_id`/`steps_completed` on sessions, `recent_decisions` on compaction_snapshots, `hook_telemetry` table.

## [1.1.1] - 2026-03-08

### Signal-to-Noise Fix

#### Changed
- **Conditional plan display in briefing**: `Plan: (none active)` now only appears post-compaction (as a negative signal confirming no plan was lost). Suppressed on startup/resume/clear where it was pure noise. Reduces briefing to ~95% signal for sessions without active plans.

#### Fixed
- **PreCompact hook ENXIO error**: `readStdinJson()` now falls back to raw fd 0 (`readFileSync(0, ...)`) when `/dev/stdin` device is unavailable. Fixes silent hook failure where compaction snapshots were never saved.

## [1.1.0] - 2026-03-08

### Signal-to-Noise Improvements

#### Changed
- **Silent success-tracker**: Removed `[CAIRN] Self-correction` context injection on re-edits. Confidence boosting still works silently in the background. Reduces ~15 tokens of noise per same-file edit.
- **Multi-pass briefing budget**: `compileBriefing()` now returns `{ text, tokenEstimate }` instead of a plain string. Session-start does 3 passes (full pitfalls → 3 → 1) before falling back to hard truncation. Prevents plan/goal context from being cut in favor of pitfalls.
- **Confidence threshold aligned**: `prompt-check.ts` now uses `RELEVANCE.MIN_CONFIDENCE_FOR_PITFALL` (0.6) instead of hardcoded 0.5. Both hooks (prompt-check and pitfall-check) use the same constant.
- **Reminder cap centralized**: Moved `MAX_FIRED_PER_PROMPT = 3` from local variable in `reminder-repository.ts` to `LIMITS.REMINDERS_MAX_FIRE_PER_PROMPT` in constants. No behavioral change.

#### Added
- **Common word filter for bash pitfall matching**: Filters 24 generic words (`npm`, `git`, `grep`, `echo`, `sudo`, etc.) before FTS lookup. Also extracts general keywords from commands (beyond the previous hardcoded `python`/`test`/`npm` check). Reduces false positive pitfall surfacing on common shell commands.
- **Richer statusline**: Now shows memory count, active plan step progress, and reminder count alongside context pressure mode. DB queries are wrapped in try/catch for silent failure.
- **Read file tracking**: Transcript parser now captures files accessed via `Read`, `Glob`, `Grep` tools (not just `Write`/`Edit`). Stored in `recent_read_files` column.
- **Initial goal extraction**: Transcript parser identifies the first substantial user message (>20 chars) as the session's original goal. Stored in `initial_goal` column.
- **Enhanced post-compaction briefing**: Now includes `Goal:` (original task), `Decided:` (latest plan decision with rationale), `Recently read:` (analyzed files), `Recently modified:` (changed files). Replaces the previous `Task:` (last raw user message) and `Recent files:` (write-only) with higher-signal alternatives.

#### Schema
- **v3 migration**: Added `recent_read_files TEXT` and `initial_goal TEXT` columns to `compaction_snapshots` table. Migration is additive (ALTER TABLE ADD COLUMN) — no data loss.

### Post-Compaction Briefing Format (Before → After)

**Before (v1.0.0):**
```
Recent files: /src/oauth.py, /src/views.py
Task: yeah that looks right
```

**After (v1.1.0):**
```
Goal: Implement OAuth2 login for the portal
Decided: Use authlib — better maintained than python-social-auth
Recently read: config.py, settings.py, base_auth.py
Recently modified: oauth.py, views.py
Approach: Using service layer pattern with dependency injection
```

## [1.0.0] - 2026-03-07

Initial release with 11 MCP tools, 8 hooks, SQLite + FTS5, 180 tests.
