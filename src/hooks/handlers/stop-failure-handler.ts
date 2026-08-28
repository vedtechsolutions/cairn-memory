/**
 * StopFailure handler — learn from API errors.
 * Pure business logic: no stdin/stdout/process.exit.
 */
import type { HookInput } from '../shared/hook-io.js';
import type { HookDbClient } from '../shared/db-client.js';
import { projectId } from '../../utils/project-id.js';
import { CONFIDENCE } from '../../constants/index.js';

interface StopFailureInput extends HookInput {
  error_type?: string;
  error_message?: string;
}

const FAILURE_PITFALLS: Record<string, string> = {
  max_output_tokens: 'Break large tasks into smaller steps — the response hit the output token limit. Use plan mode for multi-step work.',
  rate_limit: 'Rate limited — reduce parallel tool calls and batch operations when possible.',
};

export interface StopFailureResult {
  errorType: string;
  pitfallCreated: boolean;
}

export function handleStopFailure(input: StopFailureInput, client: HookDbClient): StopFailureResult {
  const errorType = input.error_type ?? 'unknown';
  const pitfallContent = FAILURE_PITFALLS[errorType];

  if (pitfallContent) {
    const project = projectId(input.cwd);
    client.memoryRepo.storePitfall({
      content: pitfallContent,
      project,
      confidence: CONFIDENCE.AUTO_DETECTED,
      tags: ['api', errorType],
    });
    return { errorType, pitfallCreated: true };
  }

  return { errorType, pitfallCreated: false };
}
