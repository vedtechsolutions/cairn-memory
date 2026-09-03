#!/usr/bin/env node
/**
 * PostToolUse hook for ExitPlanMode — bridges Claude Code plan mode to
 * Waykeep's persistent plan system. The entry point owns stdin/stdout, the DB
 * client and telemetry; plan discovery and creation live in
 * handlers/plan-bridge-handler.ts (the daemon route runs the same handler).
 */
import { readStdinJson, type PostToolUseInput } from './shared/hook-io.js';
import { createHookDbClient } from './shared/db-client.js';
import { handlePlanBridge } from './handlers/plan-bridge-handler.js';
import { recordTelemetry } from './shared/hook-telemetry.js';
import { ENV } from '../constants/env.js';
import { log } from '../utils/log.js';

const _startTime = Date.now();
try {
  const input = readStdinJson<PostToolUseInput>();
  if (input.tool_name !== 'ExitPlanMode') process.exit(0);

  const client = createHookDbClient(process.env[ENV.DB_PATH] ?? undefined);
  try {
    const result = handlePlanBridge(input, client);
    if (result.action === 'created') {
      // plan-bridge is a SYNC route, so this stdout IS delivered; the handler
      // already recorded the matching cost row.
      if (result.output) process.stdout.write(result.output);
      recordTelemetry('plan-bridge', 'created', _startTime, true, undefined, {
        steps: result.steps,
        plan_id: result.planId,
      });
    }
  } finally {
    client.close();
  }
} catch (err) {
  recordTelemetry('plan-bridge', 'error', _startTime, false, String(err));
  log.error('Plan bridge hook error:', err);
  process.exit(0);
}
