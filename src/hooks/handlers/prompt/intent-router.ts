/**
 * Prompt-check phase: intent-specific capture + recall injection.
 * The `switch (intent)` block extracted verbatim from prompt-handler.ts,
 * operating on the shared PromptCtx.
 */
import { extractWhyContext } from '../../../utils/intent-classifier.js';
import { validateMemoryContent } from '../../../utils/validation.js';
import { CONFIDENCE, RELEVANCE } from '../../../constants/index.js';
import { passesCrossProjectGuard } from '../../../utils/cross-project-guard.js';
import type { PromptCtx } from './types.js';
import { originClientOf } from '../../shared/client-adapter.js';
import { extractDecision, isGoalMemoryStale } from './extractors.js';
import { extractCorrectionLesson } from './helpers.js';
import { isMemoryEligibleForInjection , formatMemoryContent } from '../../../utils/memory-injection.js';

export function routeIntent(ctx: PromptCtx): void {
  const { client, input, prompt, project, fp, mode, intent, previouslyInjected, newlyInjected, budgetAvailable, budgetPush } = ctx;

  switch (intent) {
    case 'correction': {
      const lesson = extractCorrectionLesson(prompt);
      const check = validateMemoryContent(lesson);
      if (check.valid) {
        client.memoryRepo.create({
          content: lesson,
          kind: 'correction',
          project: null,
          confidence: CONFIDENCE.USER_CORRECTION,
          source: 'user',
          originClient: originClientOf(input),
          fingerprint: fp,
        });
      }
      break;
    }

    case 'task': {
      const decision = extractDecision(prompt);
      if (decision) {
        const check = validateMemoryContent(decision);
        if (check.valid) {
          const why = extractWhyContext(prompt);
          client.memoryRepo.storeDecision({
            content: decision,
            project,
            source: 'user',
            originClient: originClientOf(input),
            fingerprint: fp,
            context: why ? { why } : undefined,
          });
        }
      }

      if (mode !== 'minimal') {
        const limit = mode === 'compact' ? 1 : 3;
        const results = client.memoryRepo.recall(prompt, {
          // Step 7 fold: retrieval is read-only — exposure is stamped at the
          // injection boundary (prompt-handler markRecalled), never on candidates
          // later dropped by eligibility/score/cross-project/budget filters.
          readOnly: true,
          project,
          kind: 'pitfall',
          maxResults: limit,
          minConfidence: RELEVANCE.MIN_CONFIDENCE_FOR_PITFALL,
        });

        const relevant = results
          .filter(r => isMemoryEligibleForInjection(r.memory))
          .filter(r => r.score >= RELEVANCE.MIN_SCORE_FOR_INJECTION)
          .filter(r => passesCrossProjectGuard(r.memory, project, fp))
          .filter(r => !previouslyInjected.has(r.memory.id));
        for (const r of relevant) {
          if (!budgetAvailable()) break;
          // A push the budget REFUSES was never shown — it must not be
          // stamped as exposure (codex fold block 1).
          if (budgetPush(`[WAYKEEP] ${formatMemoryContent(r.memory)}${client.memoryRepo.stalenessMarker(r.memory)}`)) {
            newlyInjected.push(r.memory.id);
          }
        }
      }

      if (mode === 'normal' && budgetAvailable()) {
        const decisions = client.memoryRepo.recall(prompt, {
          // Step 7 fold: retrieval is read-only — exposure is stamped at the
          // injection boundary (prompt-handler markRecalled), never on candidates
          // later dropped by eligibility/score/cross-project/budget filters.
          readOnly: true,
          project,
          kind: 'decision',
          maxResults: 1,
          minConfidence: RELEVANCE.MIN_CONFIDENCE_FOR_FACT,
        });
        const relevantDecisions = decisions
          .filter(r => r.score >= RELEVANCE.MIN_SCORE_FOR_INJECTION)
          .filter(r => passesCrossProjectGuard(r.memory, project, fp))
          .filter(r => !previouslyInjected.has(r.memory.id));
        for (const r of relevantDecisions) {
          if (!budgetAvailable()) break;
          // A push the budget REFUSES was never shown — it must not be
          // stamped as exposure (codex fold block 1).
          if (budgetPush(`[WAYKEEP] ${formatMemoryContent(r.memory)}${client.memoryRepo.stalenessMarker(r.memory)}`)) {
            newlyInjected.push(r.memory.id);
          }
        }
      }

      // Phase 4: goal pre-flight match. When a task prompt comes in, look
      // for a similar prior goal and surface it as a continuity signal —
      // "last time you worked on X, see decisions: …". This is the single
      // biggest compounding-learning lever: every new task starts with
      // the prior attempt's rationale surfaced next to the new prompt.
      if (mode === 'normal' && budgetAvailable()) {
        try {
          const goals = client.memoryRepo.recall(prompt, {
            // Step 7 fold: retrieval is read-only — exposure is stamped at the
            // injection boundary (prompt-handler markRecalled), never on candidates
            // later dropped by eligibility/score/cross-project/budget filters.
            readOnly: true,
            project,
            kind: 'goal',
            maxResults: 1,
            minConfidence: RELEVANCE.MIN_CONFIDENCE_FOR_FACT,
          });
          const goalHit = goals
            .filter(r => r.score >= RELEVANCE.MIN_SCORE_FOR_INJECTION)
            .filter(r => passesCrossProjectGuard(r.memory, project, fp))
            .filter(r => !isGoalMemoryStale(r.memory))
            .filter(r => !previouslyInjected.has(r.memory.id))[0];
          if (goalHit) {
            // A push the budget REFUSES was never shown — it must not be
            // stamped as exposure (codex fold block 1).
            if (budgetPush(`[WAYKEEP goal] Similar prior goal: ${formatMemoryContent(goalHit.memory)}`)) {
              newlyInjected.push(goalHit.memory.id);
            }
          }
        } catch { /* best-effort — goal match is additive */ }
      }

      break;
    }

    case 'question': {
      const decision = extractDecision(prompt);
      if (decision) {
        const check = validateMemoryContent(decision);
        if (check.valid) {
          const why = extractWhyContext(prompt);
          client.memoryRepo.storeDecision({
            content: decision,
            project,
            source: 'user',
            originClient: originClientOf(input),
            fingerprint: fp,
            context: why ? { why } : undefined,
          });
        }
      }

      if (mode === 'normal') {
        const facts = client.memoryRepo.recall(prompt, {
          // Step 7 fold: retrieval is read-only — exposure is stamped at the
          // injection boundary (prompt-handler markRecalled), never on candidates
          // later dropped by eligibility/score/cross-project/budget filters.
          readOnly: true,
          project,
          kind: 'fact',
          maxResults: 2,
          minConfidence: RELEVANCE.MIN_CONFIDENCE_FOR_FACT,
        });

        const relevant = facts
          .filter(r => r.score >= RELEVANCE.MIN_SCORE_FOR_INJECTION)
          .filter(r => passesCrossProjectGuard(r.memory, project, fp))
          .filter(r => !previouslyInjected.has(r.memory.id));
        for (const r of relevant) {
          if (!budgetAvailable()) break;
          // A push the budget REFUSES was never shown — it must not be
          // stamped as exposure (codex fold block 1).
          if (budgetPush(`[WAYKEEP] ${formatMemoryContent(r.memory)}${client.memoryRepo.stalenessMarker(r.memory)}`)) {
            newlyInjected.push(r.memory.id);
          }
        }
      }
      break;
    }

    case 'status': {
      break;
    }
  }
}
