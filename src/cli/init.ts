/**
 * `waykeep init` — write Waykeep's client configuration.
 *
 * Replaces the manual settings.json editing the README documents: it resolves
 * this install's absolute paths, generates the canonical Claude Code config
 * (MCP server + StatusLine + the full hook set), and merges it idempotently
 * into ~/.claude/settings.json (preserving everything else, backing up first).
 * Other MCP-capable clients are detected and reported, not auto-edited, since
 * their config formats differ. `--dry-run` previews without writing.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { resolveRelay, relayBinaryPath, relayShellPath } from './relay.js';
import { runCodexInit } from './codex-init.js';
import { isWaykeepHookCommand } from '../constants/index.js';
import { ENV } from '../constants/env.js';
import { BACKUP_SUFFIX } from '../constants/paths.js';
import { MCP_SERVER_NAME } from '../constants/mcp.js';
import { LEGACY_NAMESPACES } from 'waykeep-contract';

/** Package root: dist/src/cli/ → the install root that holds dist/. */
const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const HOOK_DIR = join(PKG_ROOT, 'dist', 'src', 'hooks');
const SERVER = join(PKG_ROOT, 'dist', 'src', 'mcp', 'server.js');


interface HookCommand { type: 'command'; command: string; async?: boolean }
interface HookMatcher { matcher: string; hooks: HookCommand[] }
type HookMap = Record<string, HookMatcher[]>;
interface Settings { mcpServers?: Record<string, unknown>; statusLine?: unknown; hooks?: HookMap; [k: string]: unknown }

function nodeHook(script: string): HookCommand { return { type: 'command', command: `node ${join(HOOK_DIR, script)}` }; }
function one(matcher: string, ...hooks: HookCommand[]): HookMatcher[] { return [{ matcher, hooks }]; }

/** The canonical Waykeep hook set (mirrors README section 3), built against the
 *  resolved relay command prefix (compiled binary or shell fallback).
 *  Exported for tests that assert the generated commands per relay form. */
export function waykeepHooks(relayCmd: string): HookMap {
  const relay = (sub: string): HookCommand => ({ type: 'command', command: `${relayCmd} ${sub}` });
  const relayAsync = (sub: string): HookCommand => ({ type: 'command', command: `${relayCmd} ${sub}`, async: true });
  return {
    SessionStart: one('', relay('session-start')),
    UserPromptSubmit: one('', relay('prompt-check')),
    PreToolUse: [{ matcher: 'Write|Edit|MultiEdit', hooks: [relay('pitfall-check')] }, { matcher: 'Bash', hooks: [relay('pitfall-check')] }],
    PostToolUse: [{ matcher: 'Bash|Write|Edit|MultiEdit', hooks: [relayAsync('success-tracker')] }, { matcher: 'ExitPlanMode', hooks: [relay('plan-bridge')] }],
    PostToolUseFailure: one('Bash|Write|Edit|MultiEdit', relayAsync('error-learning')),
    PreCompact: one('', nodeHook('precompact.js')),
    PostCompact: one('', relay('postcompact')),
    SessionEnd: one('', nodeHook('session-end.js')),
    SubagentStart: one('', relay('subagent-context')),
    Stop: one('', relay('governance-gate'), relayAsync('stop')),
    SubagentStop: one('', relayAsync('subagent-stop')),
    StopFailure: one('rate_limit|max_output_tokens|server_error', relayAsync('stop-failure')),
    // FileChanged is deliberately NOT wired: its matcher is a literal
    // filename watch list ('' watches NO files — unlike every other
    // event), so this entry never fired; its async additionalContext is
    // undeliverable anyway, and governance already degrades gracefully
    // (missing_file_changed). The daemon route stays for a future
    // targeted watch list. (Plugin validation finding, 2026-08-29.)
  };
}

function waykeepMcpServer(): Record<string, unknown> {
  return { command: 'node', args: [SERVER], env: { [ENV.LOG_LEVEL]: 'info' } };
}

function waykeepStatusLine(): Record<string, unknown> {
  return { type: 'command', command: `node ${join(HOOK_DIR, 'statusline.js')}` };
}

/** True when any command in the entry references a Waykeep hook. A
 *  malformed entry (no hooks array — user-authored settings are
 *  arbitrary JSON) is NOT ours: treating it as foreign preserves it,
 *  where `.some` on undefined aborted the whole init (review). */
function isWaykeepEntry(entry: HookMatcher): boolean {
  return Array.isArray(entry.hooks)
    && entry.hooks.some(h => typeof h?.command === 'string' && isWaykeepHookCommand(h.command));
}

/** Remove Waykeep HANDLERS from entries, at handler granularity: a MIXED
 *  entry (a Waykeep handler beside the user's own) keeps its foreign
 *  handlers — entry-level removal deleted them (review). Entries left
 *  empty drop; returns null when nothing remains for the event. */
function sweepWaykeepHandlers(entries: HookMatcher[]): { kept: HookMatcher[] | null; swept: boolean } {
  let swept = false;
  const kept: HookMatcher[] = [];
  for (const entry of entries) {
    if (!isWaykeepEntry(entry)) { kept.push(entry); continue; }
    swept = true;
    const foreign = entry.hooks.filter(h => !(typeof h?.command === 'string' && isWaykeepHookCommand(h.command)));
    if (foreign.length > 0) kept.push({ ...entry, hooks: foreign });
  }
  return { kept: kept.length > 0 ? kept : null, swept };
}

/** The `args` strings of an mcpServers entry (empty for a malformed one). */
function serverArgs(entry: unknown): string[] {
  if (!entry || typeof entry !== 'object') return [];
  const args = (entry as { args?: unknown }).args;
  return Array.isArray(args) ? args.filter((a): a is string => typeof a === 'string') : [];
}

const normalizePath = (p: string): string => p.replace(/\\/g, '/');

/**
 * True when an entry launches OUR EXACT server.js — THIS install's absolute
 * path. This is the only case safe to auto-remove: an in-place pre-rename alias
 * of the very server we are installing. A foreign server, OR the same product
 * installed at a different path, is never our exact path, so a suffix match
 * (which could delete `…/other-project/dist/src/mcp/server.js`) is unsafe
 * (codex B1 review). Windows backslashes are normalized on both sides.
 */
function referencesOurServer(entry: unknown): boolean {
  const target = normalizePath(SERVER);
  return serverArgs(entry).some(a => normalizePath(a) === target);
}

/** True when an entry launches SOME waykeep/cairn server.js (any install) —
 *  used only to WARN, never to delete. */
function looksLikeWaykeepServer(entry: unknown): boolean {
  return serverArgs(entry).some(a => normalizePath(a).endsWith('/dist/src/mcp/server.js'));
}

/**
 * Categorize stale legacy-namespace MCP keys (e.g. `cairn`). `removed` are keys
 * launching OUR exact server (auto-deleted — the pre-rename alias of this
 * install). `suspect` are keys launching a waykeep/cairn server at a DIFFERENT
 * path (a relocated old install, OR a foreign one we must not delete): left in
 * place and reported so the operator can remove them by hand. Everything else
 * is untouched. Removed with the legacy namespace at Phase D.
 */
function sweepLegacyMcpServers(servers: Record<string, unknown>): { removed: string[]; suspect: string[] } {
  const removed: string[] = [];
  const suspect: string[] = [];
  for (const ns of LEGACY_NAMESPACES) {
    if (servers[ns] === undefined) continue;
    if (referencesOurServer(servers[ns])) {
      delete servers[ns];
      removed.push(ns);
    } else if (looksLikeWaykeepServer(servers[ns])) {
      suspect.push(ns);
    }
  }
  return { removed, suspect };
}

interface MergePlan { changed: string[]; skipped: string[]; result: Settings }

/**
 * Merge Waykeep's config into existing settings without clobbering the user's:
 * the `waykeep` MCP server is set (other servers kept, stale legacy keys swept);
 * each hook event gets Waykeep's entries with any prior Waykeep entries replaced
 * and non-Waykeep entries preserved; StatusLine is set only when absent or Waykeep's.
 */
function mergeSettings(existing: Settings, relayCmd: string, statuslineOnly = false): MergePlan {
  const changed: string[] = [];
  const skipped: string[] = [];
  const result: Settings = { ...existing };

  const statusIsWaykeep = typeof existing.statusLine === 'object' && existing.statusLine !== null
    && isWaykeepHookCommand(String((existing.statusLine as { command?: string }).command ?? ''));
  if (existing.statusLine === undefined || statusIsWaykeep) {
    result.statusLine = waykeepStatusLine();
    changed.push('statusLine');
  } else {
    skipped.push('statusLine (a non-Waykeep StatusLine is already set — left untouched)');
  }
  if (statuslineOnly) {
    // The flag MEANS "the plugin manages hooks + MCP", so settings.json
    // must not keep a parallel set: an existing user who ran a full
    // init under the old docs and then installed the plugin stayed
    // double-wired (two briefings per session) with nothing to remove
    // it (review N4). Sweep Waykeep's entries; foreign ones untouched.
    const hooks: HookMap = { ...(existing.hooks ?? {}) };
    let sweptEvents = 0;
    for (const [event, entries] of Object.entries(hooks)) {
      const { kept, swept } = sweepWaykeepHandlers(entries);
      if (swept) {
        if (kept) hooks[event] = kept;
        else delete hooks[event];
        sweptEvents++;
      }
    }
    if (sweptEvents > 0) {
      result.hooks = hooks;
      changed.push(`hooks (${sweptEvents} event(s) of settings-wired Waykeep hooks removed — the plugin provides them)`);
    }
    // Sweep BOTH the current server key and any stale legacy key (e.g.
    // `cairn`) that references our server — a --statusline-only run under the
    // plugin must not leave a settings-wired server double-registered, and an
    // upgraded install may still carry the retired-name entry (codex B1 review).
    const servers = { ...(existing.mcpServers ?? {}) };
    let removedServer = false;
    if (referencesOurServer(servers[MCP_SERVER_NAME])) {
      delete servers[MCP_SERVER_NAME];
      removedServer = true;
      changed.push(`mcpServers.${MCP_SERVER_NAME} removed (the plugin provides it)`);
    }
    const swept = sweepLegacyMcpServers(servers);
    for (const ns of swept.removed) {
      removedServer = true;
      changed.push(`mcpServers.${ns} removed (retired namespace — the plugin provides it)`);
    }
    for (const ns of swept.suspect) {
      skipped.push(`mcpServers.${ns} left in place — launches a waykeep server at a DIFFERENT install path; remove it by hand if that install is retired`);
    }
    if (removedServer) result.mcpServers = servers;
    skipped.push('hooks + MCP wiring (plugin-managed — --statusline-only)');
    return { changed, skipped, result };
  }

  const servers = { ...(existing.mcpServers ?? {}) };
  servers[MCP_SERVER_NAME] = waykeepMcpServer();
  const swept = sweepLegacyMcpServers(servers);
  for (const ns of swept.removed) {
    changed.push(`mcpServers.${ns} removed (retired namespace — replaced by ${MCP_SERVER_NAME})`);
  }
  for (const ns of swept.suspect) {
    skipped.push(`mcpServers.${ns} left in place — launches a waykeep server at a DIFFERENT install path; remove it by hand if that install is retired`);
  }
  result.mcpServers = servers;
  changed.push(`mcpServers.${MCP_SERVER_NAME}`);

  const hooks: HookMap = { ...(existing.hooks ?? {}) };
  const desired = waykeepHooks(relayCmd);
  for (const [event, waykeepEntries] of Object.entries(desired)) {
    const preserved = (hooks[event] ?? []).filter(entry => !isWaykeepEntry(entry));
    hooks[event] = [...preserved, ...waykeepEntries];
  }
  // Orphan sweep: Waykeep entries under events the CURRENT hook set no
  // longer wires (e.g. FileChanged after its removal) would otherwise
  // survive every upgrade forever, pointing at whatever install wrote
  // them (review). Foreign entries under those events are untouched.
  for (const [event, entries] of Object.entries(hooks)) {
    if (Object.hasOwn(desired, event)) continue;
    const { kept, swept } = sweepWaykeepHandlers(entries);
    if (swept) {
      if (kept) hooks[event] = kept;
      else delete hooks[event];
      changed.push(`hooks.${event} (stale Waykeep entries removed)`);
    }
  }
  result.hooks = hooks;
  changed.push(`hooks (${Object.keys(desired).length} events)`);

  return { changed, skipped, result };
}

/** Non-Claude MCP clients with no native wiring yet, reported not
 *  auto-edited. Codex is wired for real by runCodexInit. */
const OTHER_CLIENTS: Array<{ name: string; dir: string }> = [
  { name: 'Cursor', dir: '.cursor' },
  { name: 'Gemini CLI', dir: '.gemini' },
  { name: 'Windsurf', dir: '.codeium' },
];

function claudeSettingsPath(): string {
  return process.env[ENV.CLAUDE_SETTINGS] ?? join(homedir(), '.claude', 'settings.json');
}

function readSettings(path: string): Settings {
  if (!existsSync(path)) return {};
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('settings.json is not a JSON object');
  }
  return parsed as Settings;
}

export interface InitOptions {
  dryRun?: boolean;
  migrateRoutes?: boolean;
  /** Write ONLY the StatusLine into settings.json — for users whose
   *  hooks + MCP come from the marketplace plugin (a full init would
   *  double-wire every event: two briefings per session; review B2). */
  statuslineOnly?: boolean;
}

/** Run init; returns the process exit code. */
export function runInit(options: InitOptions = {}): number {
  console.log(`waykeep init — configuring clients for this install\n  install: ${PKG_ROOT}\n`);

  const hasRelay = existsSync(relayBinaryPath(HOOK_DIR)) || existsSync(relayShellPath(HOOK_DIR));
  if (!hasRelay || !existsSync(SERVER)) {
    console.error(`  ✗ build artifacts missing under ${join(PKG_ROOT, 'dist')} — run \`npm run build\` first`);
    return 1;
  }

  const relay = resolveRelay(HOOK_DIR);
  const path = claudeSettingsPath();
  let plan: MergePlan;
  try {
    plan = mergeSettings(readSettings(path), relay.command, options.statuslineOnly ?? false);
  } catch (err) {
    console.error(`  ✗ could not read ${path}: ${(err as Error).message}`);
    return 1;
  }

  console.log(`Relay: ${relay.kind === 'binary'
    ? 'compiled hook-relay (fast path)'
    : 'shell fallback (hook-relay.sh) — run `waykeep build-relay` where a C compiler is available for the fast path'}`);
  console.log('Claude Code (~/.claude/settings.json):');
  for (const change of plan.changed) console.log(`  ✓ ${change}`);
  for (const skip of plan.skipped) console.log(`  ! ${skip}`);

  if (!options.dryRun) {
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path)) {
      const backup = `${path}${BACKUP_SUFFIX}`;
      // Back up only the pristine, pre-init file — never overwrite it on a
      // re-run, which would replace the original with an already-merged copy.
      if (!existsSync(backup)) {
        copyFileSync(path, backup);
        console.log(`  ✓ backed up existing settings to ${backup}`);
      }
    }
    // Atomic write (temp + rename) so a crash mid-write can't corrupt the
    // user's primary config — same pattern as state-io.ts.
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(plan.result, null, 2)}\n`, 'utf-8');
    renameSync(tmp, path);
    console.log(`  ✓ wrote ${path}`);
  }

  // --statusline-only touches ONLY the StatusLine — Codex wiring is a
  // separate concern the flag's user did not ask about.
  if (!options.statuslineOnly) {
    runCodexInit(relay.command, SERVER, options.dryRun ?? false, options.migrateRoutes ?? false);
  }

  if (options.dryRun) console.log('\n  (dry run — no files were written)');

  const detected = OTHER_CLIENTS.filter(c => existsSync(join(homedir(), c.dir)));
  if (detected.length > 0) {
    console.log(`\nOther MCP clients detected: ${detected.map(c => c.name).join(', ')}`);
    console.log(`  Waykeep works as an MCP server in any of them. Register this command:`);
    console.log(`    node ${SERVER}`);
    console.log(`  (each client's MCP config format differs, so init does not edit them automatically)`);
  }

  console.log(`\nwaykeep init: done${options.dryRun ? ' (dry run)' : ''}. Run \`waykeep doctor\` to verify.`);
  return 0;
}
