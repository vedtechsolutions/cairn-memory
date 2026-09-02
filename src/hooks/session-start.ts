#!/usr/bin/env node
/**
 * SessionStart hook — thin wrapper around the session-start handler.
 * Matchers: startup, compact, resume, clear
 * Outputs briefing to stdout → injected into Claude's context.
 * NOT async — must complete before Claude starts processing.
 *
 * This wrapper is the fallback path when the embedded hook socket is not
 * reachable (cold boot, before the MCP server has started). The relay
 * binary (hook-relay.c exec_fallback) invokes this file directly via node
 * when the socket check fails. When the socket IS reachable, the relay
 * posts to the daemon's /session-start route and receives the briefing
 * text back.
 *
 * GAP H (verified, not fixed): the standalone path intentionally does NOT
 * use SessionCache. The cache lives in the MCP server process and is not
 * reachable from a separate node process; even if we instantiated one here
 * it would be empty on cold boot (the only time this path runs), so there
 * is no cache to share. File I/O for the tracker in this case is the
 * correct behavior, not a bug.
 */
import { readStdinJson, type SessionStartInput } from './shared/hook-io.js';
import { createHookDbClient } from './shared/db-client.js';
import { handleSessionStart } from './handlers/session-start-handler.js';
import { recordTelemetry } from './shared/hook-telemetry.js';
import { appendFileSync } from 'node:fs';
import { ENV } from '../constants/env.js';

const _startTime = Date.now();
const _diagLog = (msg: string) => {
  try { appendFileSync('/tmp/cairn-session-start-diag.log', `[${new Date().toISOString()}] ${msg}\n`); } catch {}
};

try {
  const input = readStdinJson<SessionStartInput>();
  const dbPath = process.env[ENV.DB_PATH] ?? undefined;
  const client = createHookDbClient(dbPath);

  const result = handleSessionStart(input, client);

  _diagLog(`type=${(input as unknown as {type?: string}).type}→${result.sessionType} tokens=${result.tokenEstimate} ${Date.now() - _startTime}ms`);
  process.stdout.write(result.output);

  client.close();
  recordTelemetry('session-start', result.sessionType, _startTime, true, undefined, {
    tokenEstimate: result.tokenEstimate,
    interrupted: result.interrupted,
  });
} catch (err) {
  _diagLog(`ERROR: ${String(err)}`);
  recordTelemetry('session-start', 'error', _startTime, false, String(err));
  console.error('[cairn] SessionStart hook error:', err);
  process.exit(0);
}
