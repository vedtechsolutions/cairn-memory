#!/usr/bin/env node
/**
 * PostToolUse hook — success tracker for implicit feedback (async: true).
 * The entry point owns stdin, the DB client, the tracker file lock and
 * telemetry; the tracking itself is handlers/success-tracker-handler.ts's
 * trackSuccess, which the daemon route runs on its cached tracker. Running
 * it under updateTracker keeps the direct-node path's locked
 * read-modify-write, so concurrent hook processes never lose an update.
 */
import { readStdinJson, type PostToolUseInput } from './shared/hook-io.js';
import { createHookDbClient, type HookDbClient } from './shared/db-client.js';
import { updateTracker } from './shared/edit-tracker.js';
import {
  isGovernanceObservedTool,
  isSuccessTrackedTool,
  trackSuccess,
} from './handlers/success-tracker-handler.js';
import { recordGovernanceEventFailOpen } from '../governance/recorder.js';
import { recordTelemetry } from './shared/hook-telemetry.js';
import { ENV } from '../constants/env.js';
import { log } from '../utils/log.js';

const _startTime = Date.now();
try {
  const input = readStdinJson<PostToolUseInput>();
  if (!isSuccessTrackedTool(input.tool_name)) process.exit(0);

  // The tracker file is the one piece that must work without the database
  // (it feeds pitfall surfacing, the resume cursor and SessionEnd), so a
  // database that will not open degrades the tracking, never loses it.
  let client: HookDbClient | null = null;
  try {
    client = createHookDbClient(process.env[ENV.DB_PATH] ?? undefined);
  } catch (err) {
    log.debug('success-tracker: database unavailable, tracking without it:', err);
  }
  try {
    updateTracker(input.session_id, tracker => { trackSuccess(input, client, tracker); });
    // Governance is a post-business-result tee. Its failures are deliberately
    // invisible to the existing hook output and telemetry behavior.
    if (client && isGovernanceObservedTool(input.tool_name)) {
      try {
        await recordGovernanceEventFailOpen(client.db, input);
      } catch { /* fail open */ }
    }
  } finally {
    client?.close();
  }
  recordTelemetry('success-tracker', input.tool_name, _startTime, true);
} catch (err) {
  recordTelemetry('success-tracker', 'error', _startTime, false, String(err));
  log.error('Success tracker hook error:', err);
  process.exit(0);
}
