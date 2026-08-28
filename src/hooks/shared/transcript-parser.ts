/**
 * Parse Claude Code transcript JSONL files.
 * Extracts recent file paths, commands, user messages, and assistant reasoning.
 *
 * Facade: the implementation lives in ./transcript/ — this module re-exports
 * the public surface so existing importers keep working unchanged.
 */
export {
  type TranscriptSnapshot,
  type CommandBucket,
} from './transcript/snapshot.js';
export { looksLikeFilePath, classifyCommandBucket } from './transcript/classify.js';
export { parseTranscript } from './transcript/parse-transcript.js';
export { emptySnapshot } from './transcript/snapshot.js';
export { isMetaGoal, distillGoal } from './transcript/goal-extraction.js';
export { extractAssistantDecision, extractDecisionSigils } from './transcript/decision-extraction.js';
export {
  isApproachNote,
  extractWinningPattern,
  isLikelyErrorOutput,
  extractErrorContext,
} from './transcript/signal-extraction.js';
export { extractReasoningState } from './transcript/reasoning-state.js';
