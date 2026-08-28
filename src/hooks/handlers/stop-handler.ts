/**
 * Stop handler — end-of-turn decision mining.
 *
 * Three-layer capture pipeline:
 *
 *   Layer 1a: Decision sigils — explicit `[dec: ...]` markup the agent
 *     writes inline. Cheap parse, zero false positives, higher confidence
 *     because authorship is explicit. When sigils are present, the rest
 *     of the pipeline is skipped — sigils are authoritative.
 *
 *   Layer 1b: Legacy prose extraction — `extractAssistantDecision` regex
 *     against choice+rationale signals. Structurally incompatible with
 *     modern markdown-heavy output (rejects len>500, ≥3 ** markers, ^#
 *     headers) but retained as a safety net for short unformatted turns.
 *
 *   Layer 1c: Socratic reflection — when no sigils AND the legacy prose
 *     extractor found nothing AND decision markers are present in the
 *     turn, ask a capability-gated host LLM (via MCP sampling) to extract
 *     decisions from the turn text as strict JSON. Haiku-preferred for
 *     cost. Falls through to an empty result on any failure, which
 *     trips the tier-3 nudge flag on the session tracker for the next
 *     UserPromptSubmit to surface.
 *
 * Async because of the sampling call. The hook-socket dispatcher awaits
 * async route handlers — no behavioral change for sync layers 1a/1b,
 * just an extra await boundary for 1c.
 */
import type { StopInput } from '../shared/hook-io.js';
import type { CachedHookContext } from '../shared/db-client.js';
import { isCodexClient, originClientOf } from '../shared/client-adapter.js';
import { projectId } from '../../utils/project-id.js';
import { extractAssistantDecision, extractDecisionSigils } from '../shared/transcript-parser.js';
import {
  countDecisionMarkers,
  reflectOnTurn,
  renderReflectedDecision,
  REFLECTION_MIN_MARKERS,
} from '../shared/decision-reflector.js';
import { CONFIDENCE } from '../../constants/index.js';
import { isSystemContent } from '../../utils/validation.js';
import { loadTracker, saveTracker } from '../shared/edit-tracker.js';
import {
  evaluateShadowStopFailOpen, type ShadowStopWireInput,
} from '../../governance/shadow-stop.js';

export interface StopResult {
  action:
    | 'no-decision'
    | 'decision-deduped'
    | 'decision-mined'
    | 'sigil-mined'
    | 'reflection-mined'
    | 'reflection-empty';
  /** Number of sigils found and processed this turn (0 if none). */
  sigilCount?: number;
  /** Number of sigils that deduplicated against existing memories. */
  sigilDeduped?: number;
  /** Number of decisions extracted by Layer 1c reflection (0 if none). */
  reflectionCount?: number;
  /** Marker count that tripped the tier-3 nudge flag (0 if not set). */
  pendingNudge?: number;
}

export interface StopHandlerOptions {
  evaluateShadow?: (
    db: CachedHookContext['db'], input: ShadowStopWireInput,
  ) => Promise<unknown>;
}

export async function handleStop(
  input: StopInput,
  client: CachedHookContext,
  options: StopHandlerOptions = {},
): Promise<StopResult> {
  try {
    await (options.evaluateShadow ?? evaluateShadowStopFailOpen)(client.db, {
      session_id: input.session_id, cwd: input.cwd, stop_hook_active: input.stop_hook_active,
      client_name: input.client_name, client_version: input.client_version,
      client_installation_id: input.client_installation_id,
      client_metadata: input.client_metadata,
    });
  } catch { /* shadow evaluation is independent of decision mining */ }

  const message = input.last_assistant_message;
  if (!message || message.length < 50) {
    return { action: 'no-decision' };
  }

  const project = projectId(input.cwd);

  // --- Layer 1a: explicit sigils ---------------------------------------
  // When the agent writes `[dec: X]` inline we trust the authorship and
  // skip the prose extractor + reflection entirely. Confidence is LEARNED
  // (0.65), not AUTO_DETECTED (0.55), because sigils are deliberate.
  const sigils = extractDecisionSigils(message);
  if (sigils.length > 0) {
    let deduped = 0;
    for (const content of sigils) {
      if (isSystemContent(content)) continue;
      const result = client.memoryRepo.storeDecision({
        content,
        project,
        source: 'learned',
        confidence: CONFIDENCE.LEARNED,
        originClient: originClientOf(input),
      });
      if (result.deduplicated) deduped++;
    }
    return {
      action: 'sigil-mined',
      sigilCount: sigils.length,
      sigilDeduped: deduped,
    };
  }

  // --- Layer 1b: legacy prose extraction -------------------------------
  // Only runs when no sigils were emitted. Structurally ignores markdown-
  // heavy output but catches short unformatted "I'll use X because Y"
  // turns. When it fires, we skip reflection — the prose extractor's hit
  // is strong enough signal on its own.
  const decision = extractAssistantDecision(message);
  if (decision && !isSystemContent(decision)) {
    const result = client.memoryRepo.storeDecision({
      content: decision,
      project,
      source: 'learned',
      confidence: CONFIDENCE.AUTO_DETECTED,
      originClient: originClientOf(input),
    });
    return {
      action: result.deduplicated ? 'decision-deduped' : 'decision-mined',
    };
  }

  // --- Layer 1c: Socratic reflection + tier-3 nudge flag ---------------
  // Cheap pre-gate: count decision markers. Single-marker turns are too
  // noisy — we need ≥REFLECTION_MIN_MARKERS before we consider the turn
  // worth an inference call.
  const markerCount = countDecisionMarkers(message);
  if (markerCount < REFLECTION_MIN_MARKERS) {
    return { action: 'no-decision' };
  }

  // Attempt LLM reflection. Returns [] on any failure — capability
  // missing, API error, timeout, parse error. The caller uses that as
  // the signal to set the nudge flag.
  const reflected = await reflectOnTurn(message, client.innerServer);

  if (reflected.length > 0) {
    let stored = 0;
    for (const d of reflected) {
      const content = renderReflectedDecision(d);
      if (!content || isSystemContent(content)) continue;
      client.memoryRepo.storeDecision({
        content,
        project,
        source: 'learned',
        confidence: CONFIDENCE.AUTO_DETECTED,
        originClient: originClientOf(input),
      });
      stored++;
    }
    return {
      action: 'reflection-mined',
      reflectionCount: stored,
    };
  }

  // Reflection unavailable or empty — trip the tier-3 nudge flag so the
  // next UserPromptSubmit surfaces a one-line reminder to emit sigils
  // next time. Session-scoped: the prompt handler clears the flag after
  // firing. No-op if the tracker file is unavailable.
  // Codex sessions: reflection can never run (no MCP sampling), so the
  // nudge would fire on every decision-bearing turn — suppress at set time.
  if (!isCodexClient(input)) {
    try {
      const tracker = loadTracker(input.session_id);
      tracker.pendingDecisionNudge = Math.max(tracker.pendingDecisionNudge, markerCount);
      saveTracker(tracker, input.session_id);
    } catch { /* best-effort — tracker write failures are non-fatal */ }
  }

  return {
    action: 'reflection-empty',
    // Suppressed for codex (no nudge was armed) — report what actually fired.
    pendingNudge: isCodexClient(input) ? 0 : markerCount,
  };
}
