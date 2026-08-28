/**
 * Prompt check handler — pure business logic extracted from prompt-check.ts.
 * Takes parsed input + DB client, returns output lines (or null).
 * No stdin/stdout/process.exit — suitable for both standalone hook and daemon.
 *
 * Facade: this module owns setup, skip-gate caching, and tracker persistence,
 * and orchestrates the phases in ./prompt/ (nudges → auto-capture → intent
 * routing → recall layers). The per-call shared state lives on PromptCtx.
 */
import type { UserPromptSubmitInput } from '../shared/hook-io.js';
import type { CachedHookContext } from '../shared/db-client.js';
import { SessionCache } from '../shared/session-cache.js';
import { classifyIntent } from '../../utils/intent-classifier.js';
import { readState } from '../shared/state-io.js';
import { projectId } from '../../utils/project-id.js';
import { TOKEN_BUDGET } from '../../constants/index.js';
import { generateFingerprint } from '../../utils/fingerprint.js';
import { getGitHash } from '../../utils/project-scanner.js';
import type { ProjectContext } from '../../utils/project-scanner.js';
import { loadTracker, saveTracker } from '../shared/edit-tracker.js';
import type { PromptCtx, PromptCheckResult } from './prompt/types.js';
import { isSystemMessage } from './prompt/helpers.js';
import { applyWorkflowNudges, applyAutoCapture } from './prompt/nudges.js';
import { routeIntent } from './prompt/intent-router.js';
import { runRecallLayers } from './prompt/recall-layers.js';

// Re-exports preserving the pre-split public surface.
export type { PromptCheckResult } from './prompt/types.js';
export { extractDecision, isGoalMemoryStale } from './prompt/extractors.js';

const EMPTY: PromptCheckResult = { output: null, intent: 'unknown', injections: 0 };

export function handlePromptCheck(input: UserPromptSubmitInput, client: CachedHookContext): PromptCheckResult {
  const prompt = input.prompt ?? '';
  if (!prompt.trim()) return EMPTY;

  // Skip system-injected messages
  if (isSystemMessage(prompt)) return EMPTY;

  // Check context pressure
  const state = readState();
  if (state.mode === 'critical') return EMPTY;

  const intent = classifyIntent(prompt);
  const project = projectId(input.cwd);

  // Load project context for fingerprint generation (cached git hash eliminates subprocess)
  let projectCtx: ProjectContext | null = null;
  try {
    const cachedGit = client.cache?.getGitState(input.cwd);
    const gitHash = cachedGit?.hash ?? getGitHash(input.cwd);
    if (!cachedGit && client.cache) {
      client.cache.setGitState(input.cwd, gitHash, null);
    }
    // Check session cache before hitting the DB — project context is keyed
    // by (project, gitHash) and is immutable per that pair.
    if (gitHash && client.cache) {
      projectCtx = client.cache.getProjectContext(project, gitHash);
    }
    if (!projectCtx && gitHash) {
      projectCtx = client.contextRepo.get(project, gitHash);
      if (projectCtx && client.cache) {
        client.cache.setProjectContext(project, gitHash, projectCtx);
      }
    }
    if (!projectCtx) projectCtx = client.contextRepo.getLatest(project);
  } catch { /* best-effort */ }

  const fp = generateFingerprint({ projectContext: projectCtx });

  const output: string[] = [];

  // Per-turn token budget enforcement
  let injectionTokens = 0;
  const budgetAvailable = () => injectionTokens < TOKEN_BUDGET.PER_TURN_MAX;
  const budgetPush = (line: string): boolean => {
    const cost = Math.ceil(line.length / 4);
    if (injectionTokens + cost > TOKEN_BUDGET.PER_TURN_MAX) return false;
    injectionTokens += cost;
    output.push(line);
    return true;
  };

  // Layer 2a: Compliance nudge
  const tracker = client.cache?.getTracker(input.session_id) ?? loadTracker(input.session_id);
  if (tracker.sessionId && tracker.sessionId !== input.session_id) {
    tracker.preflightFired = false;
    tracker.complianceNudgeFired = false;
    tracker.decisionReminderFired = false;
    tracker.injectedMemoryIds = [];
  }

  // --- Skip-gate cache lookup (null-only) ---
  // Conservative policy: only null outputs are ever served from cache. The
  // handler's side-effect flags (preflightFired, complianceNudgeFired,
  // decisionReminderFired) change state on each fire, so non-null caching
  // would suppress those flag sets on subsequent calls. In practice the hit
  // rate here is low because prompts are usually unique — this is mainly
  // about consistency with pitfall-handler and protection against burst
  // duplicates where the same prompt fires twice.
  //
  // Key components: prompt text prefix, intent, mode, memoryVersion, and a
  // flags snapshot so any flag transition forces a miss.
  const promptKey = `${prompt.length}|${prompt.slice(0, 200)}`;
  const flagsSnapshot = `${tracker.preflightFired ? 1 : 0}${tracker.complianceNudgeFired ? 1 : 0}${tracker.decisionReminderFired ? 1 : 0}`;
  const skipGateKey = client.cache ? SessionCache.skipGateKey({
    hookName: 'prompt-check',
    contextMode: state.mode,
    sessionStateHash: `${promptKey}|flags=${flagsSnapshot}|errors=${Object.values(tracker.sessionErrorCounts).reduce((s, e) => s + (e?.count ?? 0), 0)}`,
    extra: intent,
  }) : null;
  if (skipGateKey && client.cache) {
    const cached = client.cache.getSkipGate(skipGateKey);
    if (cached && cached.output === null) {
      return { output: null, intent, injections: 0 };
    }
  }

  // Briefing effectiveness measurement
  if (tracker.briefingEffectiveness?.awaitingFirstPrompt) {
    // Clear flag — measured (telemetry handled by caller if needed)
    tracker.briefingEffectiveness = null;
    if (client.cache) {
      client.cache.setTracker(input.session_id, tracker);
    } else {
      saveTracker(tracker, input.session_id);
    }
  }
  tracker.sessionId = input.session_id;

  const ctx: PromptCtx = {
    client,
    input,
    prompt,
    project,
    fp,
    intent,
    mode: state.mode,
    tracker,
    output,
    previouslyInjected: new Set(tracker.injectedMemoryIds),
    newlyInjected: [],
    budgetAvailable,
    budgetPush,
  };

  applyWorkflowNudges(ctx);
  applyAutoCapture(ctx);
  routeIntent(ctx);
  runRecallLayers(ctx);

  const { newlyInjected } = ctx;

  // Cache current prompt for MCP server to embed
  if ((intent === 'task' || intent === 'question') && prompt.length > 20) {
    try {
      client.db.prepare(`
        INSERT INTO context_vectors (project, pending_prompt, updated_at)
        VALUES (?, ?, datetime('now'))
        ON CONFLICT(project) DO UPDATE SET pending_prompt = ?, updated_at = datetime('now')
      `).run(project, prompt.slice(0, 500), prompt.slice(0, 500));
    } catch { /* best-effort */ }
  }

  // Persist tracker state
  if (newlyInjected.length > 0) {
    tracker.injectedMemoryIds = [...new Set([...tracker.injectedMemoryIds, ...newlyInjected])];
  }
  if (client.cache) {
    client.cache.setTracker(input.session_id, tracker);
  } else {
    saveTracker(tracker, input.session_id);
  }

  const finalOutput = output.length > 0 ? output.join('\n') : null;

  // Cache ONLY null outputs — non-null outputs carry side-effect semantics
  // (flag sets, injected memory IDs) that must not be skipped on replay.
  if (skipGateKey && client.cache && finalOutput === null) {
    client.cache.setSkipGate(skipGateKey, null);
  }

  return {
    output: finalOutput,
    intent,
    injections: output.length,
  };
}
