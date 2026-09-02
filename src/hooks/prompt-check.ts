#!/usr/bin/env node
/**
 * UserPromptSubmit hook — intent classification, correction detection,
 * decision detection, pitfall/fact/decision injection.
 *
 * Business logic lives in handlers/prompt-handler.ts.
 * This file is the entry point: reads stdin, calls handler, writes stdout.
 * Used as fallback when the hook daemon is unavailable.
 */
import { readStdinJson, type UserPromptSubmitInput } from './shared/hook-io.js';
import { createHookDbClient } from './shared/db-client.js';
import { recordTelemetry } from './shared/hook-telemetry.js';
import { handlePromptCheck } from './handlers/prompt-handler.js';
import { ENV } from '../constants/env.js';

const _startTime = Date.now();
try {
  const input = readStdinJson<UserPromptSubmitInput>();
  const dbPath = process.env[ENV.DB_PATH] ?? undefined;
  const client = createHookDbClient(dbPath);

  const result = handlePromptCheck(input, client);

  if (result.output) {
    process.stdout.write(result.output);
  }

  client.close();
  recordTelemetry('prompt-check', result.intent, _startTime, true, undefined, {
    injections: result.injections,
  });
} catch (err) {
  recordTelemetry('prompt-check', 'error', _startTime, false, String(err));
  console.error('[waykeep] Prompt check hook error:', err);
  process.exit(0);
}
