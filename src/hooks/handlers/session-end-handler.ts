/**
 * SessionEnd handler — clean exit with state persistence + session quality
 * signal. Pure business logic: no stdin/stdout/process.exit. The stages
 * live under shared/session-end; this orders them.
 */
import type { SessionEndInput } from '../shared/hook-io.js';
import type { HookDbClient } from '../shared/db-client.js';
import { projectId } from '../../utils/project-id.js';
import { now } from '../../utils/index.js';
import { deleteTracker } from '../shared/edit-tracker.js';
import { LIMITS } from '../../constants/index.js';
import { computeSessionQuality } from '../shared/session-end/session-quality.js';
import { persistFinalSnapshot } from '../shared/session-end/final-snapshot.js';
import { runRetrospective } from '../shared/session-end/retrospective.js';
import { runSessionConsolidation } from '../shared/session-end/session-consolidation.js';

export function handleSessionEnd(input: SessionEndInput, client: HookDbClient): void {
  const project = projectId(input.cwd);

  // Check active plan state before blocking
  const activePlan = client.planRepo.getActive(project);
  let taskSummary: string | null = null;
  let planId: string | null = null;
  let stepsCompletedArr: number[] = [];

  if (activePlan) {
    planId = activePlan.id;
    const doneSteps = activePlan.steps.filter(s => s.status === 'done');
    stepsCompletedArr = doneSteps.map(s => s.step_id);
    const total = activePlan.steps.length;
    const currentStep = activePlan.steps.find(s => s.status === 'in_progress');
    const currentDesc = currentStep ? `. Current: step ${currentStep.step_id}` : '';
    taskSummary = `Worked on "${activePlan.name}": ${doneSteps.length}/${total} steps done${currentDesc}`;
  }

  // Transition any in_progress steps to blocked
  const reason = `Session ended (${input.reason})`;
  client.planRepo.blockInProgressSteps(project, reason);

  persistFinalSnapshot(client, input, project, activePlan);

  // --- Compute session quality signal ---
  const quality = computeSessionQuality(
    client.db,
    input.session_id,
    project,
    stepsCompletedArr.length,
    activePlan?.steps.length ?? 0,
  );

  // Close session record with summary + quality + project goal.
  // project_goal is pulled from the most recent compaction_snapshot for this
  // session so the sessions table carries the ambient goal alongside the
  // per-turn task_summary. Best-effort: falls back to NULL if unavailable.
  let sessionProjectGoal: string | null = null;
  try {
    const row = client.db.prepare(`
      SELECT project_goal FROM compaction_snapshots
      WHERE session_id = ? AND project_goal IS NOT NULL
      ORDER BY captured_at DESC LIMIT 1
    `).get(input.session_id) as { project_goal: string } | undefined;
    sessionProjectGoal = row?.project_goal ?? null;
  } catch { /* best-effort */ }

  const timestamp = now();
  client.db.prepare(`
    UPDATE sessions SET ended_at = ?, task_summary = ?, plan_id = ?, steps_completed = ?, session_quality = ?, project_goal = ?
    WHERE id = ? AND ended_at IS NULL
  `).run(
    timestamp,
    taskSummary,
    planId,
    JSON.stringify(stepsCompletedArr),
    JSON.stringify(quality),
    sessionProjectGoal,
    input.session_id,
  );

  // Clean up old compaction snapshots (time-based retention)
  client.db.prepare(`
    DELETE FROM compaction_snapshots
    WHERE project = ? AND captured_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-' || ? || ' hours')
  `).run(project, LIMITS.SNAPSHOT_RETENTION_HOURS);

  runRetrospective(client, input, project, quality);

  // Clean up session-scoped tracker file (no longer needed after session close)
  try { deleteTracker(input.session_id); } catch { /* best-effort */ }

  // --- Phase 5: recall-precision feedback loop ---
  // Walks session_memories for this session and applies a gentle
  // strengthen (+0.05) to memories that were recalled and led to success,
  // and a mild weaken (×0.97) to memories that were recalled but did not.
  // This closes the feedback loop from the North Star plan: surfaced +
  // used → confidence rises; surfaced + ignored → confidence sinks.
  try {
    client.memoryRepo.applyPrecisionFeedback(
      input.session_id,
      LIMITS.PRECISION_STRENGTHEN_INCREMENT,
      LIMITS.PRECISION_WEAKEN_FACTOR,
    );
  } catch { /* best-effort — feedback loop must never block session end */ }

  // --- Session-end consolidation ("dream") ---
  // Lightweight: strengthen proven memories, weaken unproven, merge obvious duplicates.
  try {
    runSessionConsolidation(client, project);
  } catch { /* consolidation is best-effort — never block session end */ }
}
