#!/usr/bin/env node
/**
 * StopFailure hook — learn from API errors (rate_limit, max_output_tokens, server_error).
 * Matchers: rate_limit, max_output_tokens, server_error
 * Lightweight: records telemetry and creates targeted pitfalls for actionable errors.
 */
import { readStdinJson, type HookInput } from './shared/hook-io.js';
import { createHookDbClient } from './shared/db-client.js';
import { projectId } from '../utils/project-id.js';
import { CONFIDENCE } from '../constants/index.js';
import { recordTelemetry } from './shared/hook-telemetry.js';

interface StopFailureInput extends HookInput {
  error_type?: string;
  error_message?: string;
}

/** Actionable pitfalls for specific API failure types */
const FAILURE_PITFALLS: Record<string, string> = {
  max_output_tokens: 'Break large tasks into smaller steps — the response hit the output token limit. Use plan mode for multi-step work.',
  rate_limit: 'Rate limited — reduce parallel tool calls and batch operations when possible.',
};

const _startTime = Date.now();
try {
  const input = readStdinJson<StopFailureInput>();
  const errorType = input.error_type ?? 'unknown';

  // Record all API failures in telemetry for trend analysis
  recordTelemetry('stop-failure', errorType, _startTime, true, input.error_message);

  // Create actionable pitfall for error types that have actionable advice
  const pitfallContent = FAILURE_PITFALLS[errorType];
  if (pitfallContent) {
    const dbPath = process.env.CAIRN_DB_PATH ?? undefined;
    const client = createHookDbClient(dbPath);
    const project = projectId(input.cwd);

    // Unified gateway handles dedup + smart merge (confidence boost on repeat)
    client.memoryRepo.storePitfall({
      content: pitfallContent,
      project,
      confidence: CONFIDENCE.AUTO_DETECTED,
      tags: ['api', errorType],
    });

    client.close();
  }
} catch (err) {
  recordTelemetry('stop-failure', 'error', _startTime, false, String(err));
  process.exit(0);
}
