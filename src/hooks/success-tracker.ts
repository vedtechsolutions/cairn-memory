#!/usr/bin/env node
/**
 * PostToolUse hook — success tracker for implicit feedback.
 * Tracks which pitfalls were surfaced per file; on success, boosts confidence.
 * Detects self-correction (same file edited twice consecutively).
 * async: true — no blocking.
 */
import { readStdinJson, type PostToolUseInput } from './shared/hook-io.js';
import { recordRollup } from '../db/telemetry-rollup.js';
import { ROLLUP, ROLLUP_METRICS } from '../constants/index.js';
import { createHookDbClient } from './shared/db-client.js';
import { basename } from 'node:path';
import { CONFIDENCE, LIMITS, TOKEN_BUDGET } from '../constants/index.js';
import { recordTelemetry } from './shared/hook-telemetry.js';
import { updateTracker } from './shared/edit-tracker.js';
import { classifySuccess, type ToolEvent } from '../utils/success-classifier.js';
import { projectId } from '../utils/project-id.js';
import { markRecallSuccess } from '../utils/prediction.js';
import { InvestigationRepository } from '../db/investigation-repository.js';
import { recordGovernanceEventFailOpen } from '../governance/recorder.js';
import { ENV } from '../constants/env.js';
import { log } from '../utils/log.js';

const _startTime = Date.now();

try {
  const input = readStdinJson<PostToolUseInput>();

  // Track Write/Edit/MultiEdit/Bash for success pattern detection
  if (!['Write', 'Edit', 'MultiEdit', 'Bash'].includes(input.tool_name)) {
    process.exit(0);
  }

  const filePaths = extractFilePaths(input);
  const filePath = filePaths[0] ?? undefined;
  const currentTime = Date.now();
  updateTracker(input.session_id, tracker => {

    // Append to tool chain for success pattern detection
    const toolEvent: ToolEvent = {
      tool: input.tool_name,
      file: filePath,
      timestamp: currentTime,
      success: true, // We're in PostToolUse (not Failure)
      output: input.tool_name === 'Bash' ? String(input.tool_response ?? '').slice(0, 200) : undefined,
    };
    tracker.toolChain.push(toolEvent);

    // Check for success pattern when Bash completes
    if (input.tool_name === 'Bash' && tracker.toolChain.length >= LIMITS.SUCCESS_MIN_TOOL_CHAIN) {
      const classification = classifySuccess(tracker.toolChain, tracker.successDedup);
      if (classification.learnable) {
        tracker.successDedup = { lastPattern: classification.pattern, lastTime: Date.now() };

        // Auto-checkpoint: add progress note to active plan step
        // (No memory creation — generic "edit → test pass" patterns are noise.
        //  Plan checkpoints are useful; permanent memories of them are not.)
        try {
          const dbPath = process.env[ENV.DB_PATH] ?? undefined;
          const client = createHookDbClient(dbPath);
          const project = projectId(input.cwd);
          const activePlan = client.planRepo.getActive(project);
          if (activePlan) {
            const inProgress = activePlan.steps.find(s => s.status === 'in_progress');
            if (inProgress) {
              const editedFiles = tracker.toolChain
                .filter(t => t.file && (t.tool === 'Edit' || t.tool === 'Write' || t.tool === 'MultiEdit'))
                .map(t => basename(t.file!))
                .slice(-3);
              if (editedFiles.length > 0) {
                const note = `Verified: ${editedFiles.join(', ')} (tests pass)`;
                client.planRepo.addNote(activePlan.id, {
                  step_id: inProgress.step_id,
                  note: note.slice(0, TOKEN_BUDGET.NOTE_MAX_CHARS),
                });
              }
            }
          }
          client.close();
        } catch { /* best-effort — plan checkpoint is advisory */ }
      }
      // Resolve active investigation chain on success pattern (tests pass)
      if (classification.learnable) {
        try {
          const resolveDbPath = process.env[ENV.DB_PATH] ?? undefined;
          const resolveClient = createHookDbClient(resolveDbPath);
          const resolveProject = projectId(input.cwd);
          const investigationRepo = new InvestigationRepository(resolveClient.db);
          const activeChain = investigationRepo.getActiveChain(resolveProject, input.session_id);
          if (activeChain) {
            const editedFiles = tracker.toolChain
              .filter(t => t.file && t.success && (t.tool === 'Edit' || t.tool === 'Write' || t.tool === 'MultiEdit'))
              .map(t => basename(t.file!))
              .slice(-3);
            const resolution = editedFiles.length > 0
              ? `Fixed via ${editedFiles.join(', ')} — ${classification.pattern}`
              : `Resolved — ${classification.pattern}`;
            investigationRepo.resolve(activeChain.id, resolution.slice(0, 200));
          }
          resolveClient.close();
        } catch { /* best-effort */ }
      }

      // Reset tool chain after detection attempt
      tracker.toolChain = [];
    }

    // Trim old tool chain entries (keep last 20)
    if (tracker.toolChain.length > LIMITS.TOOL_CHAIN_MAX) {
      tracker.toolChain = tracker.toolChain.slice(-LIMITS.TOOL_CHAIN_MAX);
    }

    // File-level tracking for Write/Edit/MultiEdit
    const isEditTool = input.tool_name === 'Write' || input.tool_name === 'Edit' || input.tool_name === 'MultiEdit';
    if (isEditTool && filePaths.length > 0) {
      // Implicit positive feedback: if pitfalls were surfaced for any of these files
      // and the edit succeeded, boost confidence
      let needsDb = false;
      for (const fp of filePaths) {
        if (tracker.surfacedPitfalls[fp]?.length > 0) { needsDb = true; break; }
      }

      if (needsDb) {
        const dbPath = process.env[ENV.DB_PATH] ?? undefined;
        const client = createHookDbClient(dbPath);

        let verifiedImpacts = 0;
        for (const fp of filePaths) {
          const surfacedForFile = tracker.surfacedPitfalls[fp];
          if (surfacedForFile && surfacedForFile.length > 0) {
            for (const memId of surfacedForFile) {
              // Prediction verified: pitfall surfaced + tool succeeded → stronger boost
              client.memoryRepo.boostConfidence(memId, CONFIDENCE.PREDICTION_VERIFIED_BOOST);
              client.memoryRepo.incrementImpact(memId);
              verifiedImpacts++;
              // Mark as successful recall for session continuity scoring
              try { markRecallSuccess(client.db, input.session_id, memId); } catch { /* best-effort */ }
            }
            delete tracker.surfacedPitfalls[fp];
          }
        }
        // Tokens-saved report proxy (see success-tracker-handler twin).
        recordRollup(client.db, input.session_id, ROLLUP_METRICS.IMPACT_PROXY, 'success-tracker', verifiedImpacts * ROLLUP.IMPACT_PROXY_TOKENS, verifiedImpacts);

        client.close();
      }

      tracker.lastEditPath = filePath;
      tracker.lastEditTime = currentTime;
    }

  });
  // Governance is a post-business-result tee. Its failures are deliberately
  // invisible to the existing hook output and telemetry behavior.
  try {
    const governanceClient = createHookDbClient(process.env[ENV.DB_PATH] ?? undefined);
    await recordGovernanceEventFailOpen(governanceClient.db, input);
    governanceClient.close();
  } catch { /* fail open */ }
  recordTelemetry('success-tracker', input.tool_name, _startTime, true);
} catch (err) {
  recordTelemetry('success-tracker', 'error', _startTime, false, String(err));
  log.error('Success tracker hook error:', err);
  process.exit(0);
}

/** Extract file paths from tool_input — handles MultiEdit edits[] array */
function extractFilePaths(input: PostToolUseInput): string[] {
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
