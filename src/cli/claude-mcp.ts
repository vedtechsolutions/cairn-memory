/**
 * Claude Code MCP registration for `waykeep init`.
 *
 * Claude Code never reads `mcpServers` from ~/.claude/settings.json — the
 * key is inert there (that file carries MCP *policy* keys only). User-scope
 * servers live in ~/.claude.json, and the supported way to change them is
 * the `claude mcp` CLI, which validates and locks the file. So init PLANS
 * from a read-only look at ~/.claude.json and APPLIES the plan through
 * `claude mcp add-json` / `claude mcp remove` — never by editing that file,
 * which also holds Claude's own state and is rewritten by live sessions.
 * `claude mcp get`/`list` are deliberately unused: both spawn every server
 * to test its connection. When the CLI cannot be found the exact commands
 * are printed and the outcome is `pending` so init can say so last.
 */
import { spawnSync } from 'node:child_process';
import { accessSync, constants as fsConstants, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { LEGACY_NAMESPACES } from 'waykeep-contract';
import { ENV } from '../constants/env.js';
import { MCP_SERVER_NAME } from '../constants/mcp.js';
import { CLAUDE_CODE } from '../constants/claude-code.js';
import {
  type McpServerEntry, waykeepMcpServerEntry, referencesServer, looksLikeWaykeepServer,
  sameServerEntry, describeServerEntry,
} from './mcp-entry.js';
import { shellQuote } from '../utils/shell.js';
import { isPlainObject } from '../utils/plain-object.js';
import { robustHomedir } from '../constants/paths.js';

/** Claude Code's config dir: `$CLAUDE_CONFIG_DIR` when set (the CLI honors
 *  it for both files — verified), else `~/.claude`. */
function claudeConfigDir(): string {
  return process.env[CLAUDE_CODE.CONFIG_DIR_ENV] || join(robustHomedir(), CLAUDE_CODE.CONFIG_DIR);
}

/** ~/.claude/settings.json (hooks, StatusLine, plugin enablement); an explicit override for hermetic tests. */
export function claudeSettingsPath(): string {
  return process.env[ENV.CLAUDE_SETTINGS] ?? join(claudeConfigDir(), CLAUDE_CODE.SETTINGS_FILENAME);
}

/** ~/.claude.json — the user-scope MCP registry; `$CLAUDE_CONFIG_DIR/.claude.json`
 *  when relocated (the CLI writes there too); an explicit override for hermetic tests. */
export function claudeConfigPath(): string {
  const override = process.env[ENV.CLAUDE_CONFIG];
  if (override) return override;
  return join(process.env[CLAUDE_CODE.CONFIG_DIR_ENV] || robustHomedir(), CLAUDE_CODE.CONFIG_FILENAME);
}

/** The user-scope `mcpServers` map (absent file or key → empty), or an error
 *  when the file is unreadable — a corrupt registry must be reported, never
 *  treated as empty (an `add-json` against it would fail anyway). */
export function readClaudeUserMcpServers(path: string): { servers: Record<string, unknown> } | { error: string } {
  if (!existsSync(path)) return { servers: {} };
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    if (!isPlainObject(parsed)) return { error: 'not a JSON object' };
    const servers = (parsed as { mcpServers?: unknown }).mcpServers;
    if (servers === undefined) return { servers: {} };
    if (!isPlainObject(servers)) return { error: 'mcpServers is not an object' };
    return { servers: servers as Record<string, unknown> };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, fsConstants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** nvm bins newest-first — lexical order put v9 after v22 (the plugin launcher's `sort -rV` lesson). */
function nvmClaudeBins(home: string): string[] {
  const root = join(home, ...CLAUDE_CODE.NVM_VERSIONS_DIR);
  let versions: string[];
  try { versions = readdirSync(root); } catch { return []; }
  const key = (v: string): number[] => v.replace(/^v/, '').split('.').map(n => Number.parseInt(n, 10) || 0);
  versions.sort((a, b) => {
    const ka = key(a), kb = key(b);
    for (let i = 0; i < 3; i++) if ((kb[i] ?? 0) !== (ka[i] ?? 0)) return (kb[i] ?? 0) - (ka[i] ?? 0);
    return 0;
  });
  return versions.map(v => join(root, v, 'bin', CLAUDE_CODE.CLI_BIN));
}

export type ClaudeBin = { bin: string } | { missing: string };

/**
 * Locate the `claude` CLI. The ENV override is used verbatim (a wrong path
 * is reported as such, not as "off PATH"); otherwise PATH, then the places
 * Claude Code's installers put it — init often runs from a non-login shell
 * that never sourced those into PATH, and an installer that saw exit 0
 * while nothing was registered is the bug this module exists to fix (review).
 */
export function resolveClaudeBin(): ClaudeBin {
  const override = process.env[ENV.CLAUDE_BIN];
  if (override) {
    return isExecutableFile(override)
      ? { bin: override }
      : { missing: `${ENV.CLAUDE_BIN}=${override} is not an executable file` };
  }
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir && isExecutableFile(join(dir, CLAUDE_CODE.CLI_BIN))) return { bin: join(dir, CLAUDE_CODE.CLI_BIN) };
  }
  const home = robustHomedir();
  const candidates = [
    ...CLAUDE_CODE.CLI_HOME_LOCATIONS.map(segments => join(home, ...segments, CLAUDE_CODE.CLI_BIN)),
    ...CLAUDE_CODE.CLI_SYSTEM_LOCATIONS.map(dir => join(dir, CLAUDE_CODE.CLI_BIN)),
    ...nvmClaudeBins(home),
  ];
  const found = candidates.find(isExecutableFile);
  return found
    ? { bin: found }
    : { missing: `Claude Code's \`${CLAUDE_CODE.CLI_BIN}\` CLI is not on PATH or in its usual install locations` };
}

export interface ClaudeMcpAction {
  kind: 'add' | 'remove';
  name: string;
  reason: string;
  /** For the add half of a re-point: the entry the paired remove takes away, so a failed add can print how to restore it. */
  previous?: unknown;
}
export interface ClaudeMcpPlan {
  actions: ClaudeMcpAction[];
  /** `=` lines: nothing to do, and why. */
  notes: string[];
  /** `!` lines: entries left in place that the user should look at. */
  warnings: string[];
}

/**
 * Decide which `claude mcp` calls bring the user scope to the desired state.
 * Full init: the current-name key becomes ours — re-pointed when it launches
 * anything else (an nvm/version switch moves the install path). Under
 * `pluginManaged` (--statusline-only) our exact entry is REMOVED instead: the
 * plugin's .mcp.json provides the server, and two registrations run two
 * servers; anything else under our name is reported with the removal
 * command, never claimed absent. Legacy keys (`cairn`) launching OUR exact
 * server.js go in both modes — the pre-rename alias of this very install; a
 * look-alike at another path is only reported (a relocated old install OR a
 * foreign one — never ours to delete).
 */
export function planClaudeMcp(
  servers: Record<string, unknown>, desired: McpServerEntry, options: { serverPath: string; pluginManaged: boolean },
): ClaudeMcpPlan {
  const actions: ClaudeMcpAction[] = [];
  const notes: string[] = [];
  const warnings: string[] = [];
  const current = servers[MCP_SERVER_NAME];
  const removeLine = (name: string): string => commandLine({ kind: 'remove', name, reason: '' }, desired);
  if (options.pluginManaged) {
    if (current === undefined) {
      notes.push(`no user-scope ${MCP_SERVER_NAME} entry (the plugin provides the server)`);
    } else if (referencesServer(current, options.serverPath)) {
      actions.push({ kind: 'remove', name: MCP_SERVER_NAME, reason: 'the plugin provides it' });
    } else if (looksLikeWaykeepServer(current)) {
      warnings.push(`${MCP_SERVER_NAME} left in place — a Waykeep server that is not this install's (${describeServerEntry(current)}); the plugin provides one too, so if it is redundant: ${removeLine(MCP_SERVER_NAME)}`);
    } else {
      warnings.push(`${MCP_SERVER_NAME} left in place — not recognized as a Waykeep server (${describeServerEntry(current)}); if it is redundant with the plugin: ${removeLine(MCP_SERVER_NAME)}`);
    }
  } else if (current === undefined) {
    actions.push({ kind: 'add', name: MCP_SERVER_NAME, reason: 'this install' });
  } else if (sameServerEntry(current, desired)) {
    notes.push(`${MCP_SERVER_NAME} already registered for this install`);
  } else {
    actions.push({ kind: 'remove', name: MCP_SERVER_NAME, reason: `re-pointing to this install (was: ${describeServerEntry(current)})` });
    actions.push({ kind: 'add', name: MCP_SERVER_NAME, reason: 'this install', previous: current });
  }
  for (const ns of LEGACY_NAMESPACES) {
    const entry = servers[ns];
    if (entry === undefined) continue;
    if (referencesServer(entry, options.serverPath)) {
      actions.push({ kind: 'remove', name: ns, reason: `retired namespace — replaced by ${MCP_SERVER_NAME}` });
    } else if (looksLikeWaykeepServer(entry)) {
      warnings.push(`${ns} left in place — launches a Waykeep server at a DIFFERENT install path (${describeServerEntry(entry)}); if that install is retired: ${removeLine(ns)}`);
    }
  }
  return { actions, notes, warnings };
}

/** argv (after the binary) for one action — the tested option orders. `entry` is what an add registers. */
export function commandArgv(action: ClaudeMcpAction, entry: unknown): string[] {
  return action.kind === 'add'
    ? ['mcp', 'add-json', '-s', CLAUDE_CODE.MCP_SCOPE, action.name, JSON.stringify(entry)]
    : ['mcp', 'remove', action.name, '-s', CLAUDE_CODE.MCP_SCOPE];
}

/** The exact command for a human to paste — dry runs, a missing CLI, failures. */
export function commandLine(action: ClaudeMcpAction, entry: unknown): string {
  return [CLAUDE_CODE.CLI_BIN, ...commandArgv(action, entry).map(shellQuote)].join(' ');
}

export type ClaudeMcpOutcome = 'ok' | 'failed' | 'pending';
export interface ClaudeMcpResult {
  outcome: ClaudeMcpOutcome;
  /** Commands the user must run themselves — `pending` only. */
  pending: string[];
}

/**
 * Run the plan through the `claude` CLI, one line per action. `failed` when
 * the CLI ran and failed (init exits 1); `pending` when it could not be
 * found (the commands are printed, exactly as they would have run, and init
 * repeats them last — a missing CLI must never read as success).
 */
export function applyClaudeMcp(plan: ClaudeMcpPlan, desired: McpServerEntry, dryRun: boolean): ClaudeMcpResult {
  if (plan.actions.length === 0) return { outcome: 'ok', pending: [] };
  const lines = plan.actions.map(a => commandLine(a, desired));
  const cli = resolveClaudeBin();
  if (dryRun) {
    plan.actions.forEach((action, i) => console.log(`  ✓ ${action.name}: would run \`${lines[i]}\` (${action.reason})`));
    if ('missing' in cli) console.log(`  ! ${cli.missing} — a real run would leave these commands for you to run`);
    return { outcome: 'ok', pending: [] };
  }
  if ('missing' in cli) {
    const hint = process.env[ENV.CLAUDE_BIN] ? '' : ` (or set ${ENV.CLAUDE_BIN} to the binary and re-run)`;
    console.log(`  ! ${cli.missing} — run this yourself${hint}:`);
    for (const line of lines) console.log(`      ${line}`);
    return { outcome: 'pending', pending: lines };
  }
  let failed = false;
  const removed = new Set<string>();
  plan.actions.forEach((action, i) => {
    // A remove/add pair is not short-circuited: the usual remove failure is
    // the entry having vanished between plan and apply (another init, a hand
    // edit), after which the add succeeds; any other failure surfaces on the
    // add as well, and every ✗ names its command.
    const r = spawnSync(cli.bin, commandArgv(action, desired), {
      encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: CLAUDE_CODE.CLI_TIMEOUT_MS,
    });
    if (r.error || r.status !== 0) {
      failed = true;
      const detail = (r.stderr || r.stdout || r.error?.message || '').trim().split('\n')[0];
      console.error(`  ✗ ${action.name}: \`${lines[i]}\` failed${detail ? ` — ${detail}` : ''}`);
      if (action.previous !== undefined && removed.has(action.name)) {
        // The re-point removed the old entry first, so a failed add leaves
        // NO entry — say how to get the old one back (review).
        console.error(`    the previous ${action.name} entry was already removed — restore it with:`);
        console.error(`      ${commandLine({ kind: 'add', name: action.name, reason: '' }, action.previous)}`);
      }
      return;
    }
    if (action.kind === 'remove') removed.add(action.name);
    console.log(`  ✓ ${action.name} ${action.kind === 'add' ? 'registered' : 'removed'} (${action.reason})`);
  });
  return { outcome: failed ? 'failed' : 'ok', pending: [] };
}

/**
 * Trust, then verify: the CLI's exit status is not proof of a write — the
 * real one exited 0 with "Added …" against a registry it could not modify
 * (validation, 2.1.258), which would reproduce the very symptom this module
 * fixes. Re-read the registry and require the end state the plan described,
 * per name (the last action for a name wins).
 */
function verifyApplied(path: string, plan: ClaudeMcpPlan, desired: McpServerEntry): boolean {
  const read = readClaudeUserMcpServers(path);
  if ('error' in read) {
    console.error(`  ✗ could not re-read ${path} after applying: ${read.error}`);
    return false;
  }
  const finalAction = new Map<string, ClaudeMcpAction>();
  for (const action of plan.actions) finalAction.set(action.name, action);
  let ok = true;
  for (const [name, action] of finalAction) {
    const entry = read.servers[name];
    if (action.kind === 'add' ? sameServerEntry(entry, desired) : entry === undefined) continue;
    ok = false;
    console.error(`  ✗ ${name}: the CLI reported success, but ${path} does not show it — is the file writable? Re-run \`waykeep init\`, or apply by hand: ${commandLine(action, desired)}`);
  }
  return ok;
}

/** The init step: report, plan, apply, verify. */
export function registerClaudeMcp(serverPath: string, options: { dryRun: boolean; pluginManaged: boolean }): ClaudeMcpResult {
  const path = claudeConfigPath();
  console.log(`\nClaude Code MCP registry (${path}, via \`${CLAUDE_CODE.CLI_BIN} mcp\`):`);
  const desired = waykeepMcpServerEntry(serverPath);
  const read = readClaudeUserMcpServers(path);
  if ('error' in read) {
    console.error(`  ✗ could not read ${path}: ${read.error} — fix it, then re-run \`waykeep init\``);
    return { outcome: 'failed', pending: [] };
  }
  const plan = planClaudeMcp(read.servers, desired, { serverPath, pluginManaged: options.pluginManaged });
  for (const note of plan.notes) console.log(`  = ${note}`);
  for (const warning of plan.warnings) console.log(`  ! ${warning}`);
  const result = applyClaudeMcp(plan, desired, options.dryRun);
  if (result.outcome !== 'ok' || options.dryRun || plan.actions.length === 0) return result;
  return verifyApplied(path, plan, desired) ? result : { outcome: 'failed', pending: [] };
}
