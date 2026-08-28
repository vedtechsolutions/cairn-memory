/**
 * Success tracker handler — implicit feedback from successful tool use.
 * Tracks pitfall surfacing, boosts confidence on success, detects success patterns.
 * Pure business logic: no stdin/stdout/process.exit.
 */
import type { PostToolUseInput } from '../shared/hook-io.js';
import { recordRollup } from '../../db/telemetry-rollup.js';
import { ROLLUP, ROLLUP_METRICS } from '../../constants/index.js';
import type { CachedHookContext } from '../shared/db-client.js';
import { basename } from 'node:path';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { CONFIDENCE, LIMITS, TOKEN_BUDGET, isEditToolName } from '../../constants/index.js';
import { loadTracker, saveTracker, type ResumeCursor } from '../shared/edit-tracker.js';
import { classifySuccess, type ToolEvent } from '../../utils/success-classifier.js';
import { extractPatchFilePaths, patchTextOf } from '../shared/patch-paths.js';
import { projectId } from '../../utils/project-id.js';
import { markRecallSuccess } from '../../utils/prediction.js';
import { recordGovernanceEventFailOpen } from '../../governance/recorder.js';
import type { RecorderDiagnostic } from '../../governance/types.js';

export interface SuccessTrackerResult {
  tracked: boolean;
  /** Internal-only recorder status; route output deliberately omits it. */
  recorder?: RecorderDiagnostic;
}

export async function handleSuccessTracker(
  input: PostToolUseInput,
  client: CachedHookContext,
): Promise<SuccessTrackerResult> {
  const result = handleSuccessTrackerBusiness(input, client);
  if (!['Write', 'Edit', 'MultiEdit', 'Bash'].includes(input.tool_name)) return result;
  return { ...result, recorder: await recordGovernanceEventFailOpen(client.db, input) };
}

function handleSuccessTrackerBusiness(input: PostToolUseInput, client: CachedHookContext): SuccessTrackerResult {
  // Governance recording above stays Claude-scoped; business tracking
  // covers every edit-type tool plus Bash.
  if (input.tool_name !== 'Bash' && !isEditToolName(input.tool_name)) {
    return { tracked: false };
  }

  const filePaths = extractFilePaths(input);
  const filePath = filePaths[0] ?? undefined;
  const currentTime = Date.now();
  const tracker = client.cache?.getTracker(input.session_id) ?? loadTracker(input.session_id);

  // Append to tool chain for success pattern detection
  const toolEvent: ToolEvent = {
    tool: input.tool_name,
    file: filePath,
    timestamp: currentTime,
    success: true,
    output: input.tool_name === 'Bash' ? String(input.tool_response ?? '').slice(0, 200) : undefined,
  };
  tracker.toolChain.push(toolEvent);

  // Check for success pattern when Bash completes
  if (input.tool_name === 'Bash' && tracker.toolChain.length >= LIMITS.SUCCESS_MIN_TOOL_CHAIN) {
    const classification = classifySuccess(tracker.toolChain, tracker.successDedup);
    if (classification.learnable) {
      tracker.successDedup = { lastPattern: classification.pattern, lastTime: Date.now() };

      // Auto-checkpoint on active plan step
      try {
        const project = projectId(input.cwd);
        const activePlan = client.planRepo.getActive(project);
        if (activePlan) {
          const inProgress = activePlan.steps.find(s => s.status === 'in_progress');
          if (inProgress) {
            const editedFiles = tracker.toolChain
              .filter(t => t.file && isEditToolName(t.tool))
              .map(t => basename(t.file!))
              .slice(-3);
            if (editedFiles.length > 0) {
              const note = `Verified: ${editedFiles.join(', ')} (tests pass)`;
              const trimmed = note.slice(0, TOKEN_BUDGET.NOTE_MAX_CHARS);
              // GAP I: dedup against last note on the same step so repeated
              // test-pass fires don't create a wall of identical entries.
              const lastNote = inProgress.notes[inProgress.notes.length - 1]?.note;
              const normalised = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
              if (!lastNote || normalised(lastNote) !== normalised(trimmed)) {
                client.planRepo.addNote(activePlan.id, {
                  step_id: inProgress.step_id,
                  note: trimmed,
                });
              }
            }
          }
        }
      } catch { /* best-effort */ }

      // Resolve active investigation chain on success
      try {
        const project = projectId(input.cwd);
        const activeChain = client.investigationRepo.getActiveChain(project, input.session_id);
        if (activeChain) {
          const editedFiles = tracker.toolChain
            .filter(t => t.file && t.success && isEditToolName(t.tool))
            .map(t => basename(t.file!))
            .slice(-3);
          const resolution = editedFiles.length > 0
            ? `Fixed via ${editedFiles.join(', ')} — ${classification.pattern}`
            : `Resolved — ${classification.pattern}`;
          client.investigationRepo.resolve(activeChain.id, resolution.slice(0, 200));
        }
      } catch { /* best-effort */ }

      tracker.toolChain = [];
    }
  }

  // Trim old tool chain entries
  if (tracker.toolChain.length > LIMITS.TOOL_CHAIN_MAX) {
    tracker.toolChain = tracker.toolChain.slice(-LIMITS.TOOL_CHAIN_MAX);
  }

  // File-level tracking for edit-type tools — boost confidence on surfaced
  // pitfalls. apply_patch (Codex) counts: its file paths come from the
  // patch envelope headers.
  const isEditTool = isEditToolName(input.tool_name);
  if (isEditTool && filePaths.length > 0) {
    let needsBoost = false;
    for (const fp of filePaths) {
      if (tracker.surfacedPitfalls[fp]?.length > 0) { needsBoost = true; break; }
    }

    if (needsBoost) {
      let verifiedImpacts = 0;
      for (const fp of filePaths) {
        const surfacedForFile = tracker.surfacedPitfalls[fp];
        if (surfacedForFile && surfacedForFile.length > 0) {
          for (const memId of surfacedForFile) {
            client.memoryRepo.boostConfidence(memId, CONFIDENCE.PREDICTION_VERIFIED_BOOST);
            client.memoryRepo.incrementImpact(memId);
            verifiedImpacts++;
            try { markRecallSuccess(client.db, input.session_id, memId); } catch { /* best-effort */ }
          }
          delete tracker.surfacedPitfalls[fp];
        }
      }
      // Tokens-saved report: each verified impact (surfaced lesson +
      // confirmed success) counts as one PROXY unit — the report labels
      // these as estimates, never as measurements.
      recordRollup(client.db, input.session_id, ROLLUP_METRICS.IMPACT_PROXY, 'success-tracker', verifiedImpacts * ROLLUP.IMPACT_PROXY_TOKENS);
    }

    tracker.lastEditPath = filePath ?? null;
    tracker.lastEditTime = currentTime;

    // Phase 2: resume cursor. Captures (file, line, tool, at) so the next
    // briefing can render "Resume: foo.ts:240 (Edit, 3m ago)". Line is
    // best-effort: null if the file is unreadable or the old_string anchor
    // can't be located (e.g. racing with a reformat). The cursor still
    // carries file + tool + timestamp so the briefing can tell you what you
    // were touching even without a precise line.
    // apply_patch has no old_string anchor to locate — no cursor for it.
    if (filePath && input.tool_name !== 'apply_patch') {
      const cursor: ResumeCursor = {
        file: filePath,
        line: extractCursorLine(input.tool_name as ResumeCursor['tool'], filePath, input.tool_input),
        tool: input.tool_name as ResumeCursor['tool'],
        at: currentTime,
      };
      tracker.lastEditCursor = cursor;
    }

    // Phase 3: per-file edit counter. Tracks how many times each file was
    // touched in this session — used by SessionEnd to auto-generate a
    // planning pitfall for files that required too many iterations. For
    // MultiEdit we increment each unique target file since it semantically
    // represents one round of work per file.
    for (const fp of filePaths) {
      tracker.editCountsByFile[fp] = (tracker.editCountsByFile[fp] ?? 0) + 1;
    }
  }

  if (client.cache) {
    client.cache.setTracker(input.session_id, tracker);
  } else {
    saveTracker(tracker, input.session_id);
  }
  return { tracked: true };
}

/** Best-effort line extraction for the resume cursor. Reads the file once
 *  and searches for the Edit anchor; returns null on any failure. Size-
 *  gated at 1 MB so we don't slurp huge generated files on the hot path. */
const MAX_CURSOR_READ_BYTES = 1024 * 1024;

function extractCursorLine(
  tool: ResumeCursor['tool'],
  filePath: string,
  toolInput: Record<string, unknown>,
): number | null {
  // Write always lands at line 1 — that's where the content starts.
  if (tool === 'Write') return 1;

  try {
    if (!existsSync(filePath)) return null;
    const size = statSync(filePath).size;
    if (size === 0 || size > MAX_CURSOR_READ_BYTES) return null;

    let anchor: string | null = null;
    if (tool === 'Edit') {
      const oldString = toolInput.old_string;
      if (typeof oldString === 'string' && oldString.length > 0) {
        anchor = oldString;
      }
    } else if (tool === 'MultiEdit') {
      const edits = toolInput.edits;
      if (Array.isArray(edits) && edits.length > 0) {
        const first = edits[0] as Record<string, unknown>;
        const oldString = first.old_string;
        if (typeof oldString === 'string' && oldString.length > 0) {
          anchor = oldString;
        }
      }
    }
    if (!anchor) return null;

    const content = readFileSync(filePath, 'utf-8');
    // Post-Edit, the old_string no longer exists in the file — but the
    // new_string does at the same position. Try both.
    let idx = content.indexOf(anchor);
    if (idx < 0) {
      const newString = tool === 'Edit'
        ? toolInput.new_string
        : (((toolInput.edits as Array<Record<string, unknown>>)[0] ?? {}).new_string);
      if (typeof newString === 'string' && newString.length > 0) {
        idx = content.indexOf(newString);
      }
    }
    if (idx < 0) return null;
    // Count newlines before idx (1-indexed line number)
    let line = 1;
    for (let i = 0; i < idx; i++) if (content.charCodeAt(i) === 10) line++;
    return line;
  } catch {
    return null;
  }
}

function extractFilePaths(input: PostToolUseInput): string[] {
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
