/**
 * Session-aware warnings (A1 recent-failure, A2 edit-fail loop, A3 rapid
 * re-edit) with per-(type, file) cooldowns persisted on the edit tracker.
 */
import type { EditTracker } from '../../shared/edit-tracker.js';
import { PROACTIVE } from '../../../constants/index.js';

/**
 * A1/A2/A3 each get a 60s per-(type, file) cooldown to prevent the same
 * warning from flooding the injection stream on every consecutive edit.
 * The cooldown map lives on the tracker so it persists across standalone
 * hook invocations via the tracker file.
 */
export function applySessionWarnings(
  tracker: EditTracker,
  warnings: string[],
  filePath: string | undefined,
  isEditTool: boolean,
  nowMs: number,
): void {
  tracker.recentWarningFired = tracker.recentWarningFired ?? {};

  const shouldFireWarning = (type: 'A1' | 'A2' | 'A3', file: string): boolean => {
    const key = `${type}:${file}`;
    const last = tracker.recentWarningFired[key];
    return !last || (nowMs - last) >= PROACTIVE.WARNING_COOLDOWN_MS;
  };
  const recordWarningFired = (type: 'A1' | 'A2' | 'A3', file: string): void => {
    tracker.recentWarningFired[`${type}:${file}`] = nowMs;
  };

  // A1: Check for recent file failures in toolChain
  if (filePath && shouldFireWarning('A1', filePath)) {
    const recentFailures = tracker.toolChain.filter(
      e => e.file === filePath && !e.success && (nowMs - e.timestamp) < 300_000,
    );
    if (recentFailures.length > 0) {
      const lastError = recentFailures[recentFailures.length - 1].output ?? 'unknown error';
      warnings.push(`This file had ${recentFailures.length} error(s) this session. Last: "${lastError.slice(0, 80)}"`);
      recordWarningFired('A1', filePath);
    }
  }

  // A2: Tool chain loop detection (Edit->Bash(fail)->Edit on same file)
  if (isEditTool && filePath && shouldFireWarning('A2', filePath)) {
    const recentChain = tracker.toolChain.slice(-PROACTIVE.LOOP_LOOKBACK);
    const loopDetected = detectEditFailLoop(recentChain, filePath);
    if (loopDetected) {
      warnings.push('Loop detected: you have edited this file and it failed repeatedly. Re-read the file or try a different approach.');
      recordWarningFired('A2', filePath);
    }
  }

  // A3: Rapid re-edit detection
  if (isEditTool && filePath && tracker.lastEditPath === filePath && shouldFireWarning('A3', filePath)) {
    const elapsed = nowMs - tracker.lastEditTime;
    if (elapsed < PROACTIVE.RAPID_REEDIT_MS && elapsed > 0) {
      warnings.push('You are re-editing this file quickly. Consider re-reading it first to verify current content.');
      recordWarningFired('A3', filePath);
    }
  }

  // Prune stale cooldown entries so the map doesn't grow unbounded on
  // long-lived sessions. Entries older than 2× the cooldown window are
  // definitely expired and safe to drop.
  const pruneBefore = nowMs - PROACTIVE.WARNING_COOLDOWN_MS * 2;
  for (const key of Object.keys(tracker.recentWarningFired)) {
    if (tracker.recentWarningFired[key] < pruneBefore) {
      delete tracker.recentWarningFired[key];
    }
  }
}

/** Detect Edit->Bash(fail)->Edit loop pattern on the same file */
export function detectEditFailLoop(chain: Array<{ tool: string; file?: string; success: boolean }>, filePath: string): boolean {
  let sawEdit = false;
  let sawFailAfterEdit = false;

  for (const event of chain) {
    if (!sawEdit) {
      if ((event.tool === 'Edit' || event.tool === 'Write' || event.tool === 'MultiEdit') && event.file === filePath) {
        sawEdit = true;
      }
    } else if (!sawFailAfterEdit) {
      if (!event.success) {
        sawFailAfterEdit = true;
      }
    } else {
      if ((event.tool === 'Edit' || event.tool === 'Write' || event.tool === 'MultiEdit') && event.file === filePath) {
        return true;
      }
    }
  }
  return false;
}
