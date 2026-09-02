/**
 * Shape-level reasoning about a stdio MCP server entry, shared by the
 * settings.json sweep in `init.ts`, the `~/.claude.json` planner in
 * `claude-mcp.ts`, and the doctor check, so "does this entry launch OUR
 * server?" has one answer.
 */
import { isDeepStrictEqual } from 'node:util';
import { basename } from 'node:path';
import { LEGACY_NAMESPACES, NAMESPACE } from 'waykeep-contract';
import { ENV } from '../constants/env.js';

/** A stdio MCP server entry as Claude Code stores it. */
export interface McpServerEntry {
  type: 'stdio';
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** The entry `waykeep init` registers for THIS install: bare `node`
 *  (PATH-resolved — the form Claude Code documents for stdio servers)
 *  launching the install's server.js. */
export function waykeepMcpServerEntry(serverPath: string): McpServerEntry {
  return { type: 'stdio', command: 'node', args: [serverPath], env: { [ENV.LOG_LEVEL]: 'info' } };
}

/** The `args` strings of an entry (empty for a malformed one). */
export function serverArgs(entry: unknown): string[] {
  if (!entry || typeof entry !== 'object') return [];
  const args = (entry as { args?: unknown }).args;
  return Array.isArray(args) ? args.filter((a): a is string => typeof a === 'string') : [];
}

function serverCommand(entry: unknown): string | null {
  if (!entry || typeof entry !== 'object') return null;
  const command = (entry as { command?: unknown }).command;
  return typeof command === 'string' ? command : null;
}

const normalizePath = (p: string): string => p.replace(/\\/g, '/');

/**
 * True when an entry launches EXACTLY `serverPath` — this install's server.js.
 * This is the only case safe to auto-remove: an in-place pre-rename alias of
 * the very server being installed. A foreign server, OR the same product
 * installed at a different path, is never our exact path, so a suffix match
 * (which could delete `…/other-project/dist/src/mcp/server.js`) is unsafe
 * (codex B1 review). Windows backslashes are normalized on both sides.
 */
export function referencesServer(entry: unknown, serverPath: string): boolean {
  const target = normalizePath(serverPath);
  return serverArgs(entry).some(a => normalizePath(a) === target);
}

/** The three shapes a Waykeep server entry takes in the wild: `node
 *  …/dist/src/mcp/server.js` (what init writes), `waykeep serve` / `cairn
 *  serve` (the bin form the Codex plugin uses), and the Claude plugin's
 *  launcher `…/waykeep-mcp.sh` copied by hand. Recognizing only the first
 *  told a plugin user "no entry" while a wrapper-form one ran a second
 *  server (review). */
const SERVER_SUFFIX = '/dist/src/mcp/server.js';
const BIN_NAMES: ReadonlySet<string> = new Set([NAMESPACE, ...LEGACY_NAMESPACES]);
const PLUGIN_LAUNCHER = `${NAMESPACE}-mcp.sh`;

/** True when an entry launches SOME waykeep/cairn server (any install, any
 *  of the shapes above) — used to WARN or to sweep an inert block, never to
 *  delete a live registration. */
export function looksLikeWaykeepServer(entry: unknown): boolean {
  const args = serverArgs(entry);
  if (args.some(a => normalizePath(a).endsWith(SERVER_SUFFIX))) return true;
  const command = serverCommand(entry);
  if (command === null) return false;
  const bin = basename(normalizePath(command));
  return bin === PLUGIN_LAUNCHER || (BIN_NAMES.has(bin) && args[0] === 'serve');
}

/** True when an existing entry already equals `desired`. Claude Code writes
 *  `type: "stdio"` and omits an empty `env`/`args`, so absent fields compare
 *  as those defaults and a hand-written equivalent counts as registered. */
export function sameServerEntry(existing: unknown, desired: McpServerEntry): boolean {
  if (!existing || typeof existing !== 'object') return false;
  const e = existing as { type?: unknown; command?: unknown; args?: unknown; env?: unknown };
  const normalized = { type: e.type ?? 'stdio', command: e.command, args: e.args ?? [], env: e.env ?? {} };
  return isDeepStrictEqual(normalized, desired);
}

/** `command arg…` for a message, or a placeholder for a malformed entry. */
export function describeServerEntry(entry: unknown): string {
  const line = [serverCommand(entry) ?? '', ...serverArgs(entry)].join(' ').trim();
  return line || '(malformed entry)';
}

/**
 * Categorize stale legacy-namespace keys (e.g. `cairn`) in a server map.
 * `removed` are keys launching OUR exact server — DELETED from `servers`,
 * the pre-rename alias of this install. `suspect` are keys launching a
 * waykeep/cairn server at a DIFFERENT path (a relocated old install, OR a
 * foreign one we must not delete): left in place for the caller to report.
 * Everything else is untouched. Removed with the legacy namespace at Phase D.
 */
export function sweepLegacyMcpServers(servers: Record<string, unknown>, serverPath: string): { removed: string[]; suspect: string[] } {
  const removed: string[] = [];
  const suspect: string[] = [];
  for (const ns of LEGACY_NAMESPACES) {
    if (servers[ns] === undefined) continue;
    if (referencesServer(servers[ns], serverPath)) {
      delete servers[ns];
      removed.push(ns);
    } else if (looksLikeWaykeepServer(servers[ns])) {
      suspect.push(ns);
    }
  }
  return { removed, suspect };
}
