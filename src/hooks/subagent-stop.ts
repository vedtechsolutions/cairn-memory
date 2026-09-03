#!/usr/bin/env node
/**
 * SubagentStop hook — capture subagent outcomes as progress notes on the
 * active plan step. The entry point owns stdin, the DB client and telemetry;
 * the business logic lives in handlers/subagent-stop-handler.ts (the daemon
 * route runs the same handler in-process, so both paths dedup identically).
 */
import { readStdinJson, type SubagentStopInput } from './shared/hook-io.js';
import { createHookDbClient } from './shared/db-client.js';
import { handleSubagentStop, hasSubagentSummary } from './handlers/subagent-stop-handler.js';
import { recordTelemetry } from './shared/hook-telemetry.js';
import { ENV } from '../constants/env.js';

const _startTime = Date.now();
try {
  const input = readStdinJson<SubagentStopInput>();
  if (!hasSubagentSummary(input)) process.exit(0);

  const client = createHookDbClient(process.env[ENV.DB_PATH] ?? undefined);
  try {
    handleSubagentStop(input, client);
  } finally {
    client.close();
  }
  recordTelemetry('subagent-stop', input.agent_type ?? 'unknown', _startTime, true);
} catch (err) {
  recordTelemetry('subagent-stop', 'error', _startTime, false, String(err));
  process.exit(0);
}
