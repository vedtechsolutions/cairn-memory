#!/usr/bin/env node
/**
 * SubagentStart hook — thin wrapper around the subagent-context handler.
 * Subagents start with no Waykeep context (no SessionStart briefing); the
 * handler provides a concise summary: plan state + top pitfalls +
 * corrections. async: false — context must be injected before the
 * subagent processes.
 *
 * Fallback path only (daemon socket unreachable). Delegates to the same
 * handler the daemon route uses so cross-agent framing and render-time
 * neutralization can never drift between the two paths again — they did
 * once, in both directions.
 */
import { readStdinJson, type SubagentStartInput } from './shared/hook-io.js';
import { createHookDbClient } from './shared/db-client.js';
import { handleSubagentContext } from './handlers/subagent-context-handler.js';
import { recordTelemetry } from './shared/hook-telemetry.js';
import { ENV } from '../constants/env.js';

const _startTime = Date.now();
try {
  const input = readStdinJson<SubagentStartInput>();
  const dbPath = process.env[ENV.DB_PATH] ?? undefined;
  const client = createHookDbClient(dbPath);

  const result = handleSubagentContext(input, client);
  if (result.output) {
    process.stdout.write(result.output);
  }

  client.close();
  recordTelemetry('subagent-context', input.agent_type ?? 'unknown', _startTime, true, undefined, {
    hasPlan: result.hasPlan,
    pitfalls: result.pitfalls,
    corrections: result.corrections,
  });
} catch (err) {
  recordTelemetry('subagent-context', 'error', _startTime, false, String(err));
  console.error('[cairn] SubagentStart hook error:', err);
  process.exit(0);
}
