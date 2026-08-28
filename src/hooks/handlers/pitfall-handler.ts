/**
 * Pitfall check handler — pure business logic extracted from pitfall-check.ts.
 * Takes parsed input + DB client, returns output string (or null).
 * No stdin/stdout/process.exit — suitable for both standalone hook and daemon.
 *
 * Facade: helper clusters live in ./pitfall/ — this module keeps the
 * handlePitfallCheck entry point and re-exports the public surface.
 */
import type { PreToolUseInput } from '../shared/hook-io.js';
import type { CachedHookContext } from '../shared/db-client.js';
import { readState } from '../shared/state-io.js';
import { projectId } from '../../utils/project-id.js';
import { basename, extname } from 'node:path';
import { loadTracker, saveTracker } from '../shared/edit-tracker.js';
import { passesCrossProjectGuard, deriveProjectIdentityTokens } from '../../utils/cross-project-guard.js';
import { PROACTIVE, RELEVANCE } from '../../constants/index.js';
import { SessionCache } from '../shared/session-cache.js';
import { isReadOnlyCommand } from './pitfall/readonly-command.js';
import { extractFilePaths } from './pitfall/input-extract.js';
import { sessionStateHash } from './pitfall/recall-cache.js';
import { applySessionWarnings } from './pitfall/session-warnings.js';
import { buildPitfallQuery } from './pitfall/query-builder.js';
import {
  type PitfallPassCtx,
  runFingerprintPitfallRecall,
  runAnchorPitfallRecall,
  runAnchorDecisionRecall,
  runFingerprintDecisionRecall,
} from './pitfall/memory-recall.js';
import {
  applyFileReminders,
  applyConditionalReminders,
  applyPredictivePrefetch,
  applyInvestigationSignals,
} from './pitfall/auxiliary-signals.js';

// Re-export so existing importers (tests/pitfall-cross-project-guard.test.ts)
// keep working — canonical impl now lives in src/utils/cross-project-guard.ts.
export { passesCrossProjectGuard };

// Re-export — canonical impl now lives in ./pitfall/readonly-command.ts;
// tests/pitfall-readonly-command.test.ts imports from this path.
export { isReadOnlyCommand };

export interface PitfallCheckResult {
  /** JSON string to write to stdout (PreToolUse allow output), or null for no output */
  output: string | null;
  /** Number of pitfalls surfaced (for telemetry) */
  pitfallsSurfaced: number;
}

const EMPTY: PitfallCheckResult = { output: null, pitfallsSurfaced: 0 };

export function handlePitfallCheck(input: PreToolUseInput, client: CachedHookContext): PitfallCheckResult {
  // Only check for relevant tool types
  if (!PROACTIVE.TOOLS.includes(input.tool_name)) {
    return EMPTY;
  }

  // Check context pressure — skip in critical/minimal modes
  const state = readState();
  if (state.mode === 'critical' || state.mode === 'minimal') {
    return EMPTY;
  }

  // Skip pitfall injection for read-only Bash commands
  if (input.tool_name === 'Bash') {
    const cmd = (input.tool_input.command as string | undefined)?.trim() ?? '';
    if (isReadOnlyCommand(cmd)) {
      return EMPTY;
    }
  }

  // --- Extract file path(s) and command ---
  const filePaths = extractFilePaths(input);
  // Explicit annotation: without noUncheckedIndexedAccess, filePaths[0] is
  // inferred as plain `string` even though Bash calls have no file path.
  const filePath: string | undefined = filePaths[0] ?? undefined;
  const command = input.tool_input.command as string | undefined;
  const ext = filePath ? extname(filePath).slice(1) : null;
  const fileLabel = filePath ? basename(filePath) : (ext ?? 'this operation');
  const isEditTool = ['Write', 'Edit', 'MultiEdit'].includes(input.tool_name);

  // --- Load tracker: in-memory (cache) or file I/O (standalone) ---
  const tracker = client.cache?.getTracker(input.session_id) ?? loadTracker(input.session_id);

  // --- Skip-gate cache lookup ---
  // Conservative policy: only null outputs are ever served from cache. The
  // handler still runs whenever pitfalls would be surfaced, so cooldown and
  // surface_count updates remain correct. Cache hits eliminate the ~1.1s
  // DB/fingerprint path for the common "nothing to warn about" case.
  //
  // The key embeds memoryVersion (bumped by every MCP write tool and the
  // error-learning handler) plus a session state hash covering every
  // tracker field that feeds the session-aware warnings (A1/A2/A3). Any
  // change to those inputs forces a miss so correctness is preserved.
  const skipGateKey = client.cache ? SessionCache.skipGateKey({
    hookName: 'pitfall-check',
    toolName: input.tool_name,
    filePath: filePath ?? null,
    contextMode: state.mode,
    sessionStateHash: sessionStateHash(tracker),
  }) : null;
  if (skipGateKey && client.cache) {
    const cached = client.cache.getSkipGate(skipGateKey);
    if (cached && cached.output === null) {
      return EMPTY;
    }
  }

  const warnings: string[] = [];
  const surfacedPitfallIds: string[] = [];

  // --- Session-aware warnings (A1/A2/A3) ---
  const nowMs = Date.now();
  applySessionWarnings(tracker, warnings, filePath, isEditTool, nowMs);

  // --- Memory-backed pitfall retrieval ---
  const project = projectId(input.cwd);
  const { queryFp, queryText } = buildPitfallQuery(input, client, project, filePath, command);

  // Doc-only files: skip fuzzy fingerprint recall
  const DOC_EXTENSIONS = new Set(['md', 'txt', 'rst', 'adoc', 'mdx']);
  const isDocFile = ext ? DOC_EXTENSIONS.has(ext) : false;

  // Enhancement B: adaptive confidence floor
  const hasRecentErrors = warnings.length > 0;
  const minConfidence = hasRecentErrors
    ? PROACTIVE.SESSION_ERROR_CONFIDENCE_FLOOR
    : RELEVANCE.MIN_CONFIDENCE_FOR_PITFALL;
  const now = Date.now();
  const probationCutoff = now - PROACTIVE.PROBATION_DAYS * 86_400_000;
  const fingerprintSurfacedIds = new Set<string>();
  const identityTokens = deriveProjectIdentityTokens(project);

  const ctx: PitfallPassCtx = {
    input, client, tracker, warnings, surfacedPitfallIds, fingerprintSurfacedIds,
    project, queryFp, queryText, filePath, command, isDocFile, isEditTool,
    contextMode: state.mode, minConfidence, now, probationCutoff, identityTokens,
  };

  // --- Fuzzy fingerprint recall ---
  runFingerprintPitfallRecall(ctx);

  // --- Anchor-based recall: pitfalls ---
  runAnchorPitfallRecall(ctx);

  // --- Anchor-based decision recall ---
  runAnchorDecisionRecall(ctx);

  // --- Fingerprint-based decision recall for Write/Edit ---
  runFingerprintDecisionRecall(ctx);

  // --- File-triggered reminders ---
  applyFileReminders(ctx);

  // --- Conditional reminders ---
  applyConditionalReminders(ctx);

  // --- Predictive pre-fetch: surface co-recalled memories ---
  applyPredictivePrefetch(ctx);

  // --- Investigation chain surfacing ---
  applyInvestigationSignals(ctx);

  // --- Cap at MAX_WARNINGS and build output ---
  const capped = warnings.slice(0, PROACTIVE.MAX_WARNINGS_PER_CALL);

  let outputStr: string | null = null;
  if (capped.length > 0) {
    const formatted = capped.map(w => `  - ${w}`).join('\n');
    const context = `[CAIRN] Pitfalls for ${fileLabel}:\n${formatted}`;
    outputStr = JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        additionalContext: context,
      },
    });
  }

  // Save tracker: in-memory (cache) or file I/O (standalone)
  try {
    if (client.cache) {
      client.cache.setTracker(input.session_id, tracker);
    } else {
      saveTracker(tracker, input.session_id);
    }
  } catch { /* best-effort */ }

  // Write the skip-gate cache ONLY for null outputs. Non-null outputs are
  // intentionally not cached: the handler mutates recentlySurfaced and
  // surface_count on each run, and returning a cached non-null output would
  // let the same warning re-fire past its 5-minute cooldown.
  if (skipGateKey && client.cache && outputStr === null) {
    client.cache.setSkipGate(skipGateKey, null);
  }

  return { output: outputStr, pitfallsSurfaced: capped.length };
}
