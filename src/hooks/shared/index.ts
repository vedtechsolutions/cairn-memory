export { createHookDbClient, type HookDbClient } from './db-client.js';
export {
  readStdinJson,
  outputAdditionalContext,
  outputPreToolUseAllow,
  type HookInput,
  type SessionStartInput,
  type PreCompactInput,
  type SessionEndInput,
  type UserPromptSubmitInput,
  type PreToolUseInput,
  type PostToolUseFailureInput,
  type PostToolUseInput,
  type PostCompactInput,
  type SubagentStartInput,
} from './hook-io.js';
export { parseTranscript, isMetaGoal, type TranscriptSnapshot } from './transcript-parser.js';
export {
  resolveInitialGoal,
  resolveProjectGoal,
  type InitialGoalResolution,
  type ProjectGoalResolution,
} from './goal-resolver.js';
export { compileBriefing, type BriefingContext } from './briefing-compiler.js';
export { readState, writeState, type CairnState } from './state-io.js';
export { recordTelemetry } from './hook-telemetry.js';
