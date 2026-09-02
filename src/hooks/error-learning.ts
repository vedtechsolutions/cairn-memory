#!/usr/bin/env node
/**
 * PostToolUseFailure hook — thin wrapper around the error-learning handler.
 * Detects learnable errors, auto-encodes pitfalls, detects repeated mistakes,
 * and escalates when the same error pattern recurs within a session.
 *
 * This wrapper is the fallback path when the embedded hook socket is not
 * reachable (cold boot, before the MCP server has started). When the socket
 * IS reachable, the relay posts to the daemon's /error-learning route
 * instead. All pipeline logic lives in handlers/error-learning-handler.ts —
 * this file only does stdin/stdout, telemetry, and exit codes. Without a
 * SessionCache the handler uses the locked updateTracker path, preserving
 * race protection between concurrent standalone hook processes.
 */
import { readStdinJson, type PostToolUseFailureInput } from './shared/hook-io.js';
import { createHookDbClient } from './shared/db-client.js';
import { handleErrorLearning } from './handlers/error-learning-handler.js';
import { recordTelemetry } from './shared/hook-telemetry.js';
import { ENV } from '../constants/env.js';

const _startTime = Date.now();
try {
  const input = readStdinJson<PostToolUseFailureInput>();
  const dbPath = process.env[ENV.DB_PATH] ?? undefined;
  const client = createHookDbClient(dbPath);

  const result = await handleErrorLearning(input, client);

  if (result.surfacedProcessed) {
    const { count, files } = result.surfacedProcessed;
    console.error(`[cairn] Processed ${count} surfaced pitfall(s) after error on ${files.join(', ')}`);
  }

  // result.output is the serialized hookSpecificOutput/additionalContext
  // payload (same shape outputAdditionalContext produces) — inject as-is.
  if (result.output) {
    process.stdout.write(result.output);
  }

  // Telemetry mirrors the pre-refactor standalone script: escalations and
  // learned pitfalls are recorded; skip/warning paths are not.
  if (result.action === 'escalation') {
    recordTelemetry('error-learning', 'escalation', _startTime, true, undefined, {
      sessionCount: result.sessionCount,
      tool: input.tool_name,
      category: result.category ?? 'unknown',
    }, client.db);
  } else if (result.action === 'learned-new' || result.action === 'learned-deduped') {
    recordTelemetry('error-learning', input.tool_name, _startTime, true, undefined, {
      repeated: result.action === 'learned-deduped',
      sessionCount: result.sessionCount,
    }, client.db);
  }

  client.close();
} catch (err) {
  recordTelemetry('error-learning', 'error', _startTime, false, String(err));
  console.error('[cairn] Error learning hook error:', err);
  process.exit(0);
}
