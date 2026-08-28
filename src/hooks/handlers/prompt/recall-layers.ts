/**
 * Prompt-check phase: the three auto-recall layers (broad keyword, co-recall
 * prediction, vector search), external-reference surfacing, and prospective
 * reminders. Extracted verbatim from prompt-handler.ts; operates on PromptCtx.
 */
import { RELEVANCE, PREDICTION } from '../../../constants/index.js';
import { getEmbeddingModelConfig } from '../../../utils/embeddings.js';
import { passesCrossProjectGuard } from '../../../utils/cross-project-guard.js';
import { predictRelated } from '../../../utils/prediction.js';
import type { PromptCtx } from './types.js';
import { isGoalMemoryStale } from './extractors.js';

export function runRecallLayers(ctx: PromptCtx): void {
  const { client, prompt, project, fp, mode, intent, previouslyInjected, newlyInjected, budgetAvailable, budgetPush } = ctx;

  // Layer 1a: Auto-recall — broad keyword search
  if ((intent === 'task' || intent === 'question') && mode === 'normal') {
    const alreadyThisTurn = new Set(newlyInjected);
    const broadResults = client.memoryRepo.search(prompt, {
      project,
      maxResults: 3,
      minConfidence: RELEVANCE.MIN_CONFIDENCE_FOR_FACT,
    });
    const broadRelevant = broadResults
      .filter(r => r.score >= RELEVANCE.MIN_SCORE_FOR_INJECTION)
      .filter(r => passesCrossProjectGuard(r.memory, project, fp))
      .filter(r => !isGoalMemoryStale(r.memory))
      .filter(r => !alreadyThisTurn.has(r.memory.id))
      .filter(r => !previouslyInjected.has(r.memory.id));
    for (const r of broadRelevant.slice(0, 1)) {
      if (!budgetAvailable()) break;
      budgetPush(`[CAIRN] ${r.memory.kind}: ${r.memory.content}${client.memoryRepo.stalenessMarker(r.memory)}`);
      newlyInjected.push(r.memory.id);
    }
  }

  // Layer 1b: Co-recall prediction
  if ((intent === 'task' || intent === 'question') && mode === 'normal'
    && newlyInjected.length > 0 && budgetAvailable()) {
    try {
      const allInjected = new Set([...previouslyInjected, ...newlyInjected]);
      const predicted = predictRelated(client.db, newlyInjected, PREDICTION.MAX_PER_PROMPT + 2, PREDICTION.MIN_CO_COUNT);
      const preferredKinds = intent === 'task' ? PREDICTION.TASK_PREFERRED_KINDS : PREDICTION.QUESTION_PREFERRED_KINDS;
      let surfaced = 0;
      for (const predId of predicted) {
        if (!budgetAvailable() || surfaced >= PREDICTION.MAX_PER_PROMPT) break;
        if (allInjected.has(predId)) continue;
        const mem = client.memoryRepo.findById(predId);
        if (!mem || mem.invalidated || mem.confidence < RELEVANCE.MIN_CONFIDENCE_FOR_FACT) continue;
        if (isGoalMemoryStale(mem)) continue;
        if (surfaced === 0 || preferredKinds.includes(mem.kind)) {
          budgetPush(`[CAIRN] ${mem.kind}: ${mem.content}${client.memoryRepo.stalenessMarker(mem)}`);
          newlyInjected.push(predId);
          allInjected.add(predId);
          surfaced++;
        }
      }
    } catch { /* best-effort */ }
  }

  // Layer 1c: Vector search
  if ((intent === 'task' || intent === 'question') && mode === 'normal' && budgetAvailable()) {
    try {
      const allInjected = new Set([...previouslyInjected, ...newlyInjected]);
      let vectorResults: import('../../../db/memory-repository.js').RecallResult[] = [];

      // Model isolation (v26): a context vector from a different embedding
      // model is unusable as a query vector — treat as absent (proxy path).
      const cached = client.db.prepare(
        'SELECT embedding FROM context_vectors WHERE project = ? AND embedding IS NOT NULL AND embedding_model = ?'
      ).get(project, getEmbeddingModelConfig().key) as { embedding: Buffer } | undefined;

      if (cached) {
        vectorResults = client.memoryRepo.recallHybrid(
          prompt,
          cached.embedding,
          { project, maxResults: 3, minConfidence: RELEVANCE.MIN_CONFIDENCE_FOR_FACT },
        ).filter(r => r.score >= RELEVANCE.MIN_RRF_SCORE)
         .filter(r => passesCrossProjectGuard(r.memory, project, fp))
         .filter(r => !isGoalMemoryStale(r.memory))
         .filter(r => !allInjected.has(r.memory.id))
         .slice(0, 2);
      } else if (newlyInjected.length > 0) {
        vectorResults = client.memoryRepo.searchByProxyEmbedding(
          newlyInjected[0],
          allInjected,
          { project, maxResults: 2, minConfidence: RELEVANCE.MIN_CONFIDENCE_FOR_FACT },
        ).filter(r => passesCrossProjectGuard(r.memory, project, fp))
         .filter(r => !isGoalMemoryStale(r.memory));
      }

      for (const r of vectorResults) {
        if (!budgetAvailable()) break;
        budgetPush(`[CAIRN] ${r.memory.kind}: ${r.memory.content}${client.memoryRepo.stalenessMarker(r.memory)}`);
        newlyInjected.push(r.memory.id);
      }
    } catch { /* best-effort */ }
  }

  // Reference surfacing
  if ((intent === 'task' || intent === 'question') && mode === 'normal' && budgetAvailable()) {
    const REFERENCE_SYSTEM_PATTERNS = [
      /\b(linear|jira|asana|trello|notion|confluence)\b/i,
      /\b(grafana|datadog|new\s*relic|sentry|pagerduty)\b/i,
      /\b(slack|discord|teams)\b/i,
      /\b(github|gitlab|bitbucket)\b/i,
    ];
    if (REFERENCE_SYSTEM_PATTERNS.some(p => p.test(prompt))) {
      const refs = client.memoryRepo.search(prompt, {
        project,
        kind: 'reference',
        maxResults: 2,
        minConfidence: RELEVANCE.MIN_CONFIDENCE_FOR_FACT,
      });
      const allSoFar = new Set([...previouslyInjected, ...newlyInjected]);
      const relevantRefs = refs
        .filter(r => r.score >= RELEVANCE.MIN_SCORE_FOR_INJECTION)
        .filter(r => passesCrossProjectGuard(r.memory, project, fp))
        .filter(r => !allSoFar.has(r.memory.id));
      for (const r of relevantRefs) {
        if (!budgetAvailable()) break;
        budgetPush(`[CAIRN ref] ${r.memory.content}`);
        newlyInjected.push(r.memory.id);
      }
    }
  }

  // Check prospective memory (reminders)
  if ((intent === 'task' || intent === 'question') && mode !== 'minimal' && budgetAvailable()) {
    const fired = client.reminderRepo.checkAndFire(prompt, project);
    for (const r of fired) {
      if (!budgetAvailable()) break;
      budgetPush(`[CAIRN REMINDER] ${r.action.substring(0, 200)}`);
    }
  }
}
