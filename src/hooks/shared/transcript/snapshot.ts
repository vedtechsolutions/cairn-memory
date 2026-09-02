/**
 * Core transcript types + snapshot shape shared by the transcript modules.
 *
 * Transcript format (Claude Code ≥ 2.x):
 *   Each line is JSON with shape:
 *     { type: "user"|"assistant"|"progress"|"system"|..., message: { role, content }, ... }
 *   - User entries:      message.content is a string OR array of content blocks
 *   - Assistant entries:  message.content is an array containing text and tool_use blocks
 *   - Tool results:      Appear inside "user" entries as { type: "tool_result", content, tool_use_id }
 */

/** Top-level transcript JSONL entry */
export interface RawEntry {
  type: string;
  message?: {
    role?: string;
    content?: string | ContentBlock[];
  };
}

/** Content block inside message.content array */
export interface ContentBlock {
  type: string;
  // text block
  text?: string;
  // tool_use block
  name?: string;
  id?: string;
  input?: Record<string, unknown>;
  // tool_result block
  content?: string;
  tool_use_id?: string;
}

export interface TranscriptSnapshot {
  recentFiles: string[];
  recentReadFiles: string[];
  recentCommands: Array<{ command: string; exitCode?: number; outputSummary: string }>;
  userContext: string[];
  approachNotes: string[];
  initialGoal: string | null;
  recentDecisions: Array<{ chose: string; why: string }>;
  /** Decisions mined from assistant text (Layer 1b — auto-capture safety net) */
  minedDecisions: Array<{ content: string }>;
  /** Hypotheses + open questions mined from assistant text (Phase 5) */
  reasoningState: { hypotheses: string[]; openQuestions: string[] };
  /** Error summary: deduplicated errors encountered during session (Phase 5) */
  errorContext: Array<{ errorKey: string; errorText: string; count: number; lastFile: string | null }>;
  /** Ambient project goal mined from waykeep_plan(create) calls in the tail.
   *  Distinct from initialGoal (which tracks the current-turn task). Persists
   *  across meta turns via the PreCompact sticky carry-forward logic. */
  projectGoal: string | null;
}

/** Command buckets used to retire stale errors when a later same-bucket
 *  command runs cleanly. Keep this list small and well-known — classifying
 *  too aggressively would cause unrelated errors to be retired together. */
export type CommandBucket = 'typecheck' | 'test' | 'build' | 'lint';

export function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + '...';
}

export function emptySnapshot(): TranscriptSnapshot {
  return {
    recentFiles: [],
    recentReadFiles: [],
    recentCommands: [],
    userContext: [],
    approachNotes: [],
    initialGoal: null,
    recentDecisions: [],
    minedDecisions: [],
    reasoningState: { hypotheses: [], openQuestions: [] },
    errorContext: [],
    projectGoal: null,
  };
}
