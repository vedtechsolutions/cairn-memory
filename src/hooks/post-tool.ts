#!/usr/bin/env node
/**
 * PostToolUse demux — standalone entry (relay fallback when the daemon
 * socket is unavailable). Thin shell over the shared handler. The
 * codex-post-tool entry is its deprecated alias (D3 migration).
 */
import { readStdinJson, type PostToolUseInput } from './shared/hook-io.js';
import { createHookDbClient } from './shared/db-client.js';
import { handleCodexPostTool } from './handlers/codex-post-tool-handler.js';
import { recordTelemetry } from './shared/hook-telemetry.js';

const _startTime = Date.now();
async function main(): Promise<void> {
  const input = readStdinJson<PostToolUseInput>();
  const client = createHookDbClient(process.env.CAIRN_DB_PATH ?? undefined);
  try {
    const result = await handleCodexPostTool(input, client);
    recordTelemetry('post-tool', result.action, _startTime, true);
  } finally {
    client.close();
  }
}

try {
  await main();
} catch (err) {
  recordTelemetry('post-tool', 'error', _startTime, false, String(err));
}
