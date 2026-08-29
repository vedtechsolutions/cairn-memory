/**
 * Error learning handler — auto-encode pitfalls from tool failures.
 * Pure business logic: no stdin/stdout/process.exit. The single pipeline
 * implementation shared by the daemon route (/error-learning) and the
 * standalone entry script (hooks/error-learning.ts).
 *
 * Escalation tiers (research-informed — Reflexion, SWE-Agent, Renze 2024):
 *   1st occurrence: store pitfall + inject lesson
 *   2nd occurrence: inject lesson + "occurred before this session"
 *   3rd+ occurrence: inject lesson + category-specific alternative (positive framing)
 *
 * Tracker access is cache-first: in the daemon the SessionCache serialises
 * tracker access in-process; standalone (no cache) falls back to the locked
 * updateTracker read-modify-write so concurrent hook processes can't lose
 * updates.
 */
import type { PostToolUseFailureInput } from '../shared/hook-io.js';
import { recordRollup } from '../../db/telemetry-rollup.js';
import { ROLLUP, ROLLUP_METRICS } from '../../constants/index.js';
import type { CachedHookContext } from '../shared/db-client.js';
import { capabilitiesOf, originClientOf } from '../shared/client-adapter.js';
import { extractPatchFilePaths, patchTextOf } from '../shared/patch-paths.js';
import { classifyError } from '../../utils/error-classifier.js';
import { loadTracker, updateTracker, type EditTracker } from '../shared/edit-tracker.js';
import { projectId } from '../../utils/project-id.js';
import type { ToolEvent } from '../../utils/success-classifier.js';
import {
  CONFIDENCE,
  ESCALATION,
  ESCALATION_ALTERNATIVES,
  ESCALATION_FALLBACK,
  ESCALATION_TOOL_ALTERNATIVES,
  LIMITS,
  PROACTIVE,
} from '../../constants/index.js';
import { generateFingerprint } from '../../utils/fingerprint.js';
import { getGitHash } from '../../utils/project-scanner.js';
import { basename } from 'node:path';
import { extractAnchor, anchorToJson } from '../../utils/anchor.js';
import { EdgeRepository } from '../../db/edge-repository.js';
import { regexDistillError, regexDistillErrorStrict } from '../../utils/distillation.js';
import { now } from '../../utils/index.js';
import { recordGovernanceEventFailOpen } from '../../governance/recorder.js';
import type { RecorderDiagnostic } from '../../governance/types.js';

export interface ErrorLearningResult {
  /** Context to inject, or null */
  output: string | null;
  action: 'skip' | 'escalation' | 'warning' | 'learned-new' | 'learned-deduped';
  sessionCount: number;
  /** Error category (first classification tag) — set on escalation for telemetry. */
  category?: string;
  /** Surfaced pitfalls processed (weakened or impact-credited) after this
   *  error — diagnostics for the standalone wrapper's stderr logging. */
  surfacedProcessed?: { count: number; files: string[] };
  /** Internal-only recorder status; route output deliberately omits it. */
  recorder?: RecorderDiagnostic;
}

export async function handleErrorLearning(
  input: PostToolUseFailureInput,
  client: CachedHookContext,
): Promise<ErrorLearningResult> {
  const result = handleErrorLearningBusiness(input, client);
  // Governance recording is deliberately Claude-scoped (apply_patch
  // excluded): the governance adapter validates Claude tool shapes, and
  // Codex mutations stay outside its evidence trail — a documented
  // capability delta, not an oversight.
  if (!['Write', 'Edit', 'MultiEdit', 'Bash'].includes(input.tool_name)) return result;
  return { ...result, recorder: await recordGovernanceEventFailOpen(client.db, input) };
}

function handleErrorLearningBusiness(input: PostToolUseFailureInput, client: CachedHookContext): ErrorLearningResult {
  if (input.is_interrupt) return { output: null, action: 'skip', sessionCount: 0 };

  const errorText = input.error ?? '';
  if (!errorText) return { output: null, action: 'skip', sessionCount: 0 };

  const classification = classifyError(errorText);

  // --- Session error counting (independent of pitfall dedup) ---
  // The classifier returns errorKey even when learnable=false (deduped),
  // so we can count every occurrence for escalation detection.
  let sessionCount = 0;
  if (classification.errorKey) {
    const errorKey = classification.errorKey;
    const countError = (tracker: EditTracker): void => {
      // Session boundary detection — reset counts on new session
      if (tracker.sessionId !== input.session_id) {
        tracker.sessionErrorCounts = {};
        tracker.sessionId = input.session_id;
      }

      const entry = tracker.sessionErrorCounts[errorKey];
      sessionCount = (entry?.count ?? 0) + 1;
      tracker.sessionErrorCounts[errorKey] = {
        count: sessionCount,
        firstSeen: entry?.firstSeen ?? Date.now(),
      };

      // Record failure in toolChain so pitfall-check can detect file-specific failures
      const failFilePaths = extractFilePaths(input);
      const failTimestamp = Date.now();
      const failOutput = errorText.split('\n')[0]?.slice(0, 200);
      for (const fp of failFilePaths.length > 0 ? failFilePaths : [undefined]) {
        const failEvent: ToolEvent = {
          tool: input.tool_name,
          file: fp,
          timestamp: failTimestamp,
          success: false,
          output: failOutput,
        };
        tracker.toolChain.push(failEvent);
      }
      if (tracker.toolChain.length > LIMITS.TOOL_CHAIN_MAX) {
        tracker.toolChain = tracker.toolChain.slice(-LIMITS.TOOL_CHAIN_MAX);
      }
    };

    if (client.cache) {
      const tracker = client.cache.getTracker(input.session_id) ?? loadTracker(input.session_id);
      countError(tracker);
      client.cache.setTracker(input.session_id, tracker);
    } else {
      // Standalone: locked read-modify-write — two concurrent hook
      // processes on the same tool event must not lose updates.
      updateTracker(input.session_id, countError);
    }
  }

  // --- Investigation chain tracking ---
  if (classification.errorKey) {
    try {
      const chainProject = projectId(input.cwd);
      const errorFile = extractFilePaths(input)[0] ?? null;
      const fileLabel = errorFile ? basename(errorFile) : input.tool_name;
      const approach = errorFile ? `${input.tool_name} on ${fileLabel}` : input.tool_name;
      const outcome = errorText.split('\n')[0]?.slice(0, 150) ?? 'error';
      const attempt = { approach, outcome, timestamp: now() };

      const activeChain = client.investigationRepo.getActiveChain(chainProject, input.session_id);
      if (activeChain) {
        client.investigationRepo.appendAttempt(activeChain.id, attempt);
      } else {
        client.investigationRepo.create(chainProject, input.session_id, classification.errorKey!, attempt);
      }
    } catch { /* best-effort */ }
  }

  // --- Auto-weaken surfaced pitfalls that didn't prevent this error ---
  // If pitfalls were shown for these files but the tool still failed,
  // the advice was unhelpful — weaken those memories (unless the pitfall
  // correctly predicted the error, in which case credit it instead).
  let surfacedProcessed: ErrorLearningResult['surfacedProcessed'];
  {
    const weakenFilePaths = extractFilePaths(input);
    let cleanedUp = false;
    const applyWeaken = (tracker2: EditTracker): void => {
      const allToWeaken: string[] = [];
      const cleanupFiles: string[] = [];

      for (const fp of weakenFilePaths) {
        if (tracker2.surfacedPitfalls[fp]?.length > 0) {
          const nowMs = Date.now();
          const surfacedIds = tracker2.surfacedPitfalls[fp];
          const toWeaken = surfacedIds.filter(id => {
            const surfacedAt = tracker2.recentlySurfaced?.[id];
            return surfacedAt && (nowMs - surfacedAt) < PROACTIVE.AUTO_WEAKEN_WINDOW_MS;
          });
          allToWeaken.push(...toWeaken);
          cleanupFiles.push(fp);
        }
      }

      if (allToWeaken.length > 0) {
        const errorLower = errorText.toLowerCase();
        for (const id of allToWeaken) {
          // Check if this pitfall correctly predicted the error (content overlap)
          const mem = client.memoryRepo.findById(id);
          if (mem && CONFIDENCE.DOUBLE_IMPACT_ON_IGNORED_WARNING) {
            const contentLower = mem.content.toLowerCase();
            // Simple overlap: at least 2 words from the pitfall appear in the error
            const pitfallWords = contentLower.split(/\s+/).filter(w => w.length > 3);
            const matchCount = pitfallWords.filter(w => errorLower.includes(w)).length;
            if (matchCount >= 2) {
              // Correct prediction ignored — double impact credit, no weaken
              client.memoryRepo.incrementImpact(id);
              client.memoryRepo.incrementImpact(id);
              // Report proxy: the warning was RIGHT (the error proves it),
              // so it still counts — once, not twice: double credit is a
              // confidence policy, not evidence of double value.
              recordRollup(client.db, input.session_id, ROLLUP_METRICS.IMPACT_PROXY, 'error-learning', ROLLUP.IMPACT_PROXY_TOKENS, 1);
              continue;
            }
          }
          // Irrelevant pitfall — weaken as before
          client.memoryRepo.weakenConfidence(id);
        }
        surfacedProcessed = { count: allToWeaken.length, files: cleanupFiles };
      }

      for (const fp of cleanupFiles) {
        delete tracker2.surfacedPitfalls[fp];
      }
      cleanedUp = cleanupFiles.length > 0;
    };

    if (client.cache) {
      const tracker2 = client.cache.getTracker(input.session_id) ?? loadTracker(input.session_id);
      applyWeaken(tracker2);
      // Persist only when surfaced entries were actually cleaned up.
      if (cleanedUp) {
        client.cache.setTracker(input.session_id, tracker2);
      }
    } else {
      // Standalone: locked read-modify-write (race protection).
      updateTracker(input.session_id, applyWeaken);
    }
  }

  // --- Early exit: not learnable and no escalation ---
  if (!classification.learnable && sessionCount < ESCALATION.THRESHOLD) {
    if (sessionCount === 2 && classification.errorKey) {
      const filePath = input.tool_input.file_path as string | undefined;
      return {
        output: buildOutputJson('PostToolUseFailure', buildWarningMessage(errorText, filePath)),
        action: 'warning',
        sessionCount,
        surfacedProcessed,
      };
    }
    return { output: null, action: 'skip', sessionCount, surfacedProcessed };
  }

  // --- Escalation ---
  if (sessionCount >= ESCALATION.THRESHOLD) {
    return {
      output: buildOutputJson('PostToolUseFailure', buildEscalationMessage(
        sessionCount, input.tool_name, classification.tags, errorText,
      )),
      action: 'escalation',
      sessionCount,
      category: classification.tags[0] ?? 'unknown',
      surfacedProcessed,
    };
  }

  // --- Normal error learning ---
  const project = projectId(input.cwd);
  // Lookup-signal clients carry the command's ENTIRE merged output as
  // error text, so the first-line distillation fallback would store
  // banners/log lines as lessons (surfaced cross-agent by pitfall-check).
  // Strict mode stores nothing when no distillation pattern matched —
  // counting, escalation, and investigation chains above have happened.
  const lesson = capabilitiesOf(input).toolFailureSignal === 'lookup'
    ? regexDistillErrorStrict(input.tool_name, errorText)
    : regexDistillError(input.tool_name, errorText);
  if (lesson === null) {
    return { output: null, action: 'skip', sessionCount, surfacedProcessed };
  }

  let projectContext = null;
  try {
    const cachedGit = client.cache?.getGitState(input.cwd);
    const gitHash = cachedGit?.hash ?? getGitHash(input.cwd);
    // Check session cache first — project context is immutable per
    // (project, gitHash) pair.
    if (gitHash && client.cache) {
      projectContext = client.cache.getProjectContext(project, gitHash);
    }
    if (!projectContext && gitHash) {
      projectContext = client.contextRepo.get(project, gitHash);
      if (projectContext && client.cache) {
        client.cache.setProjectContext(project, gitHash, projectContext);
      }
    }
    if (!projectContext) projectContext = client.contextRepo.getLatest(project);
  } catch { /* best-effort */ }

  const fp = generateFingerprint({
    projectContext,
    filePath: extractFilePaths(input)[0],
    // apply_patch's command is a patch BLOB — its envelope words and diff
    // body would be baked into the STORED pitfall's fingerprint forever
    // (measured: a TS pitfall picked up "go" and "javascript" language
    // signals from a comment and an import in the diff).
    command: input.tool_name === 'apply_patch'
      ? undefined
      : input.tool_input.command as string | undefined,
    tags: classification.tags,
  });

  const anchorContent = `${lesson} ${extractFilePaths(input).join(' ')}`;
  const anchor = extractAnchor(anchorContent);
  const anchorStr = anchor ? anchorToJson(anchor) : undefined;

  const result = client.memoryRepo.storePitfall({
    content: lesson,
    tags: classification.tags,
    project,
    confidence: CONFIDENCE.AUTO_DETECTED,
    originClient: originClientOf(input),
    fingerprint: fp,
    anchor: anchorStr,
  });

  // A new pitfall (or even a dedup merge) must be visible to the next
  // pitfall-check — invalidate the skip-gate cache.
  client.cache?.bumpMemoryVersion();

  if (result.deduplicated) {
    const mem = client.memoryRepo.findById(result.id);
    if (mem) {
      return {
        output: buildOutputJson('PostToolUseFailure', `[WAYKEEP] Repeated error. Previous lesson: "${mem.content}"`),
        action: 'learned-deduped',
        sessionCount,
        surfacedProcessed,
      };
    }
    return { output: null, action: 'learned-deduped', sessionCount, surfacedProcessed };
  }

  // New mistake — create edges from previously-surfaced pitfalls
  try {
    const edgeRepo = new EdgeRepository(client.db);
    const tracker3 = client.cache?.getTracker(input.session_id) ?? loadTracker(input.session_id);
    const errorFiles = extractFilePaths(input);
    for (const efp of errorFiles) {
      for (const surfacedId of tracker3.surfacedPitfalls[efp] ?? []) {
        edgeRepo.createEdge(surfacedId, result.id, 'caused_by');
      }
    }
  } catch { /* best-effort */ }

  // Link to active investigation chain
  try {
    const activeChain = client.investigationRepo.getActiveChain(project, input.session_id);
    if (activeChain) {
      client.investigationRepo.addMemoryId(activeChain.id, result.id);
    }
  } catch { /* best-effort */ }

  return {
    output: buildOutputJson('PostToolUseFailure', `[WAYKEEP] ${lesson}`),
    action: 'learned-new',
    sessionCount,
    surfacedProcessed,
  };
}

// --- Helpers ---

/** NOT a report cost surface, deliberately: this handler's output is
 *  UNDELIVERABLE under the current wiring — error-learning is registered
 *  async on every client (init.ts relayAsync; the Codex demux discards
 *  the return), and async hook responses are never injected. Recording
 *  these strings as cost billed the user for context no model received
 *  (review round 2, reproduced). If the wiring ever turns sync, add the
 *  recording AT THE DELIVERY SITE, not here. Latent product gap filed:
 *  these four outputs are currently dead letters everywhere. */
function buildOutputJson(hookEventName: string, context: string): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName,
      additionalContext: context,
    },
  });
}

function buildEscalationMessage(
  count: number, toolName: string, tags: string[], errorText: string,
): string {
  const firstLine = errorText.split('\n')[0]?.trim().slice(0, 100) ?? 'unknown error';
  const alternative = getAlternative(toolName, tags);
  return [
    `[CAIRN ESCALATION] This error has occurred ${count} times this session: "${firstLine}"`,
    `  Try instead: ${alternative}`,
  ].join('\n');
}

function buildWarningMessage(errorText: string, filePath?: string): string {
  const firstLine = errorText.split('\n')[0]?.trim().slice(0, 100) ?? 'unknown error';
  const context = filePath ? ` (${basename(filePath)})` : '';
  return `[WAYKEEP] This error occurred before this session${context}: "${firstLine}"`;
}

function extractFilePaths(input: PostToolUseFailureInput): string[] {
  const patchText = patchTextOf(input);
  if (patchText !== null) return extractPatchFilePaths(patchText, input.cwd);

  const paths: string[] = [];
  const fp = input.tool_input.file_path as string | undefined;
  if (fp) paths.push(fp);
  if (input.tool_name === 'MultiEdit' && Array.isArray(input.tool_input.edits)) {
    for (const edit of input.tool_input.edits) {
      const editFp = (edit as Record<string, unknown>).file_path as string | undefined;
      if (editFp && !paths.includes(editFp)) paths.push(editFp);
    }
  }
  return paths;
}

function getAlternative(toolName: string, tags: string[]): string {
  for (const tag of tags) {
    if (tag in ESCALATION_ALTERNATIVES) return ESCALATION_ALTERNATIVES[tag];
  }
  if (toolName in ESCALATION_TOOL_ALTERNATIVES) return ESCALATION_TOOL_ALTERNATIVES[toolName];
  return ESCALATION_FALLBACK;
}
