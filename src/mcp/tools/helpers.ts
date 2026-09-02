import { MCP_SERVER_NAME } from '../../constants/mcp.js';
/**
 * Shared helpers for MCP tool handlers.
 */
import type { ContextMode } from '../../constants/index.js';

const CRITICAL_RESPONSE = {
  content: [{ type: 'text' as const, text: `[${MCP_SERVER_NAME} silent — context critical]` }],
};

/** Returns the standard critical-mode response if mode is critical, null otherwise. */
export function isCritical(mode: ContextMode): typeof CRITICAL_RESPONSE | null {
  return mode === 'critical' ? CRITICAL_RESPONSE : null;
}


import type { McpServer, ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ZodRawShapeCompat, AnySchema } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { LEGACY_NAMESPACES, MCP_TOOL_PREFIX } from 'waykeep-contract';
import { legacyCompatActive } from '../../constants/paths.js';

/**
 * Phase-B transitional tool registration: on an UN-MIGRATED legacy state
 * root, every tool is also registered under its legacy-prefixed name
 * (`cairn_*`), delegating to the same handler — old prompts, rules files
 * and configs keep working through the cutover window. The aliases vanish
 * on the NEXT server start after the migration marker lands (the root is
 * memoized per process), so they cost tokens only while needed. B2 must
 * trigger that restart explicitly.
 * Removed entirely with the legacy namespace at Phase D.
 */
export function registerToolCompat<
  OutputArgs extends ZodRawShapeCompat | AnySchema,
  InputArgs extends undefined | ZodRawShapeCompat | AnySchema = undefined,
>(
  server: McpServer,
  name: string,
  config: {
    title?: string;
    description?: string;
    inputSchema?: InputArgs;
    outputSchema?: OutputArgs;
    annotations?: ToolAnnotations;
    _meta?: Record<string, unknown>;
  },
  cb: ToolCallback<InputArgs>,
): void {
  server.registerTool(name, config, cb);
  if (!legacyCompatActive()) return;
  for (const ns of LEGACY_NAMESPACES) {
    if (!name.startsWith(MCP_TOOL_PREFIX)) continue;
    const legacyName = `${ns}_${name.slice(MCP_TOOL_PREFIX.length)}`;
    server.registerTool(legacyName, {
      ...config,
      description: `[deprecated alias of ${name} — migration pending] ${config.description ?? ''}`.trim(),
    }, cb);
  }
}
