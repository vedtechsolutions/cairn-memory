/**
 * `cairn init` — write Cairn's client configuration.
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
import { CAIRN_HOOK_DIR_MARKER } from '../constants/index.js';

/** Package root: dist/src/cli/ → the install root that holds dist/. */
const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const HOOK_DIR = join(PKG_ROOT, 'dist', 'src', 'hooks');
const SERVER = join(PKG_ROOT, 'dist', 'src', 'mcp', 'server.js');

/** Every Cairn hook — relay or node-form, current or legacy — lives under
 *  the marker directory, so one substring identifies Cairn entries across
 *  reinstalls; a user's own hook pointing into a Cairn install's hooks dir
 *  is effectively impossible. */
const CAIRN_HOOK_MARKERS = [CAIRN_HOOK_DIR_MARKER];

interface HookCommand { type: 'command'; command: string; async?: boolean }
interface HookMatcher { matcher: string; hooks: HookCommand[] }
type HookMap = Record<string, HookMatcher[]>;
interface Settings { mcpServers?: Record<string, unknown>; statusLine?: unknown; hooks?: HookMap; [k: string]: unknown }

function nodeHook(script: string): HookCommand { return { type: 'command', command: `node ${join(HOOK_DIR, script)}` }; }
function one(matcher: string, ...hooks: HookCommand[]): HookMatcher[] { return [{ matcher, hooks }]; }

/** The canonical Cairn hook set (mirrors README section 3), built against the
 *  resolved relay command prefix (compiled binary or shell fallback).
 *  Exported for tests that assert the generated commands per relay form. */
export function cairnHooks(relayCmd: string): HookMap {
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

function cairnMcpServer(): Record<string, unknown> {
  return { command: 'node', args: [SERVER], env: { CAIRN_LOG_LEVEL: 'info' } };
}

function cairnStatusLine(): Record<string, unknown> {
  return { type: 'command', command: `node ${join(HOOK_DIR, 'statusline.js')}` };
}

/** True when any command in the entry references a Cairn hook. */
function isCairnEntry(entry: HookMatcher): boolean {
  return entry.hooks.some(h => CAIRN_HOOK_MARKERS.some(marker => h.command.includes(marker)));
}

interface MergePlan { changed: string[]; skipped: string[]; result: Settings }

/**
 * Merge Cairn's config into existing settings without clobbering the user's:
 * the `cairn` MCP server is set (other servers kept); each hook event gets
 * Cairn's entries with any prior Cairn entries replaced and non-Cairn entries
 * preserved; StatusLine is set only when absent or already Cairn's.
 */
function mergeSettings(existing: Settings, relayCmd: string): MergePlan {
  const changed: string[] = [];
  const skipped: string[] = [];
  const result: Settings = { ...existing };

  const servers = { ...(existing.mcpServers ?? {}) };
  servers.cairn = cairnMcpServer();
  result.mcpServers = servers;
  changed.push('mcpServers.cairn');

  const statusIsCairn = typeof existing.statusLine === 'object' && existing.statusLine !== null
    && String((existing.statusLine as { command?: string }).command ?? '').includes('dist/src/hooks/statusline');
  if (existing.statusLine === undefined || statusIsCairn) {
    result.statusLine = cairnStatusLine();
    changed.push('statusLine');
  } else {
    skipped.push('statusLine (a non-Cairn StatusLine is already set — left untouched)');
  }

  const hooks: HookMap = { ...(existing.hooks ?? {}) };
  const desired = cairnHooks(relayCmd);
  for (const [event, cairnEntries] of Object.entries(desired)) {
    const preserved = (hooks[event] ?? []).filter(entry => !isCairnEntry(entry));
    hooks[event] = [...preserved, ...cairnEntries];
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
  return process.env.CAIRN_CLAUDE_SETTINGS ?? join(homedir(), '.claude', 'settings.json');
}

function readSettings(path: string): Settings {
  if (!existsSync(path)) return {};
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('settings.json is not a JSON object');
  }
  return parsed as Settings;
}

export interface InitOptions { dryRun?: boolean; migrateRoutes?: boolean }

/** Run init; returns the process exit code. */
export function runInit(options: InitOptions = {}): number {
  console.log(`cairn init — configuring clients for this install\n  install: ${PKG_ROOT}\n`);

  const hasRelay = existsSync(relayBinaryPath(HOOK_DIR)) || existsSync(relayShellPath(HOOK_DIR));
  if (!hasRelay || !existsSync(SERVER)) {
    console.error(`  ✗ build artifacts missing under ${join(PKG_ROOT, 'dist')} — run \`npm run build\` first`);
    return 1;
  }

  const relay = resolveRelay(HOOK_DIR);
  const path = claudeSettingsPath();
  let plan: MergePlan;
  try {
    plan = mergeSettings(readSettings(path), relay.command);
  } catch (err) {
    console.error(`  ✗ could not read ${path}: ${(err as Error).message}`);
    return 1;
  }

  console.log(`Relay: ${relay.kind === 'binary'
    ? 'compiled hook-relay (fast path)'
    : 'shell fallback (hook-relay.sh) — run `cairn build-relay` where a C compiler is available for the fast path'}`);
  console.log('Claude Code (~/.claude/settings.json):');
  for (const change of plan.changed) console.log(`  ✓ ${change}`);
  for (const skip of plan.skipped) console.log(`  ! ${skip}`);

  if (!options.dryRun) {
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path)) {
      const backup = `${path}.cairn-backup`;
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

  runCodexInit(relay.command, SERVER, options.dryRun ?? false, options.migrateRoutes ?? false);

  if (options.dryRun) console.log('\n  (dry run — no files were written)');

  const detected = OTHER_CLIENTS.filter(c => existsSync(join(homedir(), c.dir)));
  if (detected.length > 0) {
    console.log(`\nOther MCP clients detected: ${detected.map(c => c.name).join(', ')}`);
    console.log(`  Cairn works as an MCP server in any of them. Register this command:`);
    console.log(`    node ${SERVER}`);
    console.log(`  (each client's MCP config format differs, so init does not edit them automatically)`);
  }

  console.log(`\ncairn init: done${options.dryRun ? ' (dry run)' : ''}. Run \`cairn doctor\` to verify.`);
  return 0;
}
