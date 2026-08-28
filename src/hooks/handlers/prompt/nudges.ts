/**
 * Prompt-check phase: workflow nudges (Layer 2) and prompt-driven auto-capture
 * of confirmations, user-profile signals, and external references.
 * Extracted verbatim from prompt-handler.ts; operates on the shared PromptCtx.
 */
import { isPositiveConfirmation, detectUserProfile, detectReference } from '../../../utils/intent-classifier.js';
import { UserModelRepository, type UserDimension } from '../../../db/user-model-repository.js';
import { validateMemoryContent } from '../../../utils/validation.js';
import { CONFIDENCE } from '../../../constants/index.js';
import type { PromptCtx } from './types.js';
import { checkTranscriptForCairnCalls, hasEntityTerms, summarizeRecentActions } from './helpers.js';

/** Layer 2a/2b/2c workflow reminders — pre-flight, compliance, decision. */
export function applyWorkflowNudges(ctx: PromptCtx): void {
  const { prompt, mode, tracker, output, budgetPush, input } = ctx;

  // Pre-flight workflow reminder
  if (ctx.intent === 'task' && !tracker.preflightFired && mode === 'normal'
    && prompt.length > 50 && hasEntityTerms(prompt)) {
    budgetPush('[CAIRN] Task detected. Pre-flight: cairn_recall → review skills → read existing code → plan approach.');
    tracker.preflightFired = true;
  }

  if (ctx.intent === 'task' && !tracker.complianceNudgeFired && mode === 'normal'
    && prompt.length > 50 && tracker.toolChain.length > 0 && hasEntityTerms(prompt)) {
    const hasCairnCalls = checkTranscriptForCairnCalls(input.transcript_path);
    if (!hasCairnCalls) {
      output.push('[CAIRN] No explicit recall this session. Consider cairn_plan(get) for active plans and cairn_recall(query) for prior decisions.');
      tracker.complianceNudgeFired = true;
    }
  }

  // Layer 2b: Decision reminder
  if (!tracker.decisionReminderFired && mode === 'normal' && tracker.toolChain.length >= 3) {
    const recentChain = tracker.toolChain.slice(-6);
    const hasEdits = recentChain.some(t => t.tool === 'Edit' || t.tool === 'Write');
    const hasBashSuccess = recentChain.some(t => t.tool === 'Bash' && t.success);
    if (hasEdits && hasBashSuccess) {
      output.push('[CAIRN] You have been making changes successfully. If you made architectural decisions, store them with cairn_learn(kind: "decision", content: "chose X because Y").');
      tracker.decisionReminderFired = true;
    }
  }

  // Layer 2c: Pending decision nudge (tier-3 safety net for Layer 1c).
  //
  // Stop handler sets tracker.pendingDecisionNudge when the prior turn
  // had decision markers but no sigils AND the Socratic reflection
  // returned empty (sampling unavailable, API error, or the LLM found
  // nothing). Surface one short line so the agent knows to emit sigils
  // or call cairn_learn(decision) next time. Always clear the flag
  // after reading, so it's at-most-once per drop.
  //
  // Intentionally runs regardless of mode — the nudge is tiny (one line)
  // and high-signal. It's the last-ditch reminder when reflection failed.
  if (tracker.pendingDecisionNudge > 0) {
    const n = tracker.pendingDecisionNudge;
    output.push(`[CAIRN] Last turn had ${n} decision marker${n === 1 ? '' : 's'} but no sigil and no auto-extraction. Next time emit [dec: chose X because Y] inline or call cairn_learn(kind: "decision").`);
    tracker.pendingDecisionNudge = 0;
  }
}

/** Prompt-driven auto-capture: positive confirmations, user-profile signals,
 *  and external-reference signals. */
export function applyAutoCapture(ctx: PromptCtx): void {
  const { client, prompt, project, fp, mode, tracker } = ctx;

  // Positive confirmation capture
  if (isPositiveConfirmation(prompt) && mode !== 'minimal') {
    const recentChain = tracker.toolChain.slice(-5);
    const confirmedAction = summarizeRecentActions(recentChain);
    if (confirmedAction) {
      const check = validateMemoryContent(confirmedAction);
      if (check.valid) {
        client.memoryRepo.storeDecision({
          content: confirmedAction,
          project,
          source: 'confirmed',
          confidence: CONFIDENCE.CONFIRMED,
          fingerprint: fp,
        });
      }
    }
  }

  // --- Auto-capture: user profile signals ---
  if (mode !== 'minimal') {
    const profileSignal = detectUserProfile(prompt);
    if (profileSignal) {
      const existing = client.memoryRepo.search(profileSignal.content, {
        kind: 'user_profile',
        maxResults: 1,
        minConfidence: 0,
      });
      if (existing.length === 0 || existing[0].score < 0.5) {
        client.memoryRepo.create({
          content: profileSignal.content,
          kind: 'user_profile',
          project: null,
          confidence: CONFIDENCE.AUTO_DETECTED,
          source: 'learned',
        });
      }

      if (profileSignal.dimensions && profileSignal.dimensions.length > 0) {
        try {
          const userModelRepo = new UserModelRepository(client.db);
          for (const dim of profileSignal.dimensions) {
            userModelRepo.upsert(dim.dimension as UserDimension, dim.key, dim.value);
          }
        } catch { /* best-effort */ }
      }
    }
  }

  // --- Auto-capture: external reference signals ---
  if (mode !== 'minimal') {
    const refSignal = detectReference(prompt);
    if (refSignal) {
      const existing = client.memoryRepo.search(refSignal.content, {
        kind: 'reference',
        maxResults: 1,
        minConfidence: 0,
      });
      if (existing.length === 0 || existing[0].score < 0.5) {
        client.memoryRepo.create({
          content: refSignal.content,
          kind: 'reference',
          project,
          tags: refSignal.tags,
          confidence: CONFIDENCE.AUTO_DETECTED,
          source: 'learned',
        });
      }
    }
  }
}
