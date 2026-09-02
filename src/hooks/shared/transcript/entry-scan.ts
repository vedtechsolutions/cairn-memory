/**
 * Per-entry scanners for the parseTranscript passes: user-text collection
 * (first pass) and tool_use / tool_result extraction (tail pass).
 */
import { TOKEN_BUDGET } from '../../../constants/index.js';
import { type RawEntry, type ContentBlock, type CommandBucket, type TranscriptSnapshot, truncate } from './snapshot.js';
import { looksLikeFilePath, classifyCommandBucket } from './classify.js';
import { isHumanMessage } from './goal-extraction.js';
import { extractAssistantDecision } from './decision-extraction.js';
import { isApproachNote, isLikelyErrorOutput } from './signal-extraction.js';
import { TOOL, qualifiedToolName } from '../../../constants/mcp.js';

/** Hoisted: this scan runs per transcript entry. */
const QUALIFIED_PLAN = qualifiedToolName(TOOL.PLAN);
const QUALIFIED_LEARN = qualifiedToolName(TOOL.LEARN);

/** Mutable accumulator state threaded through the tail-pass scanners. */
export interface ScanState {
  seenFiles: Set<string>;
  seenReadFiles: Set<string>;
  seenCommands: Set<string>;
  /** Map tool_use IDs → command strings so we can pair results later */
  pendingBash: Map<string, string>;
  /** Collectors for Phase 5: reasoning state + error context */
  assistantTexts: string[];
  /** Error outputs carry an optional `bucket` tag so we can invalidate
   *  stale errors when a later same-bucket command succeeds. */
  errorOutputs: Array<{ error: string; file: string | null; bucket: CommandBucket | null }>;
  /** Tracks position of tool results for error recency filtering */
  toolResultCount: number;
  /** Latest outcome observed per command bucket. When the last result for
   *  a bucket (e.g. typecheck) was clean, every earlier error in that bucket
   *  is treated as resolved and dropped — catches "hit TS error → fix → run
   *  clean tsc" so stale errors don't survive compaction into the next
   *  session's briefing. */
  lastBucketOutcome: Map<CommandBucket, boolean>;
}

export function emptyScanState(): ScanState {
  return {
    seenFiles: new Set<string>(),
    seenReadFiles: new Set<string>(),
    seenCommands: new Set<string>(),
    pendingBash: new Map<string, string>(),
    assistantTexts: [],
    errorOutputs: [],
    toolResultCount: 0,
    lastBucketOutcome: new Map<CommandBucket, boolean>(),
  };
}

/** First pass: extract user text from ALL lines (cheap string filter first) */
export function collectUserContext(allLines: string[], snapshot: TranscriptSnapshot): void {
  for (const line of allLines) {
    // Quick filter: skip lines that can't be user text messages
    if (!line.includes('"user"')) continue;

    let entry: RawEntry;
    try { entry = JSON.parse(line); } catch { continue; }

    if (entry.type !== 'user') continue;
    const content = entry.message?.content;

    if (typeof content === 'string' && content.trim()) {
      if (isHumanMessage(content)) {
        snapshot.userContext.push(truncate(content, 300));
      }
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'text' && block.text?.trim() && isHumanMessage(block.text)) {
          snapshot.userContext.push(truncate(block.text, 300));
        }
      }
    }
  }
}

/** Assistant entries: contain tool_use blocks */
export function scanAssistantEntry(content: ContentBlock[], snapshot: TranscriptSnapshot, state: ScanState): void {
  for (const block of content) {
    if (block.type === 'tool_use') {
      const toolName = block.name;
      const input = block.input ?? {};

      // File paths from Write/Edit/MultiEdit
      if (toolName === 'Write' || toolName === 'Edit' || toolName === 'MultiEdit') {
        const filePath = input.file_path as string | undefined;
        if (filePath && !state.seenFiles.has(filePath)) {
          state.seenFiles.add(filePath);
          snapshot.recentFiles.push(filePath);
        }
      }

      // Read/Grep — track files that were analyzed. We deliberately
      // skip Glob (it searches directories, never individual files)
      // and we reject any path whose basename looks like a directory
      // (no extension and not a well-known extensionless file). This
      // eliminates "tests", "src", etc. leaking in from Grep/Glob
      // path arguments and polluting the Recently-read section.
      if (toolName === 'Read' || toolName === 'Grep') {
        const readPath = (input.file_path ?? input.path) as string | undefined;
        if (readPath && looksLikeFilePath(readPath) && !state.seenReadFiles.has(readPath)) {
          state.seenReadFiles.add(readPath);
          snapshot.recentReadFiles.push(readPath);
        }
      }

      // waykeep_plan(create) → capture plan name as the ambient project goal.
      // Last-write-wins across the transcript: the most recent create
      // overrides any earlier one so plan pivots are respected.
      if (toolName === QUALIFIED_PLAN || toolName === TOOL.PLAN) {
        const action = input.action as string | undefined;
        if (action === 'create') {
          const planName = input.name as string | undefined;
          if (planName && planName.length >= 10) {
            snapshot.projectGoal = truncate(planName, 200);
          }
        }
      }

      // waykeep_plan(decide) → extract decision snapshots
      if (toolName === QUALIFIED_PLAN || toolName === TOOL.PLAN) {
        const action = input.action as string | undefined;
        if (action === 'decide') {
          const chose = input.chose as string | undefined;
          const why = input.why as string | undefined;
          if (chose && why) {
            snapshot.recentDecisions.push({
              chose: truncate(chose, 150),
              why: truncate(why, 150),
            });
          }
        }
      }

      // waykeep_learn(kind: "decision") → also capture decisions
      if (toolName === QUALIFIED_LEARN || toolName === TOOL.LEARN) {
        const kind = input.kind as string | undefined;
        if (kind === 'decision') {
          const content = input.content as string | undefined;
          if (content) {
            snapshot.recentDecisions.push({
              chose: truncate(content, 150),
              why: `(via ${TOOL.LEARN})`,
            });
          }
        }
      }

      // Bash commands — store ID for pairing with result
      if (toolName === 'Bash') {
        const command = input.command as string | undefined;
        if (command && block.id) {
          state.pendingBash.set(block.id, command);
        }
      }
    }

    // Assistant text → approach notes (only strategy-like content)
    if (block.type === 'text' && block.text && block.text.length > 50 && isApproachNote(block.text)) {
      snapshot.approachNotes.push(truncate(block.text, TOKEN_BUDGET.APPROACH_NOTE_MAX_CHARS));
    }

    // Collect assistant text for reasoning state extraction (Phase 5)
    if (block.type === 'text' && block.text && block.text.length > 30) {
      state.assistantTexts.push(block.text);
    }

    // Layer 1b: Mine decisions from assistant text (safety net for waykeep_learn)
    if (block.type === 'text' && block.text && block.text.length > 40) {
      const mined = extractAssistantDecision(block.text);
      if (mined) {
        snapshot.minedDecisions.push({ content: mined });
      }
    }
  }
}

/** User entries in tail: pair tool_results with Bash commands */
export function scanUserToolResults(content: ContentBlock[], snapshot: TranscriptSnapshot, state: ScanState): void {
  for (const block of content) {
    if (block.type !== 'tool_result') continue;

    // Look up the Bash command that spawned this result. We keep the
    // lookup in scope for both the recent-commands capture and the
    // error-bucket classification below.
    const command = block.tool_use_id ? state.pendingBash.get(block.tool_use_id) : undefined;

    if (command && !state.seenCommands.has(command)) {
      state.seenCommands.add(command);
      const outputSummary = truncate(block.content ?? '', 100);
      snapshot.recentCommands.push({
        command: truncate(command, 200),
        outputSummary,
      });
    }
    if (command && block.tool_use_id) {
      state.pendingBash.delete(block.tool_use_id);
    }

    // Collect error outputs for error context extraction (Phase 5)
    state.toolResultCount++;
    const out = block.content;
    const isError = !!(out && out.length > 20 && isLikelyErrorOutput(out));

    // Record per-bucket outcome so a later success can retire earlier
    // errors in the same bucket.
    const bucket = command ? classifyCommandBucket(command) : null;
    if (bucket) {
      state.lastBucketOutcome.set(bucket, isError);
    }

    if (isError) {
      state.errorOutputs.push({ error: out!, file: null, bucket });
    }
  }
}
