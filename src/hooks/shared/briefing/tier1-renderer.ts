/** Tier 1 renderer — fixed context (header, project, git, user, plan, goal,
 *  files, approach). Always included in the full briefing. */
import type { MemoryRepository } from '../../../db/memory-repository.js';
import type { PlanRepository, Plan } from '../../../db/plan-repository.js';
import { LIMITS, TOKEN_BUDGET } from '../../../constants/index.js';
import { formatProjectContextCompact } from '../../../utils/project-scanner.js';
import { basename } from 'node:path';
import type { BriefingContext } from './types.js';
import { tokeniseForOverlap, jaccardOverlap } from './query-fingerprint.js';
import { renderGoalTiers, formatGoalTierLine } from './goal-tiers.js';
import {
  DECISION_DEDUP_JACCARD,
  truncate,
  renderResumeCursor,
  isConversationalApproach,
  formatPlanSummary,
  measureLines,
  type TierResult,
} from './render-helpers.js';

/** Tier 1: Fixed context — header, project, git, user, plan, goal, files, approach */
export function renderTier1(
  memoryRepo: MemoryRepository,
  planRepo: PlanRepository,
  ctx: BriefingContext,
): { tier: TierResult; plan: Plan | null } {
  const lines: string[] = [];
  lines.push('[Waykeep Memory Briefing]');

  if (ctx.project) {
    lines.push(`Project: ${ctx.project}`);
  }

  // Project context — skip on compact, ultra-compact single line on startup
  if (ctx.projectContext && ctx.sessionType !== 'compact') {
    const compactLine = formatProjectContextCompact(ctx.projectContext, TOKEN_BUDGET.PROJECT_CONTEXT_COMPACT_MAX_CHARS);
    if (compactLine) {
      lines.push(`Stack: ${compactLine}`);
    }
  }

  // Git working tree state
  if (ctx.gitState) {
    const parts: string[] = [];
    if (ctx.gitState.branch) parts.push(`branch: ${ctx.gitState.branch}`);
    if (ctx.gitState.uncommittedCount > 0) parts.push(`${ctx.gitState.uncommittedCount} uncommitted files`);
    if (ctx.gitState.unpushedCount > 0) parts.push(`${ctx.gitState.unpushedCount} unpushed commits`);
    if (parts.length > 0) lines.push(`Git: ${parts.join(', ')}`);
  }

  // User profile — prefer structured model, fall back to free-text memories
  if (ctx.structuredUserProfile) {
    lines.push(`User: ${ctx.structuredUserProfile}`);
  } else {
    const userProfiles = memoryRepo.topUserProfiles(LIMITS.BRIEFING_MAX_USER_PROFILES);
    if (userProfiles.length > 0) {
      lines.push('User:');
      for (const up of userProfiles) {
        lines.push(`  - ${up.content}`);
      }
    }
  }

  // Plan state
  let plan: Plan | null = null;
  if (ctx.project) {
    plan = planRepo.getActive(ctx.project);
    if (plan && ctx.sessionType === 'compact') {
      const allPending = plan.steps.every(s => s.status === 'pending');
      const planAge = Date.now() - new Date(plan.updated_at).getTime();
      const ONE_HOUR = 60 * 60 * 1000;
      if (allPending && planAge > ONE_HOUR) {
        plan = null;
      }
    }
    if (plan) {
      lines.push(formatPlanSummary(plan, ctx.interrupted));
    } else if (ctx.sessionType === 'compact') {
      lines.push('Plan: (none active)');
    }
  }

  // Recovery context for post-compaction
  if (ctx.sessionType === 'compact' && ctx.compactionSnapshot) {
    const snap = ctx.compactionSnapshot;

    // SNR v3 Commit 4: three-tier goal rendering (Now / Feature / Project).
    // Tier logic + cross-tier dedup + session-boundary staleness live in
    // renderGoalTiers so renderTier1 and compileIndexBriefing share them.
    // Research: LangGraph (fresh-start default), OnGoal (UIST 2025, goal
    // integration), GTD (Active/Someday/Reference tiers), Linear (auto-
    // archive on inactivity).
    for (const tierRender of renderGoalTiers(ctx, plan)) {
      lines.push(formatGoalTierLine(tierRender));
    }

    // Decisions from plan or transcript (Tier 1 — contextual, tied to current plan)
    if (plan && plan.decisions.length > 0) {
      const recentDecisions = plan.decisions.slice(-LIMITS.BRIEFING_MAX_DECISIONS);
      if (recentDecisions.length === 1) {
        const alt = recentDecisions[0].alternatives?.length
          ? ` (not: ${recentDecisions[0].alternatives.join(', ')})`
          : '';
        lines.push(`Decided: ${recentDecisions[0].chose} — ${recentDecisions[0].why}${alt}`);
      } else {
        lines.push('Decisions:');
        for (const d of recentDecisions) {
          const alt = d.alternatives?.length ? ` (not: ${d.alternatives.join(', ')})` : '';
          lines.push(`  - ${d.chose} — ${d.why}${alt}`);
        }
      }
    } else if (snap.recentDecisions && snap.recentDecisions.length > 0) {
      // Intra-T1 dedup: sigil-captured decisions can accumulate near-duplicates
      // when the same insight is re-articulated across turns with different
      // truncation. Collapse them with the same jaccard/prefix policy
      // renderTier2 applies cross-tier.
      const txDecisions = snap.recentDecisions.slice(-LIMITS.BRIEFING_MAX_DECISIONS);
      const seenSigs: Array<{ prefix: string; tokens: Set<string> }> = [];
      const dedupedDecisions = txDecisions.filter(d => {
        const prefix = d.chose.toLowerCase().replace(/\s+/g, ' ').slice(0, LIMITS.DECISION_DEDUP_PREFIX);
        const tokens = tokeniseForOverlap(d.chose);
        for (const sig of seenSigs) {
          if (sig.prefix === prefix) return false;
          if (jaccardOverlap(tokens, sig.tokens) >= DECISION_DEDUP_JACCARD) return false;
        }
        seenSigs.push({ prefix, tokens });
        return true;
      });
      if (dedupedDecisions.length > 0) {
        lines.push('Decisions:');
        for (const d of dedupedDecisions) {
          lines.push(`  - ${d.chose} — ${d.why}`);
        }
      }
    }

    // Recently read files
    if (snap.recentReadFiles.length > 0) {
      const readBases = snap.recentReadFiles.slice(-5).map(f => basename(f));
      lines.push(`Recently read: ${readBases.join(', ')}`);
    }

    // Recently modified files
    if (snap.recentFiles.length > 0) {
      const modBases = snap.recentFiles.slice(-5).map(f => basename(f));
      lines.push(`Recently modified: ${modBases.join(', ')}`);
    }

    // Reasoning state (Phase 5) — hypotheses and open questions
    if (snap.reasoningState) {
      if (snap.reasoningState.hypotheses.length > 0) {
        lines.push(`Hypotheses: ${snap.reasoningState.hypotheses.map(h => truncate(h, 80)).join('; ')}`);
      }
      if (snap.reasoningState.openQuestions.length > 0) {
        lines.push(`Open questions: ${snap.reasoningState.openQuestions.map(q => truncate(q, 80)).join('; ')}`);
      }
    }

    // Error context (Phase 5) — recent errors encountered
    if (snap.errorContext && snap.errorContext.length > 0) {
      // Defense-in-depth: expected to be unnecessary after reject-by-default
      // capture in transcript-parser. Kept as safety net.
      const relevantErrors = snap.errorContext.filter(e => {
        const text = e.errorText ?? e.errorKey;
        // Skip stale dist/ test artifacts
        if (/\bdist\//.test(text)) return false;
        // Skip test runner artifacts (vitest/jest progress output, symbols)
        if (/^[ℹ⎯─✓✗●○◆►▸]/.test(text)) return false;
        if (/^[-⎯─═]{4,}/.test(text)) return false;
        // Skip success messages captured as errors
        if (/\bsuccessfully\b/i.test(text)) return false;
        // Skip test runner summary lines (vitest/jest: "Test Files  2 failed", "Tests  5 passed")
        if (/^\s*(?:test\s*(?:files?|suites?)|tests?)[\s:]+/i.test(text)) return false;
        // Skip TypeScript unused-variable warnings — always transient, trivially fixable
        if (/\bTS6133\b|\bTS6196\b|\bdeclared but its value is never\b/.test(text)) return false;
        return true;
      });
      if (relevantErrors.length > 0) {
        const errorParts = relevantErrors.slice(0, 3).map(e => {
          // Prefer errorText (human-readable) over errorKey (mangled dedup key)
          const text = e.errorText ?? e.errorKey;
          const file = e.lastFile ? ` (${basename(e.lastFile)})` : '';
          return e.count > 1 ? `${text}${file} ×${e.count}` : `${text}${file}`;
        });
        lines.push(`Errors: ${errorParts.join('; ')}`);
      }
    }
  }

  // SNR v3 Commit 4: startup/clear goal rendering delegates to the shared
  // three-tier helper. Compact mode already ran this inside the snapshot
  // block above. For startup/clear there is no compaction snapshot, so
  // Now is skipped by renderGoalTiers and only Feature + Project surface
  // (when their queries turned something up in session-start-handler).
  if (ctx.sessionType === 'startup' || ctx.sessionType === 'clear') {
    for (const tierRender of renderGoalTiers(ctx, plan)) {
      lines.push(formatGoalTierLine(tierRender));
    }
  }

  // Phase 2: resume cursor — rendered on both compact and startup paths when
  // fresh. Suppressed when older than RESUME_CURSOR_STALE_MS or when the
  // referenced file no longer exists (e.g. git clean between sessions).
  const cursorLine = renderResumeCursor(ctx.lastEditCursor);
  if (cursorLine) {
    lines.push(cursorLine);
  }

  // Cross-session resume context + quality signal
  if (ctx.sessionType === 'startup' || ctx.sessionType === 'clear') {
    if (ctx.previousSessionQuality?.summary) {
      const taskCtx = ctx.previousSessionSummary ? ` — ${ctx.previousSessionSummary}` : '';
      lines.push(`Previous session: ${ctx.previousSessionQuality.summary}${taskCtx}`);
    } else if (ctx.previousSessionSummary) {
      lines.push(`Previous session: ${ctx.previousSessionSummary}`);
    }
  }

  // Interrupted session warning
  if (ctx.interrupted) {
    lines.push('[interrupted] Previous session ended unexpectedly. Call cairn_plan(get) for full state.');
  }

  // Approach (compact only — last section of T1)
  if (ctx.sessionType === 'compact' && ctx.compactionSnapshot?.approachNotes.length) {
    const lastNote = ctx.compactionSnapshot.approachNotes[ctx.compactionSnapshot.approachNotes.length - 1];
    if (!isConversationalApproach(lastNote)) {
      // Strip markdown formatting and flatten to single line for clean briefing display
      const cleaned = lastNote
        .replace(/^#{1,6}\s+/gm, '')    // Markdown headers
        .replace(/\*\*/g, '')           // Bold markers
        .replace(/`([^`]*)`/g, '$1')   // Inline code → plain text
        .replace(/\n+/g, ' ')          // Flatten to single line
        .replace(/\s{2,}/g, ' ')       // Collapse whitespace
        .trim();
      if (cleaned.length > 20) {
        lines.push(`Approach: ${truncate(cleaned, TOKEN_BUDGET.BRIEFING_APPROACH_MAX_CHARS)}`);
      }
    }
  }

  return { tier: measureLines(lines), plan };
}
