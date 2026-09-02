#!/usr/bin/env node
/**
 * StopFailure hook — learn from API errors (rate_limit, max_output_tokens, server_error).
 * Matchers: rate_limit, max_output_tokens, server_error
 * Lightweight: records telemetry and, through the shared handler, stores a
 * targeted pitfall for the failure types that have actionable advice. The
 * entry point owns only stdin, the database client and telemetry — the
 * business logic lives in handlers/stop-failure-handler.ts (the daemon route
 * runs the same handler in-process).
 */
import { readStdinJson } from './shared/hook-io.js';
import { createHookDbClient } from './shared/db-client.js';
import { handleStopFailure, hasActionableAdvice, type StopFailureInput } from './handlers/stop-failure-handler.js';
import { recordTelemetry } from './shared/hook-telemetry.js';
import { ENV } from '../constants/env.js';

const _startTime = Date.now();
try {
  const input = readStdinJson<StopFailureInput>();
  const errorType = input.error_type ?? 'unknown';

  // Record all API failures in telemetry for trend analysis
  recordTelemetry('stop-failure', errorType, _startTime, true, input.error_message);

  // A pitfall-store client only when there is advice to store (telemetry
  // above keeps its own short-lived connection either way).
  if (hasActionableAdvice(errorType)) {
    const client = createHookDbClient(process.env[ENV.DB_PATH] ?? undefined);
    try {
      handleStopFailure(input, client);
    } finally {
      client.close();
    }
  }
} catch (err) {
  recordTelemetry('stop-failure', 'error', _startTime, false, String(err));
  process.exit(0);
}
