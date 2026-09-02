/**
 * Shared standalone-entry runner for the PostToolUse demux — the relay
 * execs dist/src/hooks/<route>.js when the daemon socket is unavailable,
 * and both route names (canonical and deprecated alias) must exist as
 * files with identical behavior. Only the telemetry name differs, so the
 * route provenance stays visible in migration analytics.
 */
import { readStdinJson, type PostToolUseInput } from './hook-io.js';
import { createHookDbClient } from './db-client.js';
import { handleCodexPostTool } from '../handlers/codex-post-tool-handler.js';
import { recordTelemetry } from './hook-telemetry.js';
import { ENV } from '../../constants/env.js';

export async function runPostToolEntry(telemetryName: string): Promise<void> {
  const startTime = Date.now();
  try {
    const input = readStdinJson<PostToolUseInput>();
    const client = createHookDbClient(process.env[ENV.DB_PATH] ?? undefined);
    try {
      const result = await handleCodexPostTool(input, client);
      recordTelemetry(telemetryName, result.action, startTime, true);
    } finally {
      client.close();
    }
  } catch (err) {
    recordTelemetry(telemetryName, 'error', startTime, false, String(err));
  }
}
