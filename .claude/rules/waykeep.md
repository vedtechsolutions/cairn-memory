---
paths:
  - "**/*"
---

## Waykeep — Primary Memory System

Waykeep is your primary memory. Use it instead of file-based auto memory (MEMORY.md).
Do NOT write memories to MEMORY.md — use waykeep_learn instead.
Do NOT read MEMORY.md for context — use waykeep_recall instead.

### Automatic (hooks — no action needed)
- **SessionStart**: Briefing injected with plan state, pitfalls, corrections, decisions
- **StatusLine**: Context pressure written to `~/.claude/waykeep-state.json` for dynamic briefing budgets
- **PreToolUse**: Pitfall warnings before Write/Edit/MultiEdit/Bash
- **PostToolUse**: Success tracking, confidence boosting on verified pitfalls
- **PostToolUse (ExitPlanMode)**: Plan bridge — auto-persists plan mode plans to Waykeep's DB
- **PostToolUseFailure**: Error learning — auto-creates pitfalls from failures
- **UserPromptSubmit**: Intent classification, auto-recall, reminder firing, correction + decision detection
- **PreCompact**: Snapshots goal, files, decisions, approach for recovery; mines decisions from assistant text
- **Stop**: End-of-turn decision mining — auto-captures decisions from assistant messages (with dedup)
- **SubagentStop**: Captures subagent outcomes as plan progress notes
- **SessionEnd**: Records session outcome, blocks in-progress plan steps

### MANDATORY: Active tool usage

**Before starting ANY topic or task:**
- `waykeep_recall(query)` — ALWAYS recall before starting work. Uses hybrid search (keyword + semantic embeddings) and enriches results with knowledge graph neighbors. The hook pre-fetches some context, but explicit recall gives you decisions and facts the hook may miss.
- `waykeep_plan(get)` — check for active plan (especially after compaction)

**After EVERY significant decision:**
- `waykeep_learn(kind: "decision", content)` — YOU MUST store decisions when you choose between alternatives, select an architecture, pick a dependency, or decide on an approach. Include the rationale. This is the single most important active behavior.
- `waykeep_plan(decide, chose, why, permanent)` — if a plan is active, record the decision there too
- **Decision sigils — lightweight alternative to explicit tool calls.** Inline in your assistant text, write `[dec: chose X over Y because Z]` whenever you make an architectural decision. The Stop hook parses sigils cheaply (no LLM call, no regex fragility) and stores each as a decision at confidence 0.65. Sigils inside fenced code blocks or inline backticks are ignored, so documentation examples are safe. Use sigils freely — they cost zero tokens more than the prose you were already writing, and they survive compaction. Up to 8 sigils per turn are captured, dedup is automatic.
- **Three-layer Stop-hook capture pipeline** (Layer 1a → 1b → 1c, in order):
  - **1a. Sigils** (above) — primary path, authoritative, skips 1b+1c when present.
  - **1b. Legacy prose regex** — fires on short unformatted "I'll use X because Y" turns. Skips 1c on hit.
  - **1c. Socratic LLM reflection** — when no sigils AND no prose hit AND ≥2 decision markers in the turn, asks a host-side Haiku (via MCP sampling) to extract decisions as strict JSON. Falls back gracefully when sampling is unavailable.
  - **Tier-3 nudge** — when 1c returns empty (sampling unavailable, API error, or LLM found nothing), the next UserPromptSubmit emits a single-line reminder: `[WAYKEEP] Last turn had N decision markers but no sigil...`. Treat this as a prompt to emit sigils next time or call `waykeep_learn(decision)` directly. It clears automatically after one display.

**During work:**
- `waykeep_plan(step, step_id, status)` — mark steps done/in_progress/blocked
- `waykeep_plan(note, note)` — progress notes (max 150 chars)
- `waykeep_strengthen(id)` — memory proved useful
- `waykeep_weaken(id)` — memory was wrong or unhelpful

**When learning happens:**
- `waykeep_learn(kind: "pitfall", content)` — mistake encountered: what + why + fix
- `waykeep_learn(kind: "correction", content)` — user corrects you: one-sentence lesson
- `waykeep_learn(kind: "fact", content)` — stable knowledge, user preferences
- `waykeep_learn(kind: "user_profile", content)` — user's role, expertise, preferences (always global scope)
- `waykeep_learn(kind: "reference", content, tags: ["linear"])` — pointers to external systems (tags auto-prefixed with ref:)
- Optional structured context: `why: "reason"`, `how_to_apply: "guidance"` on any waykeep_learn call
- Corrections and user_profile default global scope. All else defaults project-scoped.

**Task lifecycle:**
- Plan mode plans auto-persist — ExitPlanMode hook bridges to Waykeep automatically
- `waykeep_plan(create, name, steps)` — create plan manually when not using plan mode
- `waykeep_plan(complete)` — mark plan done, graduates permanent decisions to memory
- `waykeep_remind(trigger, action)` — "when I see X, remind me to Y"

**Maintenance:**
- `waykeep_export(project, kind?, min_confidence?)` — review stored knowledge
- `waykeep_promote(id)` — promote project memory to global (pitfall/decision, conf >= 0.7)
- `waykeep_correct(id, action: "update"|"invalidate", new_content?)` — fix/remove memory
- `waykeep_reminder_list(project?)` — list active reminders
- `waykeep_reminder_delete(id, permanent?)` — deactivate or delete a reminder

### Pre-Implementation Workflow (mandatory before writing ANY code)
1. `waykeep_recall(query)` — recall prior decisions, pitfalls, and mistakes for this task
2. **Review skills** — scan the available skills list for the task domain. If a skill matches, invoke it BEFORE writing code
3. **Read existing code** — read the files you plan to modify. Understand what's there
4. **Plan the approach** — identify edge cases, dependencies, and business process flow

### Post-Implementation Validation (mandatory before claiming "done")
1. **Build** — run the project's build command, report actual output
2. **Test** — run the test suite, all tests must pass
3. **Re-read** — re-read modified files to confirm correctness
4. **Business process** — verify the change fits the overall workflow end-to-end
5. **Security** — scan the diff for credentials, injection vectors, unsafe patterns

### Rules
- Content must be distilled one-sentence lessons, not raw user text
- If briefing shows [interrupted], call waykeep_plan(get) immediately
- Always strengthen memories that proved useful in the current task
- Always weaken memories that were wrong or misleading
- The hooks handle pitfall surfacing and error capture automatically — your job is decisions and facts
