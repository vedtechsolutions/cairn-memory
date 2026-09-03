#!/usr/bin/env node
/**
 * SessionEnd hook — clean exit with state persistence + session quality signal.
 * The entry point owns stdin, the DB client and telemetry; the stages live in
 * handlers/session-end-handler.ts and shared/session-end/.
 */
import { readStdinJson, type SessionEndInput } from './shared/hook-io.js';
import { createHookDbClient } from './shared/db-client.js';
import { handleSessionEnd } from './handlers/session-end-handler.js';
import { recordTelemetry } from './shared/hook-telemetry.js';
import { ENV } from '../constants/env.js';
import { log } from '../utils/log.js';

export type { SessionQuality } from './shared/session-end/session-quality.js';

const _startTime = Date.now();
try {
  const input = readStdinJson<SessionEndInput>();
  const client = createHookDbClient(process.env[ENV.DB_PATH] ?? undefined);
  try {
    handleSessionEnd(input, client);
  } finally {
    client.close();
  }
  recordTelemetry('session-end', input.reason, _startTime, true);
} catch (err) {
  recordTelemetry('session-end', 'error', _startTime, false, String(err));
  log.error('SessionEnd hook error:', err);
  process.exit(0);
}
