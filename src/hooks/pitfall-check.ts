#!/usr/bin/env node
/**
 * PreToolUse hook — proactive pre-tool warnings.
 * Fires before Write/Edit/MultiEdit/Bash/Read tool calls.
 *
 * Business logic lives in handlers/pitfall-handler.ts.
 * This file is the entry point: reads stdin, calls handler, writes stdout.
 * Used as fallback when the hook daemon is unavailable.
 */
import { readStdinJson, type PreToolUseInput } from './shared/hook-io.js';
import { createHookDbClient } from './shared/db-client.js';
import { recordTelemetry } from './shared/hook-telemetry.js';
import { handlePitfallCheck } from './handlers/pitfall-handler.js';
import { ENV } from '../constants/env.js';

const _startTime = Date.now();
try {
  const input = readStdinJson<PreToolUseInput>();
  const dbPath = process.env[ENV.DB_PATH] ?? undefined;
  const client = createHookDbClient(dbPath);

  const result = handlePitfallCheck(input, client);

  if (result.output) {
    process.stdout.write(result.output);
  }

  recordTelemetry('pitfall-check', input.tool_name, _startTime, true, undefined, {
    pitfallsSurfaced: result.pitfallsSurfaced,
  }, client.db);
  client.close();
} catch (err) {
  recordTelemetry('pitfall-check', 'error', _startTime, false, String(err));
  console.error('[cairn] Pitfall check hook error:', err);
  process.exit(0);
}
