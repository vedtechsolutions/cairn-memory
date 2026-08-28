#!/usr/bin/env node
/**
 * Stop hook — end-of-turn decision mining.
 * Scans last_assistant_message for undocumented decisions.
 * Non-blocking: decision: "block" is NOT used — advisory only.
 */
import { readStdinJson, type StopInput } from './shared/hook-io.js';
import { originClientOf } from './shared/client-adapter.js';
import { createHookDbClient } from './shared/db-client.js';
import { projectId } from '../utils/project-id.js';
import { extractAssistantDecision } from './shared/transcript-parser.js';
import { CONFIDENCE } from '../constants/index.js';
import { recordTelemetry } from './shared/hook-telemetry.js';
import { isSystemContent } from '../utils/validation.js';
import { evaluateShadowStopFailOpen } from '../governance/shadow-stop.js';

const _startTime = Date.now();
async function main(): Promise<void> {
  const input = readStdinJson<StopInput>();
  const dbPath = process.env.CAIRN_DB_PATH ?? undefined;
  const client = createHookDbClient(dbPath);
  try {
    await evaluateShadowStopFailOpen(client.db, {
      session_id: input.session_id, cwd: input.cwd, stop_hook_active: input.stop_hook_active,
      client_name: input.client_name, client_version: input.client_version,
      client_installation_id: input.client_installation_id,
      client_metadata: input.client_metadata,
    });
    const message = input.last_assistant_message;
    if (!message || message.length < 50) return;

    // Extract decisions from assistant message (reject system content leaks)
    const decision = extractAssistantDecision(message);
    if (!decision || isSystemContent(decision)) {
      recordTelemetry('stop', 'no-decision', _startTime, true);
      return;
    }

    const result = client.memoryRepo.storeDecision({
      content: decision, project: projectId(input.cwd), source: 'learned',
      confidence: CONFIDENCE.AUTO_DETECTED,
      originClient: originClientOf(input),
    });
    recordTelemetry(
      'stop', result.deduplicated ? 'decision-deduped' : 'decision-mined', _startTime, true,
    );
  } finally {
    client.close();
  }
}

try {
  await main();
} catch (err) {
  recordTelemetry('stop', 'error', _startTime, false, String(err));
}
