#!/usr/bin/env node
/**
 * PreCompact hook — extract state from transcript before compaction.
 * Saves compaction snapshot to SQLite and updates active plan.
 * NOT async — must complete before compaction proceeds.
 */
import { readStdinJson, type PreCompactInput } from './shared/hook-io.js';
import { createHookDbClient } from './shared/db-client.js';
import { originClientOf, readTranscriptSnapshotFor } from './shared/client-adapter.js';
import { resolveInitialGoal, resolveProjectGoal } from './shared/goal-resolver.js';
import { projectId } from '../utils/project-id.js';
import { generateId, now } from '../utils/index.js';
import { getGitHash, getGitWorkingState, scanProject } from '../utils/project-scanner.js';
import { loadTracker } from './shared/edit-tracker.js';
import { recordTelemetry } from './shared/hook-telemetry.js';
import { CONFIDENCE, TOKEN_BUDGET } from '../constants/index.js';
import { generateFingerprint } from '../utils/fingerprint.js';
import { extractWhyContext } from '../utils/intent-classifier.js';
import { isSystemContent } from '../utils/validation.js';

const _startTime = Date.now();
try {
  const input = readStdinJson<PreCompactInput>();

  const dbPath = process.env.CAIRN_DB_PATH ?? undefined;
  const client = createHookDbClient(dbPath);

  const project = projectId(input.cwd);

  // Parse transcript per the client's format — the adapter degrades to an
  // empty snapshot for formats Cairn cannot parse (rollout parser is a
  // recorded follow-up).
  const snapshot = readTranscriptSnapshotFor(input, input.transcript_path);

  // Enrich decisions: transcript may miss decisions from earlier in the session
  // or from previous sessions. Pull from DB plan as authoritative source.
  const activePlan = client.planRepo.getActive(project);
  let decisionsForSnapshot = snapshot.recentDecisions;
  if (activePlan && activePlan.decisions.length > 0) {
    // DB plan decisions are authoritative — use them, falling back to transcript only if none
    decisionsForSnapshot = activePlan.decisions.slice(-5).map(d => ({
      chose: d.chose.slice(0, 150),
      why: d.why.slice(0, 150),
    }));
  }

  // Goal continuity (Now tier) — shared resolver handles meta-goal
  // inheritance, staleness bookkeeping, and goal_captured_at carry-forward.
  // sessionId enables the current-session phase (compaction context).
  const currentBranch = getGitWorkingState(input.cwd)?.branch ?? null;
  const initialGoalRes = resolveInitialGoal({
    db: client.db,
    project,
    transcriptGoal: snapshot.initialGoal,
    userContext: snapshot.userContext,
    currentBranch,
    sessionId: input.session_id,
  });
  const goalForSnapshot = initialGoalRes.goal;
  const goalBranch = initialGoalRes.goalBranch;
  const goalCarryCount = initialGoalRes.goalCarryCount;
  const goalCapturedAt = initialGoalRes.goalCapturedAt;

  // Update project context cache (scan only on git hash change)
  const gitHash = getGitHash(input.cwd);
  if (gitHash) {
    const cached = client.contextRepo.get(project, gitHash);
    if (!cached) {
      const ctx = scanProject(input.cwd);
      client.contextRepo.store(project, ctx);
      client.contextRepo.cleanup(project);
    }
  }

  // Project-goal capture (Project tier) — shared resolver handles the
  // transcript → DB carry-forward → plan name → branch-synthesis priority
  // chain and the project_goal_captured_at carry-forward.
  const { projectGoal, projectGoalSource, projectGoalCapturedAt } = resolveProjectGoal({
    db: client.db,
    project,
    transcriptProjectGoal: snapshot.projectGoal,
    activePlanName: activePlan?.name ?? null,
    currentBranch,
    cwd: input.cwd,
  });

  // Phase 2 + reassessment: persist resume cursor in the snapshot so it
  // survives SessionEnd's deleteTracker. Read from the tracker file (the
  // precompact hook runs standalone, so no cache access) and serialize
  // into the snapshot as JSON. Best-effort — a missing tracker just means
  // no cursor is persisted for this snapshot.
  let lastEditCursorJson: string | null = null;
  try {
    const tracker = loadTracker(input.session_id);
    if (tracker.lastEditCursor) {
      lastEditCursorJson = JSON.stringify(tracker.lastEditCursor);
    }
  } catch { /* best-effort */ }

  // Save compaction snapshot — skip if transcript produced no useful data
  // (happens when /compact is triggered on a thin continuation context)
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

    // SNR v3 Commit 4: resolve final captured_at values at INSERT time.
    // Fresh goal (goalCapturedAt still null from above) → stamp now.
    // Inherited goal → the inheritance block already assigned the prior
    // row's timestamp, so leave it alone. Mirror the same for projectGoal.
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

  // Layer 1b: Auto-store decisions mined from assistant text.
  // Safety net — captures decisions even if cairn_learn wasn't called explicitly.
  if (snapshot.minedDecisions.length > 0) {
    let projectContext = null;
    try {
      const hash = getGitHash(input.cwd);
      if (hash) projectContext = client.contextRepo.get(project, hash);
      if (!projectContext) projectContext = client.contextRepo.getLatest(project);
    } catch { /* best-effort */ }
    const fp = generateFingerprint({ projectContext });

    let minedCount = 0;
    for (const d of snapshot.minedDecisions.slice(-5)) {
      if (isSystemContent(d.content)) continue;

      const why = extractWhyContext(d.content);
      const result = client.memoryRepo.storeDecision({
        content: d.content,
        project,
        confidence: CONFIDENCE.AUTO_DETECTED,
        source: 'learned',
        originClient: originClientOf(input),
        fingerprint: fp,
        context: why ? { why } : undefined,
      });
      if (!result.deduplicated) minedCount++;
    }
    if (minedCount > 0) {
      console.error(`[cairn] PreCompact: auto-mined ${minedCount} decision(s) from assistant text`);
    }
  }

  // Update active plan's in_progress step with progress note
  if (activePlan) {
    const totalSteps = activePlan.steps.length;
    const doneSteps = activePlan.steps.filter(s => s.status === 'done').length;
    const allComplete = totalSteps > 0 && doneSteps === totalSteps;

    if (allComplete) {
      // Inject completion signal into approach notes so briefing reflects finished state
      snapshot.approachNotes.push(`All ${totalSteps} plan steps complete — task finished.`);
    } else {
      const inProgressStep = activePlan.steps.find(s => s.status === 'in_progress');
      if (inProgressStep) {
        const files = snapshot.recentFiles.slice(-3).join(', ');
        const note = files
          ? `Pre-compaction: modified ${files}`
          : 'Pre-compaction checkpoint';

        client.planRepo.addNote(activePlan.id, {
          step_id: inProgressStep.step_id,
          note: note.slice(0, TOKEN_BUDGET.NOTE_MAX_CHARS),
        });
      }
    }
  }

  client.close();
  recordTelemetry('precompact', 'precompact', _startTime, true, undefined, {
    filesCount: snapshot.recentFiles.length,
    commandsCount: snapshot.recentCommands.length,
    decisionsCount: snapshot.recentDecisions.length,
  });
} catch (err) {
  recordTelemetry('precompact', 'error', _startTime, false, String(err));
  console.error('[cairn] PreCompact hook error:', err);
  process.exit(0);
}

