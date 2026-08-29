# SNR precision fixes — Codex implementation note

Date: 2026-08-29

Branch: `review/2026-08-29-snr-precision`

Scope: the three user-requested SNR fixes only; no sync/v32 implementation changed.

## Why

A live Codex evaluation showed that Waykeep's continuity was useful but its
automatic context was too permissive: a pitfall explicitly marked `RESOLVED`
was still injected, conversational review/task language could be retained as a
decision, and proactive pitfall checks accounted for most of the measured
injection cost. The fixes below prefer false negatives over durable or repeated
context noise.

## What changed

### 1. Retired pitfalls cannot enter automatic context

`src/utils/memory-injection.ts` is the shared render-time eligibility gate.
It rejects invalidated or superseded memories and pitfall content beginning
with an explicit retirement marker:

- `RESOLVED ...`
- `[RESOLVED] ...`
- `Status: RESOLVED ...`
- `[Status: RESOLVED] ...`

The marker is deliberately start-anchored. A useful lesson containing prose
such as “the issue is resolved by retrying” is not accidentally retired.

The gate is applied defensively across the automatic surfaces: full and index
briefings, high-impact recovery, prompt keyword/vector/co-recall paths,
pre-tool fingerprint/anchor/co-recall paths, subagent context, and repeated
error-learning output. Repository briefing reads also over-fetch and filter so
resolved rows do not consume the requested result slots. Existing SQL
`superseded_by IS NULL` checks remain in place; raw-ID paths now check the
mapped supersession fields too.

Explicit user retrieval/export was not changed. This fix governs automatic
injection, not access to historical records.

### 2. Tasking conversation is not a durable decision

Prompt decision extraction now rejects meta/tasking language before applying
the existing choice-plus-rationale test. Prompts about asking, reviewing, or
evaluating, direct requests (`please`, `can you`, etc.), and conversational
phrases such as “what are your thoughts?” cannot become decision memories.

Explicit decisions such as “let's use SQLite because we need atomic writes”
continue to pass. Explicit MCP learning, plan decisions, and assistant-authored
`[dec: ...]` sigils were intentionally left unchanged.

### 3. Proactive warnings have a turn budget

The SNR golden changed deliberately from three warnings per tool call to one.
A correlated turn may inject at most one proactive item and 96 estimated
tokens, including the header. Warning state lives in the session tracker:

- `turn_id` provides the strict cross-tool boundary when available.
- `UserPromptSubmit` establishes a synthetic boundary for clients without it.
- If neither signal exists, Waykeep preserves legacy fail-open per-call
  behavior rather than treating an entire session as one turn.

Candidates stop accumulating once the single slot is filled, so memories that
were never rendered no longer receive surface/cooldown side effects. Priority
remains deterministic: recent concrete failure, edit/fail loop, rapid re-edit,
then relevance-ranked memory/reminder/investigation signals. Oversized warning
text is truncated to the remaining token allowance.

## Tests and deliberate goldens

- `tests/snr-injection-precision.test.ts` locks retirement filtering across
  briefing/prompt/pre-tool/subagent paths and locks one bounded warning across
  two tool calls in one turn, with reset on the next turn.
- `tests/prompt-check.test.ts` covers asking/reviewing/evaluating and direct
  tasking false positives.
- `tests/proactive-warnings.test.ts` explicitly records the golden change from
  3 to 1 for both per-call and per-turn limits. The expectation was tightened,
  not silently loosened.
- The private-scope co-recall differential now exercises the predictive helper
  directly. Under the one-warning cap, a second predictive item is intentionally
  unreachable in the normal handler, but the raw-ID privacy guard remains
  independently tested so a future budget change cannot reintroduce a leak.

Validation performed before handoff:

- TypeScript build and compiled relay: passed.
- Focused SNR, decision, warning, cooldown, and scope tests: passed.
- Full suite: 2,299 passed, 0 failed, 3 skipped (511 top-level tests,
  157 files); the zero-test guard passed.

## Review boundary

Claude should review this branch before merge. In particular, verify that the
start-anchored `RESOLVED` policy matches the intended authoring convention and
that one warning/96 tokens is the desired product budget. No merge to `main`
is part of this Codex task.
