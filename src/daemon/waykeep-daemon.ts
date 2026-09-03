#!/usr/bin/env node
/**
 * waykeep-daemon — standalone owner of the shared hook socket.
 *
 * One instance per machine (systemd unit: deploy/waykeep-daemon.service)
 * serves ~/.waykeep/hook-daemon.sock permanently, so every agent client on
 * the host (Claude Code, Codex, future MCP consumers) shares one warm hook
 * pipeline regardless of session churn. Client MCP servers detect the live
 * daemon through the cooperative claim protocol (socket-ownership.ts) and
 * never embed their own socket while it runs; without the daemon the first
 * client to start embeds, exactly as before.
 *
 * Runs the same route table as the embedded socket, minus MCP host-side
 * sampling (no client transport here) — sampling-backed features like the
 * stop-handler's Layer 1c reflection use their documented fallbacks.
 */
import type { Server as HttpServer } from 'node:http';
import { createHookDbClient } from '../hooks/shared/db-client.js';
import { SessionCache } from '../hooks/shared/session-cache.js';
import { startHookSocket } from '../mcp/hook-socket.js';
import { ADAPTER_WORKERS } from '../adapters/workers.js';
import { ensureWaykeepDirSecure, isOwnerOnly } from '../mcp/socket-ownership.js';
import { assertManifestPinned } from '../utils/artifact-verification.js';
import { warmupEmbeddings, getEmbeddingModelConfig } from '../utils/embeddings.js';
import { isRerankEnabled, resolveRerankerModel, warmupReranker } from '../utils/reranker.js';
import { ENV } from '../constants/env.js';
import { log } from '../utils/log.js';
import { DAEMON } from '../constants/index.js';
const daemonLog = log.child('daemon');

const DB_PATH = process.env[ENV.DB_PATH] ?? undefined;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  // Same fail-closed model-config gate as the MCP server: configuration
  // errors terminate before the database opens or any side effect runs.
  assertManifestPinned(getEmbeddingModelConfig(), 'embedding');
  if (isRerankEnabled()) assertManifestPinned(resolveRerankerModel(), 'reranker');

  // Fail-closed: the daemon's whole job is to serve a same-uid-only socket. If
  // ~/.waykeep cannot be secured to owner-only, refuse to start so the
  // misconfiguration surfaces instead of spinning in the claim loop or serving
  // an exposed socket. Exit 1 pairs with RestartPreventExitStatus=1 in
  // deploy/waykeep-daemon.service so systemd marks the unit `failed` rather than
  // relaunching every RestartSec forever.
  const dir = ensureWaykeepDirSecure();
  if (!isOwnerOnly(dir, { followSymlink: true })) {
    daemonLog.error(`Fatal: ${dir} is not owner-only (uid/mode) — refusing to serve. Fix ownership/permissions and restart.`);
    process.exit(1);
  }

  const client = createHookDbClient(DB_PATH);
  const cache = new SessionCache();
  warmupEmbeddings();
  if (isRerankEnabled()) warmupReranker();

  let server: HttpServer | null = null;
  while (server === null) {
    server = await startHookSocket(client, cache, undefined, { mode: 'standalone' });
    if (server === null) {
      daemonLog.info(`Socket owned by another process — retrying in ${DAEMON.CLAIM_RETRY_INTERVAL_MS / 1000}s`);
      await delay(DAEMON.CLAIM_RETRY_INTERVAL_MS);
    }
  }
  const httpServer = server;

  // Adapter daemon workers (currently: the Codex rollout tailer — capture
  // fallback for sessions with untrusted or disabled hooks, naturally
  // quiescent while hooks are live via seen-marker dedup). Standalone
  // daemon only; WAYKEEP_TAILER=0 disables all adapter workers.
  const workers: { name: string; handle: { stop(): void } }[] = [];
  if (process.env[ENV.TAILER] !== '0') {
    for (const set of ADAPTER_WORKERS) {
      for (const start of set.workers) {
        workers.push({ name: set.name, handle: start({ ...client, cache }) });
      }
    }
  }
  for (const worker of workers) daemonLog.info(`${worker.name} adapter worker started`);

  // Graceful shutdown so the process 'exit' cleanup (tracker flush + claim
  // release) actually runs — a default signal death would skip it.
  const shutdown = (signal: NodeJS.Signals): void => {
    daemonLog.info(`${signal} received — shutting down`);
    for (const worker of workers) worker.handle.stop();
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), DAEMON.SHUTDOWN_GRACE_MS).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error) => {
  daemonLog.error('Fatal:', error);
  process.exit(1);
});
