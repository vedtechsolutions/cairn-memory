/**
 * Lightweight DB access for hooks.
 * Hooks run as separate processes and need their own DB connection.
 * Shares the same schema and DB path as the MCP server.
 */
import type Database from 'better-sqlite3';
import { openDatabase } from '../../db/connection.js';
import { MemoryRepository } from '../../db/memory-repository.js';
import { PlanRepository } from '../../db/plan-repository.js';
import { ReminderRepository } from '../../db/reminder-repository.js';
import { ContextRepository } from '../../db/context-repository.js';
import { InvestigationRepository } from '../../db/investigation-repository.js';
import type { SessionCache } from './session-cache.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';

export interface HookDbClient {
  db: Database.Database;
  memoryRepo: MemoryRepository;
  planRepo: PlanRepository;
  reminderRepo: ReminderRepository;
  contextRepo: ContextRepository;
  investigationRepo: InvestigationRepository;
  close: () => void;
}

/**
 * Extended context with optional session cache and optional MCP inner
 * server reference.
 *
 * `cache` — when running in the MCP server (via hook-socket), the cache
 * is present. When running standalone (direct node), it's undefined and
 * handlers fall back to file I/O and subprocess calls.
 *
 * `innerServer` — the MCP SDK's Server instance, used by handlers that
 * want to invoke host-side capabilities like sampling (Layer 1c
 * Socratic reflection in stop-handler) or elicitation. Only present
 * when running inside the MCP server process AND the client negotiated
 * the relevant capability. Handlers must check for undefined and fall
 * back gracefully.
 */
export interface CachedHookContext extends HookDbClient {
  cache?: SessionCache;
  innerServer?: Server;
}

export function createHookDbClient(dbPath?: string): HookDbClient {
  const db = openDatabase({ dbPath });
  return {
    db,
    memoryRepo: new MemoryRepository(db),
    planRepo: new PlanRepository(db),
    reminderRepo: new ReminderRepository(db),
    contextRepo: new ContextRepository(db),
    investigationRepo: new InvestigationRepository(db),
    close: () => db.close(),
  };
}
