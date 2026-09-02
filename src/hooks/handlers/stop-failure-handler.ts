/**
 * StopFailure handler — learn from API errors.
 * Pure business logic: no stdin/stdout/process.exit.
 */
import type { HookInput } from '../shared/hook-io.js';
import type { HookDbClient } from '../shared/db-client.js';
import { projectId } from '../../utils/project-id.js';
import { CONFIDENCE, API_FAILURE_PITFALLS } from '../../constants/index.js';

export interface StopFailureInput extends HookInput {
  error_type?: string;
  error_message?: string;
}

/** True when a failure type has stored advice — lets the standalone entry
 *  point skip opening a pitfall-store client for the (common) types that
 *  have none. */
export function hasActionableAdvice(errorType: string): boolean {
  // Own keys only: `in` would match prototype names such as "constructor".
  return Object.hasOwn(API_FAILURE_PITFALLS, errorType);
}

export interface StopFailureResult {
  errorType: string;
  pitfallCreated: boolean;
}

export function handleStopFailure(input: StopFailureInput, client: HookDbClient): StopFailureResult {
  const errorType = input.error_type ?? 'unknown';
  const pitfallContent = hasActionableAdvice(errorType) ? API_FAILURE_PITFALLS[errorType] : undefined;

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
