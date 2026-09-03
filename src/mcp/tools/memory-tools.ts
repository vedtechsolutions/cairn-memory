/**
 * The memory tools: one registrar per tool group, composed here. The
 * signature is the one the server and the tests always called; the deps
 * object is what the groups share.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { MemoryRepository } from '../../db/memory-repository.js';
import type { EdgeRepository } from '../../db/edge-repository.js';
import type { SessionCache } from '../../hooks/shared/session-cache.js';
import type { ContextRepository } from '../../db/context-repository.js';
import { isRerankEnabled, rerank } from '../../utils/reranker.js';
import type { ContextModeFn, RerankerImpl } from './memory-tool-deps.js';
import { registerRecallTool } from './recall-tool.js';
import { registerLearnTool } from './learn-tool.js';
import { registerCurationTools } from './curation-tools.js';
import { registerExpandTool } from './expand-tool.js';
import { registerCleanupTool } from './cleanup-tool.js';

export type { RerankerImpl } from './memory-tool-deps.js';

export function registerMemoryTools(
  server: McpServer,
  repo: MemoryRepository,
  getMode: ContextModeFn,
  innerServer?: Server,
  edgeRepo?: EdgeRepository,
  sessionCache?: SessionCache,
  rerankerImpl: RerankerImpl = { isEnabled: isRerankEnabled, rerank },
  contextRepo?: ContextRepository,
): void {
  const deps = { server, repo, getMode, innerServer, edgeRepo, sessionCache, rerankerImpl, contextRepo };
  registerRecallTool(deps);
  registerLearnTool(deps);
  registerCurationTools(deps);
  registerExpandTool(deps);
  registerCleanupTool(deps);
}
