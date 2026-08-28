/**
 * Memory-backed pitfall/decision recall passes: fuzzy fingerprint recall,
 * anchor-based recall, and fingerprint-based decision recall.
 *
 * Each pass mutates ctx.warnings / ctx.tracker in place — reference
 * semantics identical to the pre-split inline blocks in handlePitfallCheck.
 */
import type { PreToolUseInput } from '../../shared/hook-io.js';
import type { CachedHookContext } from '../../shared/db-client.js';
import type { EditTracker } from '../../shared/edit-tracker.js';
import type { ContextFingerprint } from '../../../utils/fingerprint.js';
import { passesCrossProjectGuard, passesSameProjectRelevance } from '../../../utils/cross-project-guard.js';
import { FINGERPRINT, PROACTIVE, SCORING_PROFILES, type ContextMode } from '../../../constants/index.js';
import { cachedRecallByFingerprint } from './recall-cache.js';

/** Shared per-call state threaded through the recall + signal passes. */
export interface PitfallPassCtx {
  input: PreToolUseInput;
  client: CachedHookContext;
  tracker: EditTracker;
  warnings: string[];
  surfacedPitfallIds: string[];
  fingerprintSurfacedIds: Set<string>;
  project: string;
  queryFp: ContextFingerprint;
  queryText: string;
  /** Undefined for tools without a file path (e.g. Bash). */
  filePath: string | undefined;
  command: string | undefined;
  isDocFile: boolean;
  isEditTool: boolean;
  contextMode: ContextMode;
  minConfidence: number;
  now: number;
  probationCutoff: number;
  identityTokens: Set<string>;
}

/** Fuzzy fingerprint recall */
export function runFingerprintPitfallRecall(ctx: PitfallPassCtx): void {
  const { client, tracker, warnings, surfacedPitfallIds, fingerprintSurfacedIds,
    project, queryFp, queryText, filePath, isDocFile, minConfidence, now, probationCutoff, identityTokens } = ctx;
  if (!isDocFile && (queryFp.lang.length > 0 || queryFp.module.length > 0 || queryText)) {
    const maxPitfalls = 2;
    const probationFloor = Math.min(minConfidence, PROACTIVE.PROBATION_CONFIDENCE_FLOOR);
    const results = cachedRecallByFingerprint(client, queryFp, queryText, {
      project,
      kind: 'pitfall',
      maxResults: maxPitfalls * FINGERPRINT.CANDIDATE_MULTIPLIER,
      minConfidence: probationFloor,
    });

    const relevant = results
      .filter(r => r.score >= SCORING_PROFILES.SURFACING.MULTI_SIGNAL.MIN_SCORE)
      .filter(r => passesCrossProjectGuard(r.memory, project, queryFp))
      .filter(r => passesSameProjectRelevance(r.memory, queryFp, filePath, identityTokens))
      .filter(r => {
        if (r.memory.confidence < minConfidence) {
          const createdAt = new Date(r.memory.created_at).getTime();
          if (createdAt < probationCutoff) return false;
          if (r.score < PROACTIVE.PROBATION_MIN_SCORE) return false;
        }
        const lastSurfaced = tracker.recentlySurfaced?.[r.memory.id];
        if (lastSurfaced && (now - lastSurfaced) < PROACTIVE.SURFACE_COOLDOWN_MS) return false;
        if (r.memory.surface_count >= PROACTIVE.UNPROVEN_SURFACE_THRESHOLD && r.memory.impact_count === 0) return false;
        return true;
      })
      .slice(0, maxPitfalls);

    for (const r of relevant) {
      client.memoryRepo.incrementSurface(r.memory.id);
      tracker.recentlySurfaced = tracker.recentlySurfaced ?? {};
      tracker.recentlySurfaced[r.memory.id] = now;
      warnings.push(r.memory.content);
      surfacedPitfallIds.push(r.memory.id);
      fingerprintSurfacedIds.add(r.memory.id);
    }

    if (filePath && relevant.length > 0) {
      tracker.surfacedPitfalls[filePath] = relevant.map(r => r.memory.id);
    }
  }
}

/** Anchor-based recall: pitfalls */
export function runAnchorPitfallRecall(ctx: PitfallPassCtx): void {
  const { client, tracker, warnings, fingerprintSurfacedIds, project, queryFp,
    filePath, minConfidence, now } = ctx;
  if (filePath && warnings.length < PROACTIVE.MAX_WARNINGS_PER_CALL) {
    const anchoredMemories = client.memoryRepo.recallByAnchor(filePath, {
      project,
      kind: 'pitfall',
      maxResults: 1,
      minConfidence,
    });
    for (const m of anchoredMemories) {
      if (fingerprintSurfacedIds.has(m.id)) continue;
      if (!passesCrossProjectGuard(m, project, queryFp)) continue;
      const lastSurfaced = tracker.recentlySurfaced?.[m.id];
      if (lastSurfaced && (now - lastSurfaced) < PROACTIVE.SURFACE_COOLDOWN_MS) continue;
      if (m.surface_count >= PROACTIVE.UNPROVEN_SURFACE_THRESHOLD && m.impact_count === 0) continue;

      client.memoryRepo.incrementSurface(m.id);
      tracker.recentlySurfaced = tracker.recentlySurfaced ?? {};
      tracker.recentlySurfaced[m.id] = now;
      warnings.push(m.content);

      tracker.surfacedPitfalls[filePath] = tracker.surfacedPitfalls[filePath] ?? [];
      tracker.surfacedPitfalls[filePath].push(m.id);
    }
  }
}

/** Anchor-based decision recall */
export function runAnchorDecisionRecall(ctx: PitfallPassCtx): void {
  const { client, tracker, warnings, project, queryFp, filePath, contextMode, now } = ctx;
  if (filePath && contextMode === 'normal' && warnings.length < PROACTIVE.MAX_WARNINGS_PER_CALL) {
    const anchoredDecisions = client.memoryRepo.recallByAnchor(filePath, {
      project,
      kind: 'decision',
      maxResults: 1,
      minConfidence: PROACTIVE.MIN_DECISION_CONFIDENCE,
    });
    for (const m of anchoredDecisions) {
      if (!passesCrossProjectGuard(m, project, queryFp)) continue;
      const lastSurfaced = tracker.recentlySurfaced?.[m.id];
      if (lastSurfaced && (now - lastSurfaced) < PROACTIVE.SURFACE_COOLDOWN_MS) continue;
      tracker.recentlySurfaced = tracker.recentlySurfaced ?? {};
      tracker.recentlySurfaced[m.id] = now;
      warnings.push(`Decision: ${m.content}`);
      tracker.injectedMemoryIds = tracker.injectedMemoryIds ?? [];
      if (!tracker.injectedMemoryIds.includes(m.id)) {
        tracker.injectedMemoryIds.push(m.id);
      }
    }
  }
}

/** Fingerprint-based decision recall for Write/Edit */
export function runFingerprintDecisionRecall(ctx: PitfallPassCtx): void {
  const { client, tracker, warnings, project, queryFp, queryText, filePath,
    isDocFile, isEditTool, contextMode, identityTokens } = ctx;
  if (!isDocFile && isEditTool && contextMode === 'normal' && warnings.length < PROACTIVE.MAX_WARNINGS_PER_CALL) {
    const injectedSet = new Set(tracker.injectedMemoryIds ?? []);
    const decisions = cachedRecallByFingerprint(client, queryFp, queryText, {
      project,
      kind: 'decision',
      maxResults: PROACTIVE.MAX_DECISIONS,
      minConfidence: PROACTIVE.MIN_DECISION_CONFIDENCE,
    });

    const relevantDecisions = decisions
      .filter(r => r.score >= SCORING_PROFILES.SURFACING.MULTI_SIGNAL.MIN_SCORE)
      .filter(r => passesCrossProjectGuard(r.memory, project, queryFp))
      .filter(r => passesSameProjectRelevance(r.memory, queryFp, filePath, identityTokens))
      .filter(r => !injectedSet.has(r.memory.id));
    for (const r of relevantDecisions) {
      warnings.push(`Decision: ${r.memory.content}`);
      tracker.injectedMemoryIds = tracker.injectedMemoryIds ?? [];
      if (!tracker.injectedMemoryIds.includes(r.memory.id)) {
        tracker.injectedMemoryIds.push(r.memory.id);
      }
    }
  }
}
