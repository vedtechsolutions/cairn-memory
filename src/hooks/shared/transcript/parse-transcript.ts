/**
 * Parse Claude Code transcript JSONL files.
 * Extracts recent file paths, commands, user messages, and assistant reasoning.
 */
import { readFileSync, existsSync, statSync } from 'node:fs';
import { TRANSCRIPT_TAIL_BYTES, TRANSCRIPT_FULL_READ_THRESHOLD, TRANSCRIPT_HEAD_READ_BYTES } from '../../../constants/index.js';
import { type RawEntry, type CommandBucket, type TranscriptSnapshot, emptySnapshot } from './snapshot.js';
import { isSafeTranscriptPath, readHead, readTail } from './jsonl-io.js';
import { isMetaGoal, distillGoal, mineInitialGoalFromHead } from './goal-extraction.js';
import { extractErrorContext } from './signal-extraction.js';
import { extractReasoningState } from './reasoning-state.js';
import { emptyScanState, collectUserContext, scanAssistantEntry, scanUserToolResults } from './entry-scan.js';

/** Parse transcript JSONL and extract recent state. Accepts null (the
 *  contract's transcript_path is `string | null`) — empty snapshot. */
export function parseTranscript(transcriptPath: string | null, maxEntries = 200): TranscriptSnapshot {
  if (transcriptPath === null) return emptySnapshot();
  // Validate path — must be absolute and under expected directories
  if (!isSafeTranscriptPath(transcriptPath)) return emptySnapshot();
  if (!existsSync(transcriptPath)) return emptySnapshot();

  // Read file — bookend read for large files: head (goal) + tail (recent state)
  let fullRaw: string;
  let headLines: string[] = []; // Extra lines from file head (for goal extraction)
  try {
    const fileSize = statSync(transcriptPath).size;
    if (fileSize >= TRANSCRIPT_FULL_READ_THRESHOLD) {
      // Large file: read head for goal + tail for recent state
      fullRaw = readTail(transcriptPath, fileSize, TRANSCRIPT_TAIL_BYTES);
      // Bookend: also read head to find the original goal
      if (fileSize > TRANSCRIPT_TAIL_BYTES + TRANSCRIPT_HEAD_READ_BYTES) {
        // Head and tail don't overlap — read head separately
        const headRaw = readHead(transcriptPath, TRANSCRIPT_HEAD_READ_BYTES);
        headLines = headRaw.split('\n').filter(Boolean);
      }
      // else: tail already covers the head, no need for separate read
    } else {
      fullRaw = readFileSync(transcriptPath, 'utf-8');
    }
  } catch {
    return emptySnapshot();
  }

  const allLines = fullRaw.split('\n').filter(Boolean);

  const snapshot: TranscriptSnapshot = emptySnapshot();
  const state = emptyScanState();

  // First pass: extract user text from ALL lines (cheap string filter first)
  collectUserContext(allLines, snapshot);

  // Second pass: tail only — extract tool use, commands, approach notes
  const recentLines = allLines.slice(-maxEntries);

  for (const line of recentLines) {
    let entry: RawEntry;
    try { entry = JSON.parse(line); } catch { continue; }

    const entryType = entry.type;
    const content = entry.message?.content;

    // --- Assistant entries: contain tool_use blocks ---
    if (entryType === 'assistant' && Array.isArray(content)) {
      scanAssistantEntry(content, snapshot, state);
    }

    // --- User entries in tail: pair tool_results with Bash commands ---
    if (entryType === 'user' && Array.isArray(content)) {
      scanUserToolResults(content, snapshot, state);
    }
  }

  // Goal extraction: prefer the LATEST substantial user message over the first.
  // This captures goal pivots — when the user opens with one task but later
  // pivots to a different one, the latest goal wins.
  // Head lines are only used as fallback when the tail has no substantial messages.

  // Phase 1: Find the latest substantial user message from userContext (tail)
  // Iterate in reverse to find the most recent non-meta message.
  for (let i = snapshot.userContext.length - 1; i >= 0; i--) {
    const msg = snapshot.userContext[i];
    if (msg.length > 20 && !isMetaGoal(msg)) {
      snapshot.initialGoal = msg;
      break;
    }
  }

  // Phase 2: Fall back to head lines (original session start — only for fresh transcripts)
  if (!snapshot.initialGoal && headLines.length > 0) {
    snapshot.initialGoal = mineInitialGoalFromHead(headLines);
  }

  // Phase 5: Extract reasoning state + error context from collected data
  // Limit reasoning extraction to recent text — early-session questions that were
  // resolved later should not persist as "open questions" in the briefing
  snapshot.reasoningState = extractReasoningState(state.assistantTexts.slice(-15));
  // Resolution gate: drop any error whose bucket ended on a clean run.
  // If the last observed tsc run was clean, every earlier tsc error is
  // retired — same for test/build/lint. Errors with no bucket (unclassified
  // commands, non-Bash tool_results) are untouched. This runs BEFORE the
  // second-half recency slice so we never surface errors the transcript
  // itself already proves were fixed.
  const resolvedBuckets = new Set<CommandBucket>();
  for (const [bucket, wasError] of state.lastBucketOutcome) {
    if (!wasError) resolvedBuckets.add(bucket);
  }
  const liveErrors = state.errorOutputs.filter(e => !(e.bucket && resolvedBuckets.has(e.bucket)));
  // Error recency: only keep errors from the second half of tool results.
  // Errors from early in the session are overwhelmingly likely to be fixed
  // by the time compaction happens (e.g., TS2339 that was resolved mid-session).
  const recentErrors = liveErrors.length > 2
    ? liveErrors.slice(Math.ceil(liveErrors.length / 2))
    : liveErrors;
  // Strip the transient `bucket` field before handing to extractErrorContext.
  snapshot.errorContext = extractErrorContext(
    recentErrors.map(e => ({ error: e.error, file: e.file })),
  );

  // Phase 5: Goal distillation — strip filler prefixes, normalize
  if (snapshot.initialGoal) {
    snapshot.initialGoal = distillGoal(snapshot.initialGoal);
  }

  // Keep only the most recent items
  snapshot.userContext = snapshot.userContext.slice(-3);
  snapshot.approachNotes = snapshot.approachNotes.slice(-5);
  snapshot.recentFiles = snapshot.recentFiles.slice(-10);
  snapshot.recentReadFiles = snapshot.recentReadFiles.slice(-10);
  snapshot.recentCommands = snapshot.recentCommands.slice(-5);
  snapshot.recentDecisions = snapshot.recentDecisions.slice(-5);
  snapshot.minedDecisions = snapshot.minedDecisions.slice(-10);

  return snapshot;
}
