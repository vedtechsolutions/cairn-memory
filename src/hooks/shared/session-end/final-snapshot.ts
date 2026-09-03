/**
 * The final transcript parse at session end: persists a last compaction
 * snapshot (goal tiers, resume cursor, decisions) and mines decisions from
 * assistant text — the same safety net PreCompact has, so a clean /exit
 * loses nothing. Split from session-end.ts (phase 4).
 */
import type { SessionEndInput } from '../hook-io.js';
import type { HookDbClient } from '../db-client.js';
import type { Plan } from '../../../db/plan-repository.js';
import { generateId, now } from '../../../utils/index.js';
import { loadTracker } from '../edit-tracker.js';
import { CONFIDENCE, TRUNCATE } from '../../../constants/index.js';
import { originClientOf, readTranscriptSnapshotFor } from '../client-adapter.js';
import { resolveInitialGoal, resolveProjectGoal } from '../goal-resolver.js';
import { generateFingerprint } from '../../../utils/fingerprint.js';
import { getGitWorkingState, getGitHash } from '../../../utils/project-scanner.js';
import { extractWhyContext } from '../../../utils/intent-classifier.js';
import { isSystemContent } from '../../../utils/validation.js';

export function persistFinalSnapshot(
  client: HookDbClient, input: SessionEndInput, project: string, activePlan: Plan | null,
): void {
  // --- Final transcript parse — capture conversation since last compaction ---
  // Prevents memory loss when user exits via /exit without triggering compaction.
  try {
    // Per-client transcript format — the adapter parses or degrades to
    // an empty snapshot (rollout parser is a recorded follow-up).
    const snapshot = readTranscriptSnapshotFor(input, input.transcript_path);
    // Load tracker once for snapshot enrichment (resume cursor) — deleted
    // later by deleteTracker, so anything that needs to survive must be
    // persisted into the snapshot first.
    const tracker = loadTracker(input.session_id);

    // Enrich decisions from active plan (same as PreCompact)
    let decisionsForSnapshot = snapshot.recentDecisions;
    if (activePlan && activePlan.decisions.length > 0) {
      decisionsForSnapshot = activePlan.decisions.slice(-5).map(d => ({
        chose: d.chose.slice(0, TRUNCATE.DECISION_FIELD_CHARS),
        why: d.why.slice(0, TRUNCATE.DECISION_FIELD_CHARS),
      }));
    }

    // Goal continuity (Now tier) — shared resolver, same implementation as
    // PreCompact so SessionEnd-sourced snapshots participate in the
    // briefing's branchMismatch and carryCount staleness gates. Without
    // these columns the snapshots have NULL branch and 0 carry count,
    // making both gates no-ops on subsequent compaction recovery — a stale
    // goal would persist forever across sessions. No sessionId here: at the
    // session boundary only the any-session time window applies.
    const currentBranch = getGitWorkingState(input.cwd)?.branch ?? null;
    const initialGoalRes = resolveInitialGoal({
      db: client.db,
      project,
      transcriptGoal: snapshot.initialGoal,
      userContext: snapshot.userContext,
      currentBranch,
    });
    const goalForSnapshot = initialGoalRes.goal;
    const goalBranch = initialGoalRes.goalBranch;
    const goalCarryCount = initialGoalRes.goalCarryCount;
    const goalCapturedAt = initialGoalRes.goalCapturedAt;

    // Project-goal capture (Project tier) — shared resolver, identical to
    // PreCompact so SessionEnd-sourced snapshots participate in the
    // briefing's project_goal rendering after a clean /exit. Prior pitfall:
    // column-list drift between these two hooks silently disabled briefing
    // features — hence the single shared implementation.
    const { projectGoal, projectGoalSource, projectGoalCapturedAt } = resolveProjectGoal({
      db: client.db,
      project,
      transcriptProjectGoal: snapshot.projectGoal,
      activePlanName: activePlan?.name ?? null,
      currentBranch,
      cwd: input.cwd,
    });

    // Phase 2 + reassessment: persist resume cursor into the final snapshot
    // so it survives the deleteTracker call below. Without this the cursor
    // is wiped on clean /exit and the next startup briefing loses "Resume:
    // foo.ts:240" continuity. tracker was loaded at session-end entry.
    let lastEditCursorJson: string | null = null;
    try {
      if (tracker.lastEditCursor) {
        lastEditCursorJson = JSON.stringify(tracker.lastEditCursor);
      }
    } catch { /* best-effort */ }

    // Save final snapshot if there's content to preserve
    const hasContent = snapshot.recentFiles.length > 0
      || snapshot.recentReadFiles.length > 0
      || snapshot.recentCommands.length > 0
      || goalForSnapshot
      || projectGoal
      || decisionsForSnapshot.length > 0
      || lastEditCursorJson != null;

    if (hasContent) {
      const snapshotId = generateId();
      const timestamp = now();
      const finalGoalCapturedAt = goalForSnapshot ? (goalCapturedAt ?? timestamp) : null;
      const finalProjectGoalCapturedAt = projectGoal ? (projectGoalCapturedAt ?? timestamp) : null;
      client.db.prepare(`
        INSERT INTO compaction_snapshots (id, session_id, project, captured_at, recent_files, recent_read_files, recent_commands, user_context, approach_notes, initial_goal, goal_captured_at, goal_branch, goal_carry_count, recent_decisions, reasoning_state, error_context, project_goal, project_goal_source, project_goal_captured_at, last_edit_cursor)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        snapshotId,
        input.session_id,
        project,
        timestamp,
        JSON.stringify(snapshot.recentFiles),
        JSON.stringify(snapshot.recentReadFiles),
        JSON.stringify(snapshot.recentCommands),
        JSON.stringify(snapshot.userContext),
        JSON.stringify(snapshot.approachNotes),
        goalForSnapshot,
        finalGoalCapturedAt,
        goalBranch,
        goalCarryCount,
        JSON.stringify(decisionsForSnapshot),
        JSON.stringify(snapshot.reasoningState),
        JSON.stringify(snapshot.errorContext),
        projectGoal,
        projectGoalSource,
        finalProjectGoalCapturedAt,
        lastEditCursorJson,
      );
    }

    // Mine decisions from assistant text (same safety net as PreCompact)
    if (snapshot.minedDecisions.length > 0) {
      let projectContext = null;
      try {
        const hash = getGitHash(input.cwd);
        if (hash) projectContext = client.contextRepo.get(project, hash);
        if (!projectContext) projectContext = client.contextRepo.getLatest(project);
      } catch { /* best-effort */ }
      const fp = generateFingerprint({ projectContext });

      for (const d of snapshot.minedDecisions.slice(-5)) {
        if (isSystemContent(d.content)) continue;
        const why = extractWhyContext(d.content);
        client.memoryRepo.storeDecision({
          content: d.content,
          project,
          confidence: CONFIDENCE.AUTO_DETECTED,
          source: 'learned',
          originClient: originClientOf(input),
          fingerprint: fp,
          context: why ? { why } : undefined,
        });
      }
    }
  } catch { /* transcript parse is best-effort — never block session end */ }
}
