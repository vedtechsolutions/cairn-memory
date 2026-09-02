#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { openDatabase } from '../db/connection.js';
import { MemoryRepository } from '../db/memory-repository.js';
import { PlanRepository } from '../db/plan-repository.js';
import { ReminderRepository } from '../db/reminder-repository.js';
import { EdgeRepository } from '../db/edge-repository.js';
import { ContextRepository } from '../db/context-repository.js';
import { InvestigationRepository } from '../db/investigation-repository.js';
import { registerMemoryTools } from './tools/memory-tools.js';
import { registerPlanTool } from './tools/plan-tool.js';
import { registerReminderTools } from './tools/reminder-tools.js';
import { registerPortabilityTools } from './tools/portability-tools.js';
import { registerStatsTools } from './tools/stats-tool.js';
import { registerGovernanceTools } from './tools/governance-tools.js';
import { registerResources } from './resources.js';
import { readState } from '../hooks/shared/state-io.js';
import { VERSION, EMBEDDING_BACKFILL, type ContextMode } from '../constants/index.js';
import { assertManifestPinned } from '../utils/artifact-verification.js';
import { warmupEmbeddings, isEmbeddingReady, embed, embeddingToBuffer, getEmbeddingModelConfig } from '../utils/embeddings.js';
import { isRerankEnabled, resolveRerankerModel, warmupReranker } from '../utils/reranker.js';
import { startContextVectorWorker } from './context-vector-worker.js';
import { startHookSocket } from './hook-socket.js';
import { postMemoryBumpToOwner } from './socket-ownership.js';
import { SessionCache } from '../hooks/shared/session-cache.js';
import { ENV } from '../constants/env.js';
import { MCP_SERVER_NAME } from '../constants/mcp.js';

const DB_PATH = process.env[ENV.DB_PATH] ?? undefined;
const VERBOSE = process.env[ENV.VERBOSE] === '1';

async function main(): Promise<void> {
  // Resolve AND pin-gate the model configs SYNCHRONOUSLY before anything
  // starts — the lazy warmup path swallows rejections (by design: TRANSIENT
  // download failures for a pinned model degrade to FTS-only and retry),
  // which would leave a misconfigured server silently alive. Unknown model
  // keys and unpinned manifests are CONFIGURATION errors, not transient
  // conditions: fail closed via the fatal handler (exit 1) before the
  // database opens, models import, or any other side effect runs.
  assertManifestPinned(getEmbeddingModelConfig(), 'embedding');
  // Same fail-closed rule for the opt-in reranker: invalid WAYKEEP_RERANK
  // values, unknown model keys, and unpinned manifests must terminate, not
  // run half-configured.
  if (isRerankEnabled()) assertManifestPinned(resolveRerankerModel(), 'reranker');
  const db = openDatabase({ dbPath: DB_PATH, verbose: VERBOSE });
  const memoryRepo = new MemoryRepository(db);
  const planRepo = new PlanRepository(db);
  const reminderRepo = new ReminderRepository(db);
  const edgeRepo = new EdgeRepository(db);
  const contextRepo = new ContextRepository(db);
  const investigationRepo = new InvestigationRepository(db);

  // Pre-warm embedding model, then backfill existing memories without embeddings
  warmupEmbeddings();
  if (isRerankEnabled()) warmupReranker();
  runEmbeddingBackfill(memoryRepo);

  // Process pending prompt embeddings periodically (rolling context vector bridge)
  startContextVectorWorker(db);

  const server = new McpServer({
    name: MCP_SERVER_NAME,
    version: VERSION,
  });

  // Single SessionCache instance — shared between MCP tool handlers (for
  // skip-gate version bumping on writes) and the embedded hook socket
  // (for hot-path reads). In-process sharing gives skip-gate invalidation
  // a staleness bound of zero with no IPC cost.
  const sessionCache = new SessionCache();

  // The ONE reader of the StatusLine state file: validated (a forged
  // `mode: "critical"` must not silence memory tooling — L1), staleness-
  // bounded, and honoring the WAYKEEP_STATE_PATH override. An MCP-local copy
  // once skipped all three (audit).
  const getContextMode = (): ContextMode => readState().mode;

  // contextRepo (last arg) lets waykeep_recall build a project query fingerprint
  // for the cross-project guard; undefined keeps the default reranker.
  registerMemoryTools(server, memoryRepo, getContextMode, server.server, edgeRepo, sessionCache, undefined, contextRepo);
  registerPlanTool(server, planRepo, memoryRepo, getContextMode, sessionCache);
  registerReminderTools(server, reminderRepo, getContextMode, sessionCache);
  registerPortabilityTools(server, memoryRepo, getContextMode, sessionCache);
  registerStatsTools(server, memoryRepo, planRepo, reminderRepo, db, getContextMode);
  registerGovernanceTools(server, db, server.server);
  registerResources(server, planRepo, memoryRepo, getContextMode);

  // Start the hook socket in embedded mode — unless another process (the
  // standalone waykeep-daemon service, or a peer agent client's MCP server)
  // already serves it, in which case we share that socket cooperatively.
  //
  // When we DO own it, the shared session cache gives MCP-side memory
  // writes zero-staleness skip-gate invalidation via bumpMemoryVersion().
  // The third arg is the MCP inner Server, passed so hook handlers that
  // want host-side capabilities (sampling, elicitation) can use them —
  // the stop-handler's Layer 1c Socratic reflection consumes this.
  const hookServer = await startHookSocket({
    db,
    memoryRepo,
    planRepo,
    reminderRepo,
    contextRepo,
    investigationRepo,
    close: () => {}, // DB lifecycle managed by MCP server, not hooks
  }, sessionCache, server.server);
  if (!hookServer) {
    // Another process owns the socket: relay write-tool bumps across it so
    // corrections keep their zero staleness bound; the owner-side 60s
    // skip-gate TTL backstops any lost post.
    sessionCache.setBumpNotifier(postMemoryBumpToOwner);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Waykeep MCP server running on stdio');
}

/** Background backfill: embed existing memories that don't have embeddings yet.
 *  Runs in batches of 10, with 100ms pauses between batches to avoid blocking. */
async function runEmbeddingBackfill(repo: MemoryRepository): Promise<void> {
  // Wait for model to be ready (warmup)
  const maxWait = EMBEDDING_BACKFILL.MODEL_WARMUP_MAX_WAIT_MS;
  const start = Date.now();
  while (!isEmbeddingReady() && Date.now() - start < maxWait) {
    await new Promise(r => setTimeout(r, EMBEDDING_BACKFILL.WARMUP_POLL_MS));
  }
  if (!isEmbeddingReady()) return;

  let total = 0;

  while (true) {
    const batch = repo.memoriesWithoutEmbeddings(EMBEDDING_BACKFILL.BATCH_SIZE);
    if (batch.length === 0) break;

    for (const { id, content } of batch) {
      try {
        const emb = await embed(content);
        repo.storeEmbedding(id, embeddingToBuffer(emb));
        total++;
      } catch {
        break; // Stop on error
      }
    }

    // Pause between batches to avoid hogging CPU
    await new Promise(r => setTimeout(r, EMBEDDING_BACKFILL.BATCH_PAUSE_MS));
  }

  if (total > 0) {
    console.error(`[waykeep] Backfilled embeddings for ${total} memories`);
  }
}

main().catch((error) => {
  console.error('Fatal error in Waykeep:', error);
  process.exit(1);
});
