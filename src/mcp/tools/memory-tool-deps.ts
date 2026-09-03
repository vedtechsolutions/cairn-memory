/**
 * What every memory tool registrar receives: the server, the repositories,
 * the context-mode probe and the optional seams. One object instead of the
 * eight positional parameters the single registrar used to close over.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { MemoryRepository } from '../../db/memory-repository.js';
import type { EdgeRepository } from '../../db/edge-repository.js';
import type { ContextRepository } from '../../db/context-repository.js';
import type { SessionCache } from '../../hooks/shared/session-cache.js';
import type { ContextMode } from '../../constants/index.js';
import type { rerank } from '../../utils/reranker.js';

export type ContextModeFn = () => ContextMode;

/** Injectable rerank seam — production uses the real reranker module;
 *  MCP-level tests inject fakes to prove reorder, fallback labeling, and
 *  recall-count semantics without model downloads. */
export interface RerankerImpl {
  isEnabled: () => boolean;
  rerank: typeof rerank;
}

export interface MemoryToolDeps {
  server: McpServer;
  repo: MemoryRepository;
  getMode: ContextModeFn;
  innerServer?: Server;
  edgeRepo?: EdgeRepository;
  sessionCache?: SessionCache;
  rerankerImpl: RerankerImpl;
  contextRepo?: ContextRepository;
}

/**
 * Bump the session cache memory version if one is provided. Called after any
 * successful write path (create, update, invalidate, delete, strengthen, weaken,
 * cleanup). The bump invalidates every skip-gate entry so the next hook call
 * sees the new memory state — giving corrections a staleness bound of zero.
 * No-op when the cache is absent (e.g. in standalone tests).
 */
export function bumpCache(cache: SessionCache | undefined): void {
  cache?.bumpMemoryVersion();
}
