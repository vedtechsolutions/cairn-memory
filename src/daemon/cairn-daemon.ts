#!/usr/bin/env node
/**
 * cairn-daemon — standalone owner of the shared hook socket.
 *
 * One instance per machine (systemd unit: deploy/cairn-daemon.service)
 * serves ~/.cairn/hook-daemon.sock permanently, so every agent client on
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
import { ADAPTER_LIFECYCLES } from '../adapters/index.js';
import { ensureCairnDirSecure, isOwnerOnly } from '../mcp/socket-ownership.js';
import { assertManifestPinned } from '../utils/artifact-verification.js';
import { warmupEmbeddings, getEmbeddingModelConfig } from '../utils/embeddings.js';
import { isRerankEnabled, resolveRerankerModel, warmupReranker } from '../utils/reranker.js';

const DB_PATH = process.env.CAIRN_DB_PATH ?? undefined;
/** Retry cadence while a legacy embedded owner still holds the socket; the
 *  daemon waits for it to exit rather than displacing it. */
const CLAIM_RETRY_INTERVAL_MS = 10_000;
/** Grace period for in-flight hook requests after a shutdown signal. */
const SHUTDOWN_GRACE_MS = 3_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  // Same fail-closed model-config gate as the MCP server: configuration
  // errors terminate before the database opens or any side effect runs.
  assertManifestPinned(getEmbeddingModelConfig(), 'embedding');
  if (isRerankEnabled()) assertManifestPinned(resolveRerankerModel(), 'reranker');

  // Fail-closed: the daemon's whole job is to serve a same-uid-only socket. If
  // ~/.cairn cannot be secured to owner-only, refuse to start so the
  // misconfiguration surfaces instead of spinning in the claim loop or serving
  // an exposed socket. Exit 1 pairs with RestartPreventExitStatus=1 in
  // deploy/cairn-daemon.service so systemd marks the unit `failed` rather than
  // relaunching every RestartSec forever.
  const dir = ensureCairnDirSecure();
  if (!isOwnerOnly(dir, { followSymlink: true })) {
    console.error(
      `[cairn-daemon] Fatal: ${dir} is not owner-only (uid/mode) — refusing to serve. Fix ownership/permissions and restart.`,
    );
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
      console.error(
        `[cairn-daemon] Socket owned by another process — retrying in ${CLAIM_RETRY_INTERVAL_MS / 1000}s`,
      );
      await delay(CLAIM_RETRY_INTERVAL_MS);
    }
  }
  const httpServer = server;

  // Adapter daemon workers (currently: the Codex rollout tailer — capture
  // fallback for sessions with untrusted or disabled hooks, naturally
  // quiescent while hooks are live via seen-marker dedup). Standalone
  // daemon only; CAIRN_TAILER=0 disables all adapter workers.
  const workers: { name: string; handle: { stop(): void } }[] = [];
  if (process.env.CAIRN_TAILER !== '0') {
    for (const lifecycle of ADAPTER_LIFECYCLES) {
      for (const start of lifecycle.daemonWorkers ?? []) {
        workers.push({ name: lifecycle.name, handle: start({ ...client, cache }) });
      }
    }
  }
  for (const worker of workers) console.error(`[cairn] ${worker.name} adapter worker started`);

  // Graceful shutdown so the process 'exit' cleanup (tracker flush + claim
  // release) actually runs — a default signal death would skip it.
  const shutdown = (signal: NodeJS.Signals): void => {
    console.error(`[cairn-daemon] ${signal} received — shutting down`);
    for (const worker of workers) worker.handle.stop();
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error) => {
  console.error('[cairn-daemon] Fatal:', error);
  process.exit(1);
});
