/**
 * Auxiliary pitfall-check signals: reminders, predictive pre-fetch, and
 * investigation-chain surfacing. Each pass mutates ctx.warnings/ctx.tracker
 * in place, matching the pre-split inline blocks in handlePitfallCheck.
 */
import { PROACTIVE } from '../../../constants/index.js';
import { getGitWorkingState } from '../../../utils/project-scanner.js';
import { predictRelated } from '../../../utils/prediction.js';
import { emptyConditionContext, type ConditionContext } from '../../../utils/condition-evaluator.js';
import { passesCrossProjectGuard } from '../../../utils/cross-project-guard.js';
import type { PitfallPassCtx } from './memory-recall.js';
import { isMemoryEligibleForInjection } from '../../../utils/memory-injection.js';

/** File-triggered reminders */
export function applyFileReminders(ctx: PitfallPassCtx): void {
  const { client, warnings, project, filePath } = ctx;
  if (filePath && warnings.length < PROACTIVE.MAX_WARNINGS_PER_CALL) {
    try {
      const fileReminders = client.reminderRepo.checkFileReminders(filePath, project);
      for (const r of fileReminders) {
        if (warnings.length >= PROACTIVE.MAX_WARNINGS_PER_CALL) break;
        warnings.push(`Reminder: ${r.action}`);
      }
    } catch { /* best-effort */ }
  }
}

/** Conditional reminders */
export function applyConditionalReminders(ctx: PitfallPassCtx): void {
  const { input, client, tracker, warnings, project, filePath, command, contextMode } = ctx;
  if (warnings.length < PROACTIVE.MAX_WARNINGS_PER_CALL) {
    try {
      const condCtx: ConditionContext = {
        ...emptyConditionContext(),
        tool_name: input.tool_name,
        file_path: filePath ?? null,
        command: command ?? null,
        has_recent_errors: warnings.length > 0,
        error_count: Object.values(tracker.sessionErrorCounts).reduce((s, e) => s + e.count, 0),
        context_mode: contextMode,
      };
      try {
        const cachedGit = client.cache?.getGitState(input.cwd);
        if (cachedGit?.branch) {
          condCtx.branch = cachedGit.branch;
        } else {
          const gitSt = getGitWorkingState(input.cwd);
          if (gitSt?.branch) condCtx.branch = gitSt.branch;
        }
      } catch { /* best-effort */ }
      const condReminders = client.reminderRepo.checkConditionalReminders(condCtx, project);
      for (const r of condReminders) {
        if (warnings.length >= PROACTIVE.MAX_WARNINGS_PER_CALL) break;
        warnings.push(`Reminder: ${r.action}`);
      }
    } catch { /* best-effort */ }
  }
}

/** Predictive pre-fetch: surface co-recalled memories */
export function applyPredictivePrefetch(ctx: PitfallPassCtx): void {
  const { client, tracker, warnings, surfacedPitfallIds } = ctx;
  if (warnings.length < PROACTIVE.MAX_WARNINGS_PER_CALL && surfacedPitfallIds.length > 0) {
    try {
      const predicted = predictRelated(client.db, surfacedPitfallIds, 1);
      for (const predId of predicted) {
        if (warnings.length >= PROACTIVE.MAX_WARNINGS_PER_CALL) break;
        const mem = client.memoryRepo.findById(predId);
        // Co-recall pairs carry no project dimension: guard the raw-id
        // dereference like every fetched candidate (a private project's
        // pitfall must never ride a co-recall edge into another project).
        if (mem && mem.kind === 'pitfall' && isMemoryEligibleForInjection(mem)
          && passesCrossProjectGuard(mem, ctx.project, ctx.queryFp)) {
          warnings.push(mem.content);
          tracker.injectedMemoryIds = tracker.injectedMemoryIds ?? [];
          if (!tracker.injectedMemoryIds.includes(predId)) {
            tracker.injectedMemoryIds.push(predId);
          }
        }
      }
    } catch { /* best-effort */ }
  }
}

/** Investigation chain surfacing */
export function applyInvestigationSignals(ctx: PitfallPassCtx): void {
  const { input, client, warnings, project, isEditTool } = ctx;
  if (isEditTool && warnings.length < PROACTIVE.MAX_WARNINGS_PER_CALL) {
    try {
      const investigationRepo = client.investigationRepo;
      const activeChain = investigationRepo.getActiveChain(project, input.session_id);
      if (activeChain) {
        const approaches = activeChain.attempts.slice(-3).map(a => a.approach).join(', ');
        warnings.push(`Active investigation: "${activeChain.trigger_error.slice(0, 60)}" — tried: ${approaches}`);
      } else {
        const resolved = investigationRepo.getRecentResolved(project, PROACTIVE.MAX_INVESTIGATION_CHAINS);
        for (const chain of resolved) {
          if (warnings.length >= PROACTIVE.MAX_WARNINGS_PER_CALL) break;
          if (chain.resolution) {
            warnings.push(`Prior investigation: "${chain.trigger_error.slice(0, 60)}" → ${chain.resolution.slice(0, 80)}`);
          }
        }
      }
    } catch { /* best-effort — table may not exist yet */ }
  }
}
