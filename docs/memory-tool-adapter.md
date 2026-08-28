# Memory-Tool Adapter: Cairn as a Claude memory backend

Cairn implements the handler side of Anthropic's `memory_20250818` tool:
Claude reads and edits its memory through the standard six file commands
(`view`, `create`, `str_replace`, `insert`, `delete`, `rename`) while every
write lands in Cairn's structured store — same records, same smart-merge
gateway, same truth maintenance as `cairn_learn`/`cairn_recall`.

Design contract: `docs/plans/2026-07-22-w4-memory-tool-adapter-design.md`
(frozen v3.1). This document describes the as-built behavior.

## Quick start

Install the supported SDK first — the adapter is verified against the
exact-pinned `@anthropic-ai/sdk@0.113.0` (see the upgrade policy below):

```bash
npm install @anthropic-ai/sdk@0.113.0
```

```ts
import Anthropic from '@anthropic-ai/sdk';
import { betaMemoryTool } from '@anthropic-ai/sdk/helpers/beta/memory';
import { openDatabase } from 'cairn-memory/dist/src/db/connection.js';
import { PlanRepository } from 'cairn-memory/dist/src/db/plan-repository.js';
import { createMemoryToolHandlers } from 'cairn-memory/dist/src/memory-tool/sdk-adapter.js';

const db = openDatabase(); // resolves the default ~/.cairn/cairn.db
const tool = betaMemoryTool(createMemoryToolHandlers({
  db,
  planRepo: new PlanRepository(db),
}));

const client = new Anthropic(); // ANTHROPIC_API_KEY from the environment
const runner = client.beta.messages.toolRunner({
  model: 'claude-sonnet-4-5',
  max_tokens: 2048,
  messages: [{ role: 'user', content: 'Remember what we decided about retries.' }],
  tools: [tool],
});
const finalMessage = await runner.runUntilDone();
```

Handlers are synchronous (better-sqlite3), RETURN contract strings, and
signal errors by THROWING messages **without** an `Error: ` prefix — the
SDK runner wraps thrown errors into the `is_error` tool_result and adds
the single prefix itself.

## Virtual filesystem

| Path | Meaning |
|---|---|
| `/memories` | root listing (two levels deep, rendered sizes) |
| `/memories/global/<category>.md` | materialized global records (`project IS NULL`) |
| `/memories/p-<base64url>/<category>.md` | materialized records for one exact project scope |
| `/memories/p-<base64url>/plan.md` | READ-ONLY rendering of the active plan (PlanRepository-backed) |
| anything else under `/memories/**` | free-form files (`memory_files` table) |

Categories: `pitfalls`, `decisions`, `facts`, `corrections`, `references`,
`patterns` (kinds `pattern` + `goal`), and `user-profile` (global only).
A category file **exists iff it has active records**. Project segments are
unpadded UTF-8 base64url under the `p-` prefix; decoding is canonical
(re-encode must reproduce the segment exactly) and hostile names — dots,
slashes, `global`, traversal — cannot claim materialized ownership.
`task_state` is deliberately unmapped: invisible to the tool and never
touched by directory-level operations.

Path validation is fail-closed: control bytes, raw and percent-encoded
traversal (any encoding depth), backslashes, and out-of-tree paths reject
with `invalid path … — memory paths must stay within /memories`.

## Records, CAS tokens, and the edit grammar

Materialized files render one block per record:

```
- [fac:3f2a9c1b@2] content: "the audit log is immutable by policy"
  why: "compliance requirement"
  tags: ["audit"]
```

- Token: `[<code>:<idPrefix>@<revision>]` — codes `pit dec cor fac usr ref
  pat gol`; the id prefix is 8 hex chars, automatically extended
  (8→12→16→…→full id) whenever ids collide; `revision` is a structural CAS
  counter bumped by a database trigger on every rendered-semantic write
  (schema v27), including writes from decay, feedback, and maintenance.
- Continuation fields in fixed order `why:`, `how:`, `tags:` — each at
  most once, one-line JSON values. On update, **omission preserves** a
  field; `null` (or `[]` for tags) explicitly clears it. `confidence:` is
  system-managed and rejected if edited.
- Edits go through `str_replace`: `old_str` must contain **whole rendered
  blocks copied verbatim** — the canonical form, collision-extended prefix
  included; a token alone never authorizes replacing content the model has
  not actually seen. `new_str` blocks with tokens must match an `old_str`
  token exactly (kind, id, and old revision); token-less `new_str` blocks
  create; omitting an `old_str` record deletes (soft-invalidates) it.
  Duplicate record identities are rejected on both sides.
- A stale token (`@rev` no longer current) fails the WHOLE edit:
  `stale record [fac:…@1] — its current revision is 2. View … again before
  editing.`
- Creates run through the same smart-merge gateway as `cairn_learn`:
  a duplicate of an existing record rejects with that record's canonical
  token; a write that would supersede an existing record rolls back and
  reports the post-rollback token; blocks that duplicate or supersede
  each other within one command get a dedicated token-less error;
  standing contradictions are allowed (non-destructive `contradicts` edge).

## Command guarantees

- Every mutating command runs ONE immediate write transaction covering all
  checks (existence, CAS resolution, canonical verification, line
  validation) and writes. Any failure rolls back with zero mutation.
- Existence is decided by RAW active rows — corrupt-but-active rows keep
  their file existing, listed, wholly movable, and deletable (they render
  as a counted `[cairn: N records unrenderable — see logs]` warning).
- Directory deletion touches only VFS-owned kinds, LIKE-escapes free-form
  path matching (base64url contains `_`), and atomically rejects while an
  active plan exists in the directory. `rename` moves whole category files
  across scopes (same category only); directory renames are not supported.
- `view` renders 6-wide right-aligned line numbers; `view_range` ends
  beyond EOF are errors (only `-1` is open-ended); output truncates at the
  last whole line ≤16,000 chars with a paging marker (zero content lines
  when even the first line exceeds the cap).
- **Frozen paging**: a full `view` freezes the rendering under ONE
  canonical cache key (path aliases share it); `view_range` pages serve
  that rendering, so re-ranking between pages can never duplicate or omit
  records. The cache is bounded (LRU 8 / 5-min TTL / 4 MiB), invalidated
  ONLY after successful commits; an expired freeze re-renders with a
  visible `[fresh rendering — line numbers may differ from any earlier
  view]` notice.
- Free-form files: 64 KiB per file, 256 files, 16 MiB aggregate — checked
  inside the write transaction (overwrites counted by delta), with a
  schema-level byte CHECK as the last line of defense.

## Round-trip v2 (portable export/restore)

`cairn_export` emits v2 sections — a human heading plus one line of
canonical JSON (`data: {…}`, recursively sorted keys) — lossless for
multiline context, `##`-bearing content, fenced bodies, and full
fingerprint arrays. Free-form files export as `## File:` sections on
fully unfiltered exports only.

The portable contract is exactly twelve fields: `id, kind, content,
confidence, source, tags, context, fingerprint, project, expires_at,
anchor, created_at`. Out of scope by design: revision, telemetry,
embeddings, graph edges, inactive/superseded records. Concretely:
restoring into an **empty target** starts revision at 1 with zeroed
telemetry; **overwriting an existing id** replaces the portable fields
and clears the embedding (the backfill worker re-embeds), while existing
telemetry remains, revision advances through the semantic trigger, and
existing graph edges stay untouched. Export is a fidelity boundary:
every candidate validates through the same gate the parser applies on
import, so corrupt stored rows fail the export naming the record id and
field — an emitted document always reparses cleanly.

`cairn_ingest` modes:

- `learn` (default): current gateway semantics — dedup, merge, confidence
  boost, conflict detection. v1 markdown (`## Kind: heading` sections)
  still parses with unchanged diagnostics.
- `restore`: strict upsert-by-FULL-id — no merge, no boosts, no conflict
  detection, id-preserving. Whole-document atomic: parser errors, v1
  sections, missing ids, duplicate ids/paths reject before any mutation;
  all writes run in one immediate transaction; imported file paths must
  be exact canonical free-form paths (the VFS router is the authority).

## SDK contract and upgrade policy

- `@anthropic-ai/sdk` is an exact-pinned devDependency; the adapter itself
  has zero runtime SDK imports (local structural types).
- `src/memory-tool/sdk-canary.ts` is a compile-only assignability check in
  the normal tsc build — SDK handler-shape drift fails the build before
  any behavioral test runs.
- Two behavioral layers re-verify on every deliberate SDK upgrade:
  (a) all six commands through `betaMemoryTool().run()`, success and
  error; (b) the SDK-visible `is_error` tool_result golden through the
  PUBLIC runner with a fake client. SDK upgrades are deliberate reviewed
  commits, excluded from auto-bumping.
- All contract-visible error text lives in ONE table:
  `src/memory-tool/errors.ts`.

## Module map (`src/memory-tool/`)

| Module | Role |
|---|---|
| `path-router.ts` | pure path validation/normalization, routing, project-segment codec, VFS-owned kinds |
| `materializer.ts` | deterministic rendering: ordering, token prefixes, block grammar output, per-row failure containment |
| `render-cache.ts` | bounded frozen-rendering cache (injectable clock) |
| `block-parser.ts` | strict §5 grammar parser (fail-closed) |
| `cas.ts` | token resolution, revision CAS, canonical old_str verification |
| `gateway-planner.ts` | token-less create preflight/execution; post-rollback error identities |
| `record-updater.ts` | tokened-block update application (one CAS bump per field edit) |
| `command-handlers.ts` | the six commands; transactions; cache invalidation |
| `free-form-store.ts` | `memory_files` operations under the caps |
| `listings.ts` | directory/root listing builders |
| `view-renderer.ts` | numbering, truncation, ranges, plan rendering |
| `round-trip.ts` | export format v2, payload validation, VFS file gate |
| `errors.ts` | the contract error table + planner marker classes |
| `sdk-adapter.ts` / `sdk-canary.ts` | SDK-facing handlers + compile canary |
