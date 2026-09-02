/**
 * `waykeep init` — write Waykeep's client configuration.
 *
 * Replaces the manual editing the README used to document: it resolves this
 * install's absolute paths, merges the StatusLine and the full hook set
 * idempotently into ~/.claude/settings.json (preserving everything else,
 * backing up first), and registers the MCP server through the `claude mcp`
 * CLI — Claude Code reads MCP servers from ~/.claude.json, never from
 * settings.json, so the `mcpServers` block earlier versions wrote there was
 * inert and is swept (see claude-mcp.ts). Codex is wired by codex-init.ts;
 * other MCP-capable clients are detected and reported, not auto-edited,
 * since their config formats differ. `--dry-run` previews without writing.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { resolveRelay, relayBinaryPath, relayShellPath } from './relay.js';
import { runCodexInit } from './codex-init.js';
import { registerClaudeMcp, claudeSettingsPath } from './claude-mcp.js';
import { looksLikeWaykeepServer, sweepLegacyMcpServers } from './mcp-entry.js';
import { isWaykeepHookCommand } from '../constants/index.js';
import { BACKUP_SUFFIX } from '../constants/paths.js';
import { MCP_SERVER_NAME } from '../constants/mcp.js';
import { CLAUDE_CODE } from '../constants/claude-code.js';

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

/**
 * Sweep the INERT `mcpServers` entries earlier inits wrote into settings.json.
 * Claude Code never reads that key from settings.json (only ~/.claude.json,
 * .mcp.json and plugins), so a Waykeep entry here only misleads — it looks
 * wired while nothing is. Our own key goes whenever it launches a waykeep
 * server (any install: it was ours to write and does nothing); a legacy key
 * goes only for OUR exact server.js, a look-alike at another path is reported
 * (never ours to delete). This is deliberately looser than the ~/.claude.json
 * planner, which re-points rather than deletes and touches only exact paths:
 * entries THERE are live registrations, entries HERE never did anything.
 * Returns the swept map, or null when nothing changed.
 */
function sweepSettingsMcpServers(existing: Settings, changed: string[], skipped: string[]): Record<string, unknown> | null {
  const servers = { ...(existing.mcpServers ?? {}) };
  let swept = false;
  const inert = `inert here — Claude Code reads MCP servers from ~/${CLAUDE_CODE.CONFIG_FILENAME}, not settings.json`;
  if (looksLikeWaykeepServer(servers[MCP_SERVER_NAME])) {
    delete servers[MCP_SERVER_NAME];
    swept = true;
    changed.push(`mcpServers.${MCP_SERVER_NAME} removed (${inert})`);
  }
  const legacy = sweepLegacyMcpServers(servers, SERVER);
  for (const ns of legacy.removed) {
    swept = true;
    changed.push(`mcpServers.${ns} removed (${inert}; retired namespace — replaced by ${MCP_SERVER_NAME})`);
  }
  for (const ns of legacy.suspect) {
    skipped.push(`mcpServers.${ns} left in place (${inert}) — it launches a waykeep server at a DIFFERENT install path, not this install's to delete; remove it by hand if that install is retired`);
  }
  return swept ? servers : null;
}

interface MergePlan { changed: string[]; skipped: string[]; result: Settings }

/**
 * Merge Waykeep's config into existing settings without clobbering the user's:
 * inert `mcpServers` entries are swept (the server is registered through
 * `claude mcp` instead — see runInit); each hook event gets Waykeep's entries
 * with any prior Waykeep entries replaced and non-Waykeep entries preserved;
 * StatusLine is set only when absent or Waykeep's.
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

  // Both modes: the settings-wired MCP block never worked, and under the
  // plugin a stale one still misleads (an upgraded install may also carry
  // the retired-name entry; codex B1 review). An emptied map is dropped.
  const sweptServers = sweepSettingsMcpServers(existing, changed, skipped);
  if (sweptServers !== null) {
    if (Object.keys(sweptServers).length > 0) result.mcpServers = sweptServers;
    else delete result.mcpServers;
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
    skipped.push('hooks + MCP wiring (plugin-managed — --statusline-only)');
    return { changed, skipped, result };
  }

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

  // The MCP server itself goes through `claude mcp`, in BOTH modes: a
  // --statusline-only run removes our user-scope entry (the plugin's
  // .mcp.json provides the server; two registrations run two servers).
  const claude = registerClaudeMcp(SERVER, {
    dryRun: options.dryRun ?? false, pluginManaged: options.statuslineOnly ?? false,
  });

  // --statusline-only touches ONLY Claude's wiring — Codex is a separate
  // concern the flag's user did not ask about.
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

  // A registration init could not perform is repeated LAST, where a reader
  // who only sees the end of the output cannot mistake it for done (review).
  if (claude.outcome === 'pending') {
    console.log('\n  ACTION REQUIRED — the Claude Code MCP server is NOT registered yet. Run:');
    for (const line of claude.pending) console.log(`      ${line}`);
  }
  const outcome = claude.outcome === 'failed' ? 'finished with errors (see ✗ above)'
    : claude.outcome === 'pending' ? 'done, 1 action required (above)'
      : 'done';
  console.log(`\nwaykeep init: ${outcome}${options.dryRun ? ' (dry run)' : ''}. Run \`waykeep doctor\` to verify.`);
  return claude.outcome === 'failed' ? 1 : 0;
}
