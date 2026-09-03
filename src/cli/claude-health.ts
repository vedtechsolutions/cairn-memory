/**
 * `waykeep doctor`'s Claude Code wiring check. The MCP server must be
 * registered at user scope (or come from the plugin); an `mcpServers`
 * block in settings.json is inert — exactly what a pre-fix `waykeep init`
 * wrote while reporting success, and what this check exists to catch.
 * Diagnostic only: reads both files, edits nothing.
 */
import { existsSync, readFileSync } from 'node:fs';
import { NAMESPACE } from 'waykeep-contract';
import { MCP_SERVER_NAME } from '../constants/mcp.js';
import { claudeConfigPath, claudeSettingsPath, readClaudeUserMcpServers } from './claude-mcp.js';
import { describeServerEntry, looksLikeWaykeepServer, referencesServer, serverArgs } from './mcp-entry.js';
import { canonicalPath } from '../utils/fs-paths.js';

export interface ClaudeHealth { status: 'ok' | 'warn'; detail: string }

/** What the check needs from settings.json: is our plugin enabled, and does
 *  an inert mcpServers block linger. An unreadable file yields neither —
 *  init reports that problem itself. */
function readSettingsFacts(path: string): { pluginEnabled: boolean; inertBlock: boolean } {
  const none = { pluginEnabled: false, inertBlock: false };
  if (!existsSync(path)) return none;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as
      { enabledPlugins?: Record<string, unknown>; mcpServers?: Record<string, unknown> } | null;
    if (!parsed || typeof parsed !== 'object') return none;
    // Plugin keys are `<plugin>@<marketplace>`; ours is named after the namespace.
    const pluginEnabled = Object.entries(parsed.enabledPlugins ?? {})
      .some(([key, on]) => key.split('@')[0] === NAMESPACE && on === true);
    return { pluginEnabled, inertBlock: looksLikeWaykeepServer(parsed.mcpServers?.[MCP_SERVER_NAME]) };
  } catch {
    return none;
  }
}

export function claudeMcpHealth(serverPath: string): ClaudeHealth {
  const registry = claudeConfigPath();
  const settings = claudeSettingsPath();
  if (!existsSync(registry) && !existsSync(settings)) {
    return { status: 'ok', detail: 'Claude Code not detected (nothing to wire)' };
  }
  const read = readClaudeUserMcpServers(registry);
  if ('error' in read) {
    return { status: 'warn', detail: `${registry} could not be read (${read.error}) — Claude Code's own config; fix it, then re-run \`waykeep init\`` };
  }
  const facts = readSettingsFacts(settings);
  const inert = facts.inertBlock
    ? `; settings.json still carries an inert mcpServers.${MCP_SERVER_NAME} block Claude Code ignores — re-run \`waykeep init\` to sweep it`
    : '';
  const entry = read.servers[MCP_SERVER_NAME];
  if (entry !== undefined) {
    const ours = referencesServer(entry, serverPath) || serverArgs(entry).some(a => canonicalPath(a) === canonicalPath(serverPath));
    if (ours) {
      return { status: facts.inertBlock ? 'warn' : 'ok', detail: `MCP server registered with Claude Code at user scope for this install${inert}` };
    }
    if (looksLikeWaykeepServer(entry)) {
      return { status: 'warn', detail: `Claude Code's user-scope ${MCP_SERVER_NAME} entry runs a DIFFERENT install (${describeServerEntry(entry)}) than this one — re-run \`waykeep init\` from the install you want${inert}` };
    }
    return { status: 'warn', detail: `Claude Code's user-scope ${MCP_SERVER_NAME} entry is not a Waykeep server (${describeServerEntry(entry)}) — re-run \`waykeep init\`${inert}` };
  }
  if (facts.pluginEnabled) {
    return { status: facts.inertBlock ? 'warn' : 'ok', detail: `MCP server plugin-managed (${NAMESPACE} plugin enabled; no user-scope entry — expected)${inert}` };
  }
  return { status: 'warn', detail: `MCP server NOT registered with Claude Code (no user-scope ${MCP_SERVER_NAME} entry in ${registry}, ${NAMESPACE} plugin not enabled) — run \`waykeep init\`${inert}` };
}
