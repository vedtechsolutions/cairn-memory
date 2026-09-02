/**
 * The MCP surface Waykeep exposes: server name, tool names, resource URIs.
 *
 * All three derive from the contract's `NAMESPACE`, so the v6.0.0 rename
 * reaches them without editing a registration site. These are the most
 * externally-visible identifiers the product has — the server name is
 * written into other tools' configuration files, and the tool names appear
 * in every agent's prompt — so none of them may be spelled inline.
 */

import { MCP_SERVER_NAME, MCP_URI_SCHEME, toolName } from 'waykeep-contract';

export { MCP_SERVER_NAME, MCP_URI_SCHEME };

/**
 * Every tool the MCP server registers, keyed by its bare verb.
 * The key is the stable internal handle; the value is what clients call.
 */
export const TOOL = {
  RECALL: toolName('recall'),
  LEARN: toolName('learn'),
  CORRECT: toolName('correct'),
  FORGET: toolName('forget'),
  STRENGTHEN: toolName('strengthen'),
  WEAKEN: toolName('weaken'),
  EXPAND: toolName('expand'),
  CLEANUP: toolName('cleanup'),
  PLAN: toolName('plan'),
  REMIND: toolName('remind'),
  REMINDER_LIST: toolName('reminder_list'),
  REMINDER_DELETE: toolName('reminder_delete'),
  INGEST: toolName('ingest'),
  EXPORT: toolName('export'),
  PROMOTE: toolName('promote'),
  STATS: toolName('stats'),
  GOVERNANCE_OVERRIDE: toolName('governance_override'),
} as const;

/** Every tool name the server registers — for the guard test. */
export const ALL_TOOL_NAMES: readonly string[] = Object.values(TOOL);

/**
 * A tool name as an MCP CLIENT sees it: `mcp__<server>__<tool>`.
 *
 * Transcript scanning matches on this form to tell whether the agent called
 * one of our tools. It embeds the server name as well as the tool name, so
 * it must be built here rather than written out — a stale copy would make
 * hook detection silently stop firing after a rename.
 */
export function qualifiedToolName(tool: string): string {
  return `mcp__${MCP_SERVER_NAME}__${tool}`;
}

/** Resource URI templates. `{project}` is filled by the MCP router. */
export const RESOURCE_URI = {
  ACTIVE_PLAN: `${MCP_URI_SCHEME}://plan/{project}/active`,
  FULL_BRIEFING: `${MCP_URI_SCHEME}://briefing/{project}`,
} as const;
