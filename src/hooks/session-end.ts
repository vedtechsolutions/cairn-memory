#!/usr/bin/env node
/**
 * SessionEnd hook — clean exit with state persistence + session quality signal.
 * Transitions in_progress steps to blocked, saves session summary,
 * and computes a quality metric for cross-session momentum.
 */
import { readStdinJson, type SessionEndInput } from './shared/hook-io.js';
import { createHookDbClient } from './shared/db-client.js';
import { projectId } from '../utils/project-id.js';
import { generateId, now } from '../utils/index.js';
import { recordTelemetry } from './shared/hook-telemetry.js';
import { loadTracker, deleteTracker } from './shared/edit-tracker.js';
import { LIMITS, CONFIDENCE, CONSOLIDATION } from '../constants/index.js';
import { extractWinningPattern } from './shared/transcript-parser.js';
import { originClientOf, readTranscriptSnapshotFor } from './shared/client-adapter.js';
import { resolveInitialGoal, resolveProjectGoal } from './shared/goal-resolver.js';
import { generateFingerprint } from '../utils/fingerprint.js';
import { getGitWorkingState, getGitHash } from '../utils/project-scanner.js';
import { basename } from 'node:path';
import { extractWhyContext } from '../utils/intent-classifier.js';
import { isSystemContent } from '../utils/validation.js';
import { journalUpsertForId, retireIdsByInvalidation, syncBoundIds } from '../db/memory-repository/journal.js';
import { computeRecallPrecision } from '../utils/prediction.js';
import { findConsolidationCandidates, mergedConfidence, mergedTags } from '../utils/consolidation.js';

export interface SessionQuality {
  errorCount: number;
  toolCallCount: number;
  errorRate: number;
  escalationCount: number;
  compactionCount: number;
  stepsCompleted: number;
  totalSteps: number;
  label: 'smooth' | 'productive' | 'rough' | 'stuck';
  summary: string;
  /** Recall precision: ratio of recalled memories that led to successful outcomes */
  recallPrecision?: number;
}

const _startTime = Date.now();
try {
  const input = readStdinJson<SessionEndInput>();
  const dbPath = process.env.CAIRN_DB_PATH ?? undefined;
  const client = createHookDbClient(dbPath);

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
        chose: d.chose.slice(0, 150),
        why: d.why.slice(0, 150),
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

  // --- Phase 3: retrospective learning — iteration-cost pitfalls + wins ---
  // Walk the per-file edit counter from the tracker. Files that required
  // more than ITERATION_COST_THRESHOLD edits produce an auto-pitfall
  // (capped at ITERATION_COST_MAX_PER_SESSION so a single thrashy session
  // can't flood memory). On smooth sessions, mine the approach notes for
  // winning patterns and store them as kind='pattern' memories. Must run
  // BEFORE deleteTracker below so we still have the edit counts.
  try {
    const retroTracker = loadTracker(input.session_id);
    const editCounts = retroTracker.editCountsByFile ?? {};

    let projectContext = null;
    try {
      const hash = getGitHash(input.cwd);
      if (hash) projectContext = client.contextRepo.get(project, hash);
      if (!projectContext) projectContext = client.contextRepo.getLatest(project);
    } catch { /* best-effort */ }
    const retroFp = generateFingerprint({ projectContext });

    // Iteration-cost pitfalls — sorted by count DESC so the worst offenders
    // land first when the per-session cap is tight.
    const overBudget = Object.entries(editCounts)
      .filter(([, count]) => count > LIMITS.ITERATION_COST_THRESHOLD)
      .sort((a, b) => b[1] - a[1])
      .slice(0, LIMITS.ITERATION_COST_MAX_PER_SESSION);

    for (const [file, count] of overBudget) {
      const base = basename(file);
      const lesson = `${base} required ${count} edits in one session — read the file more carefully and plan the full change before editing next time.`;
      client.memoryRepo.create({
        content: lesson,
        kind: 'pitfall',
        project,
        source: 'learned',
        originClient: originClientOf(input),
        confidence: CONFIDENCE.AUTO_DETECTED,
        fingerprint: retroFp,
      });
    }

    // Pattern mining — only on smooth sessions with real progress, and only
    // when the session wasn't also thrashy (no iteration-cost pitfalls from
    // this same session). A session with iteration pitfalls wasn't clean
    // enough to produce a reliable winning pattern.
    if (overBudget.length === 0 && quality.label === 'smooth' && quality.stepsCompleted > 0) {
      try {
        const retroSnapshot = readTranscriptSnapshotFor(input, input.transcript_path);
        const patterns: string[] = [];
        // Scan approach notes first — these are already pre-filtered to
        // strategy-like content.
        for (const note of retroSnapshot.approachNotes) {
          if (patterns.length >= LIMITS.PATTERN_MINE_MAX_PER_SESSION) break;
          const p = extractWinningPattern(note);
          if (p && !patterns.includes(p)) patterns.push(p);
        }
        for (const p of patterns) {
          client.memoryRepo.create({
            content: p,
            kind: 'pattern',
            project,
            source: 'learned',
            originClient: originClientOf(input),
            confidence: CONFIDENCE.AUTO_DETECTED,
            fingerprint: retroFp,
          });
        }
      } catch { /* best-effort — pattern mining must never block session end */ }
    }
  } catch { /* retrospective is best-effort */ }

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

  client.close();
  recordTelemetry('session-end', input.reason, _startTime, true);
} catch (err) {
  recordTelemetry('session-end', 'error', _startTime, false, String(err));
  console.error('[cairn] SessionEnd hook error:', err);
  process.exit(0);
}

/** Compute session quality from existing telemetry + tracker data.
 *  Research: informative labels > prescriptive directives (SWE-PRM). */
function computeSessionQuality(
  db: import('better-sqlite3').Database,
  sessionId: string,
  project: string,
  stepsCompleted: number,
  totalSteps: number,
): SessionQuality {
  // Get session start time for telemetry window
  const session = db.prepare(
    'SELECT started_at FROM sessions WHERE id = ?',
  ).get(sessionId) as { started_at: string } | undefined;
  const startedAt = session?.started_at ?? new Date(0).toISOString();
  const endedAt = new Date().toISOString();

  // Error count from error-learning telemetry (time-windowed)
  const errorRow = db.prepare(`
    SELECT COUNT(*) AS n FROM hook_telemetry
    WHERE hook_name = 'error-learning'
      AND event_type NOT IN ('error', 'escalation')
      AND created_at BETWEEN ? AND ?
  `).get(startedAt, endedAt) as { n: number };
  const errorCount = errorRow?.n ?? 0;

  // Tool call count from pitfall-check telemetry (approximate)
  const toolRow = db.prepare(`
    SELECT COUNT(*) AS n FROM hook_telemetry
    WHERE hook_name = 'pitfall-check'
      AND event_type != 'error'
      AND created_at BETWEEN ? AND ?
  `).get(startedAt, endedAt) as { n: number };
  const toolCallCount = toolRow?.n ?? 0;

  // Escalation count (same error 3+ times)
  const escRow = db.prepare(`
    SELECT COUNT(*) AS n FROM hook_telemetry
    WHERE hook_name = 'error-learning'
      AND event_type = 'escalation'
      AND created_at BETWEEN ? AND ?
  `).get(startedAt, endedAt) as { n: number };
  const escalationCount = escRow?.n ?? 0;

  // Compaction count
  const compRow = db.prepare(`
    SELECT COUNT(*) AS n FROM compaction_snapshots
    WHERE session_id = ? AND project = ?
  `).get(sessionId, project) as { n: number };
  const compactionCount = compRow?.n ?? 0;

  // Error rate
  const errorRate = toolCallCount > 0 ? errorCount / toolCallCount : 0;

  // Also check EditTracker for session error key diversity
  let uniqueErrorKeys = 0;
  try {
    const tracker = loadTracker(sessionId);
    if (tracker.sessionId === sessionId) {
      uniqueErrorKeys = Object.keys(tracker.sessionErrorCounts).length;
    }
  } catch { /* best-effort */ }

  // Compute qualitative label
  const label = classifySession(errorRate, escalationCount, errorCount, uniqueErrorKeys);

  // Build summary line (research: compact, diagnostic, no prescriptive directives)
  const summary = buildSummary(label, errorCount, toolCallCount, stepsCompleted, totalSteps, escalationCount, compactionCount);

  // Compute recall precision from session_memories table
  let recallPrecision: number | undefined;
  try {
    const rp = computeRecallPrecision(db, sessionId);
    if (rp.recalled > 0) {
      recallPrecision = Math.round(rp.precision * 1000) / 1000;
    }
  } catch { /* table may not exist on older schemas */ }

  return {
    errorCount,
    toolCallCount,
    errorRate: Math.round(errorRate * 1000) / 1000,
    escalationCount,
    compactionCount,
    stepsCompleted,
    totalSteps,
    label,
    summary,
    recallPrecision,
  };
}

/** Classify session health based on metrics.
 *  Labels are informative, not prescriptive (SWE-PRM research). */
function classifySession(
  errorRate: number,
  escalationCount: number,
  errorCount: number,
  uniqueErrorKeys: number,
): SessionQuality['label'] {
  // Stuck: multiple escalations (same error 3+ times) or very high error diversity
  if (escalationCount >= 2 || (uniqueErrorKeys >= 4 && errorRate > 0.3)) return 'stuck';
  // Rough: high error rate or any escalation
  if (errorRate > 0.2 || escalationCount >= 1 || errorCount >= 5) return 'rough';
  // Smooth: very few or no errors
  if (errorCount <= 1) return 'smooth';
  // Productive: moderate errors but making progress
  return 'productive';
}

/** Build a compact summary line for briefing injection. */
function buildSummary(
  label: SessionQuality['label'],
  errorCount: number,
  toolCallCount: number,
  stepsCompleted: number,
  totalSteps: number,
  escalationCount: number,
  compactionCount: number,
): string {
  const parts: string[] = [];

  // Core ratio
  if (toolCallCount > 0) {
    parts.push(`${errorCount} error${errorCount !== 1 ? 's' : ''} / ${toolCallCount} tool calls`);
  }

  // Plan progress
  if (totalSteps > 0) {
    parts.push(`${stepsCompleted}/${totalSteps} plan steps done`);
  }

  // Escalations (strong signal)
  if (escalationCount > 0) {
    parts.push(`${escalationCount} escalation${escalationCount !== 1 ? 's' : ''}`);
  }

  // Compactions
  if (compactionCount > 0) {
    parts.push(`${compactionCount} compaction${compactionCount !== 1 ? 's' : ''}`);
  }

  const detail = parts.length > 0 ? ` (${parts.join(', ')})` : '';
  return `${label}${detail}`;
}

/** Session-end consolidation — lightweight "dream" pass.
 *  1. Strengthen memories that were surfaced AND led to successful outcomes
 *  2. Weaken memories surfaced many times with zero impact (noise)
 *  3. Merge near-duplicate memories within same kind+project */
function runSessionConsolidation(
  client: ReturnType<typeof createHookDbClient>,
  project: string,
): void {
  const UNPROVEN_THRESHOLD = 5;

  // 1. Strengthen proven memories (surfaced + impacted this project)
  client.db.prepare(`
    UPDATE memories SET confidence = MIN(1.0, confidence + ?)
    WHERE project = ? AND invalidated = 0
      AND kind != 'rule'
      AND impact_count > 0 AND surface_count > 0
      AND confidence < 1.0
  `).run(CONFIDENCE.STRENGTHEN_INCREMENT, project);

  // 2. Weaken unproven memories (surfaced many times, zero impact)
  client.db.prepare(`
    UPDATE memories SET confidence = confidence * ?
    WHERE project = ? AND invalidated = 0
      AND kind != 'rule'
      AND surface_count >= ? AND impact_count = 0
      AND confidence > ?
  `).run(CONFIDENCE.WEAKEN_FACTOR, project, UNPROVEN_THRESHOLD, CONFIDENCE.DELETE_THRESHOLD);

  // 3. Merge near-duplicate memories (same kind, same project, high affinity)
  for (const kind of CONSOLIDATION.ELIGIBLE_KINDS) {
    const candidates = client.db.prepare(`
      SELECT * FROM memories
      WHERE project = ? AND kind = ? AND invalidated = 0
        AND julianday('now') - julianday(created_at) >= ?
      ORDER BY confidence DESC
      LIMIT ?
    `).all(project, kind, CONSOLIDATION.MIN_AGE_DAYS, CONSOLIDATION.MAX_PER_KIND) as Array<{
      id: string; content: string; kind: string; project: string | null;
      tags: string | null; confidence: number; source: string; created_at: string;
      last_recalled: string | null; recall_count: number; invalidated: number;
      surface_count: number; impact_count: number; fingerprint: string | null;
      context: string | null; anchor: string | null; revision: number;
    }>;

    // Convert rows to Memory objects for consolidation
    const memories = candidates.map(row => ({
      id: row.id,
      content: row.content,
      kind: row.kind as import('../constants/index.js').MemoryKind,
      project: row.project,
      tags: JSON.parse(row.tags ?? '[]') as string[],
      confidence: row.confidence,
      source: row.source as import('../constants/index.js').MemorySource,
      created_at: row.created_at,
      last_recalled: row.last_recalled,
      recall_count: row.recall_count,
      invalidated: row.invalidated,
      surface_count: row.surface_count,
      impact_count: row.impact_count,
      fingerprint: row.fingerprint ? JSON.parse(row.fingerprint) : null,
      context: row.context ? JSON.parse(row.context) : null,
      anchor: row.anchor ?? null,
      author: (row as { author?: string | null }).author ?? null,
      revision: row.revision,
    }));

    const clusters = findConsolidationCandidates(memories, CONSOLIDATION.AFFINITY_THRESHOLD);

    // Atomic per cluster like maintenance.ts's applyClusterMerge: a crash
    // between member retirement and the representative rewrite must not
    // strand half a merge, and no journal write may commit outside its
    // mutation's transaction (journal.ts invariant). The bound check runs
    // INSIDE the write transaction — a pre-computed set is a stale
    // snapshot a concurrent binder can defeat (review) — and the
    // transaction is taken immediate so that check is authoritative.
    const applyClusterMerge = client.db.transaction(
      (repId: string, newConf: number, newTagsJson: string, memberIds: string[]) => {
        // Autonomous semantic compression never touches team-visible
        // rows: a cluster containing ANY sync-bound row is skipped whole.
        if (syncBoundIds(client.db, [repId, ...memberIds]).size > 0) return false;
        client.db.prepare('UPDATE memories SET confidence = ?, tags = ? WHERE id = ?')
          .run(newConf, newTagsJson, repId);
        journalUpsertForId(client.db, repId);
        retireIdsByInvalidation(client.db, memberIds);
        return true;
      },
    );

    for (const cluster of clusters) {
      const rep = cluster.representative;
      const newConf = mergedConfidence(cluster);
      const newTags = mergedTags(cluster);

      const memberIds = cluster.members.filter(m => m.id !== rep.id).map(m => m.id);
      if (!applyClusterMerge.immediate(rep.id, newConf, JSON.stringify(newTags), memberIds)) continue;
      for (const memberId of memberIds) {
        // Create supersedes edge: source=OLD(invalidated), target=NEW(representative)
        // Convention: "target replaces source" (edge-repository.ts:9)
        try {
          client.db.prepare(`
            INSERT OR IGNORE INTO memory_edges (source_id, target_id, relation, weight, created_at)
            VALUES (?, ?, 'supersedes', 1.0, datetime('now'))
          `).run(memberId, rep.id);
        } catch { /* edge creation is best-effort */ }
      }
    }
  }
}
