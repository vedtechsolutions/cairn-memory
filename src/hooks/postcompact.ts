#!/usr/bin/env node
/**
 * PostCompact hook — records compaction metadata for reliable session type detection.
 * Sets a definitive flag in edit-tracker.json so SessionStart doesn't need
 * the 60-second DB heuristic to infer post-compaction state.
 * async: true — observability only, no blocking, no stdout.
 */
import { readStdinJson, type PostCompactInput } from './shared/hook-io.js';
import { createHookDbClient } from './shared/db-client.js';
import { handlePostCompact } from './handlers/postcompact-handler.js';
import { recordTelemetry } from './shared/hook-telemetry.js';
import { ENV } from '../constants/env.js';
import { log } from '../utils/log.js';

const _startTime = Date.now();
try {
  const input = readStdinJson<PostCompactInput>();

  // Delegate to the SHARED handler (same as the daemon route) — a second
  // standalone implementation is exactly how the daemon-vs-fallback paths
  // drift: this one updated the tracker but never recorded the report's
  // client-reported gross row (review finding).
  const client = createHookDbClient(process.env[ENV.DB_PATH] ?? undefined);
  try {
    const result = handlePostCompact(input, client);
    recordTelemetry('postcompact', input.trigger ?? 'auto', _startTime, true, undefined, {
      tokensSaved: result.tokensSaved,
      sessionId: input.session_id,
    }, client.db);
  } finally {
    client.close();
  }
} catch (err) {
  recordTelemetry('postcompact', 'error', _startTime, false, String(err));
  log.error('PostCompact hook error:', err);
  process.exit(0);
}
