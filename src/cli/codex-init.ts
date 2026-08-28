/**
 * Codex CLI wiring for `cairn init` / `cairn doctor` (parity step 5).
 *
 * Generates ~/.codex/hooks.json from this install's resolved relay (every
 * event through `hook-relay --client codex`, mirroring the Claude wiring),
 * merges it idempotently (non-Cairn hook groups preserved), and registers
 * the MCP server in ~/.codex/config.toml by appending a table when absent —
 * a scoped line-level edit, deliberately no TOML dependency.
 *
 * Trust is the one step init cannot do: Codex hash-pins every non-managed
 * hook and runs an interactive review before executing it. Init prints
 * exactly what that review will show, warns when a command change is about
 * to invalidate existing trust, and hooks are silently skipped until the
 * user accepts them.
 */
import { existsSync, readFileSync, writeFileSync, copyFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CLIENT_CODEX } from '../constants/clients.js';
import { CAIRN_HOOK_DIR_MARKER } from '../constants/index.js';

/** ~/.codex, overridable for hermetic tests. */
export function codexDir(): string {
  return process.env.CAIRN_CODEX_DIR ?? join(homedir(), '.codex');
}
export function codexHooksPath(): string { return join(codexDir(), 'hooks.json'); }
export function codexConfigPath(): string { return join(codexDir(), 'config.toml'); }

interface CodexHookCommand {
  type: 'command';
  command: string;
  timeout?: number;
  async?: boolean;
  statusMessage?: string;
  additionalContextLimit?: number;
}
interface CodexMatcherGroup { matcher?: string; hooks: CodexHookCommand[] }
export interface CodexHooksFile { description: string; hooks: Record<string, CodexMatcherGroup[]> }

/** Codex clamps SessionEnd hook timeouts to 3s and warns above it. */
const SESSION_END_TIMEOUT_S = 3;
const SYNC_TIMEOUT_S = 10;
const ASYNC_TIMEOUT_S = 30;
/** Explicit so a Codex default change can't silently spill the briefing. */
const CONTEXT_LIMIT_TOKENS = 2500;

/** Canonical PostToolUse route (client-neutral, contract revision 1). */
export const POST_TOOL_ROUTE = 'post-tool';
/** Deprecated pre-contract alias; the daemon serves both indefinitely. */
export const LEGACY_POST_TOOL_ROUTE = 'codex-post-tool';
export type PostToolRoute = typeof POST_TOOL_ROUTE | typeof LEGACY_POST_TOOL_ROUTE;

/**
 * Which PostToolUse route to generate. Fresh installs get the canonical
 * `post-tool`; an install whose TRUSTED wiring names the deprecated
 * `codex-post-tool` keeps it verbatim — trust is hash-pinned to the exact
 * command string, so renaming the route in place would silently disable
 * every Cairn hook until the user re-reviews. Migration is therefore an
 * explicit opt-in (`cairn init --migrate-routes`), which rides the
 * existing trust-invalidation warning path.
 */
export function postToolRouteFor(
  existing: Partial<CodexHooksFile>,
  trustedBefore: number,
  migrateRoutes: boolean,
): PostToolRoute {
  if (migrateRoutes) return POST_TOOL_ROUTE;
  const hasLegacy = cairnCommandSet(existing).some((c) => c.endsWith(` ${LEGACY_POST_TOOL_ROUTE}`));
  return hasLegacy && trustedBefore > 0 ? LEGACY_POST_TOOL_ROUTE : POST_TOOL_ROUTE;
}

/** The canonical Codex hook set for this install's resolved relay command. */
export function codexHooks(relayCmd: string, postToolRoute: PostToolRoute = POST_TOOL_ROUTE): CodexHooksFile {
  const cmd = (sub: string): string => `${relayCmd} --client ${CLIENT_CODEX} ${sub}`;
  const sync = (sub: string, extra: Partial<CodexHookCommand> = {}): CodexMatcherGroup[] =>
    [{ hooks: [{ type: 'command', command: cmd(sub), timeout: SYNC_TIMEOUT_S, ...extra }] }];
  return {
    description: 'Cairn memory hooks — passive briefing, ambient recall, pitfall warnings, auto-capture (same experience as Claude Code). Requires one interactive trust review at next Codex start.',
    hooks: {
      SessionStart: sync('session-start', { statusMessage: 'Cairn briefing', additionalContextLimit: CONTEXT_LIMIT_TOKENS }),
      UserPromptSubmit: sync('prompt-check', { additionalContextLimit: CONTEXT_LIMIT_TOKENS }),
      PreToolUse: [{ matcher: 'Bash|apply_patch', hooks: [{ type: 'command', command: cmd('pitfall-check'), timeout: SYNC_TIMEOUT_S }] }],
      PostToolUse: [{ matcher: 'Bash|apply_patch', hooks: [{ type: 'command', command: cmd(postToolRoute), timeout: ASYNC_TIMEOUT_S, async: true }] }],
      Stop: [{ hooks: [{ type: 'command', command: cmd('stop'), timeout: ASYNC_TIMEOUT_S, async: true }] }],
      SubagentStart: sync('subagent-context'),
      SubagentStop: [{ hooks: [{ type: 'command', command: cmd('subagent-stop'), timeout: ASYNC_TIMEOUT_S, async: true }] }],
      PreCompact: sync('precompact'),
      PostCompact: sync('postcompact'),
      SessionEnd: sync('session-end', { timeout: SESSION_END_TIMEOUT_S }),
    },
  };
}

/** Count of (event, group, handler) hook tuples in the WHOLE file — the
 *  same basis the trust review and [hooks.state] use (file-scoped, not
 *  Cairn-scoped), so numerator and denominator always agree. */
export function codexHookCount(file: CodexHooksFile): number {
  return Object.values(file.hooks ?? {}).reduce(
    (sum, groups) => sum + groups.reduce((s, g) => s + g.hooks.length, 0), 0);
}

function isCairnGroup(group: CodexMatcherGroup): boolean {
  return group.hooks.some((h) => h.command.includes(CAIRN_HOOK_DIR_MARKER));
}

/** The sorted Cairn command strings in a hooks file — trust is hash-pinned
 *  per handler, so a changed command set means Codex will re-review. */
export function cairnCommandSet(file: Partial<CodexHooksFile>): string[] {
  const commands: string[] = [];
  for (const groups of Object.values(file.hooks ?? {})) {
    for (const g of groups) {
      for (const h of g.hooks) {
        if (h.command.includes(CAIRN_HOOK_DIR_MARKER)) commands.push(h.command);
      }
    }
  }
  return commands.sort();
}

/** Merge: per event keep non-Cairn groups, replace Cairn ones; foreign
 *  events untouched; description ours (it documents the trust step). */
export function mergeCodexHooks(existing: Partial<CodexHooksFile>, generated: CodexHooksFile): CodexHooksFile {
  const hooks: Record<string, CodexMatcherGroup[]> = { ...(existing.hooks ?? {}) };
  for (const [event, cairnGroups] of Object.entries(generated.hooks)) {
    const preserved = (hooks[event] ?? []).filter((g) => !isCairnGroup(g));
    hooks[event] = [...preserved, ...cairnGroups];
  }
  return { description: generated.description, hooks };
}

/** Append-only MCP registration. TOML LITERAL strings (no escape
 *  processing) so Windows backslashes survive; null when a path contains
 *  a single quote, which a literal string cannot express. */
export function codexMcpBlock(serverPath: string): string | null {
  if (process.execPath.includes("'") || serverPath.includes("'")) return null;
  return `\n[mcp_servers.cairn]\ncommand = '${process.execPath}'\nargs = ['${serverPath}']\n`;
}

/** True when config.toml already declares mcp_servers.cairn in ANY valid
 *  TOML form — appending a second declaration is a parse error that stops
 *  Codex from starting at all. Forms: [mcp_servers.cairn] header (bare or
 *  quoted), dotted top-level key, or a `cairn` key inside [mcp_servers]. */
export function hasCairnMcpServer(configToml: string): boolean {
  if (/^\s*\[mcp_servers\.(?:cairn|"cairn")\]/m.test(configToml)) return true;
  if (/^\s*mcp_servers\.(?:cairn|"cairn")\./m.test(configToml)) return true;
  const lines = configToml.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*\[mcp_servers\]\s*$/.test(lines[i])) continue;
    for (let j = i + 1; j < lines.length && !lines[j].trimStart().startsWith('['); j++) {
      if (/^\s*(?:cairn|"cairn")\s*[=.]/.test(lines[j])) return true;
    }
  }
  return false;
}

export interface TrustCount { trusted: number; disabled: number }

/** Count [hooks.state] entries for a hooks.json file via a scoped line scan.
 *  File-scoped like the state itself (Cairn and foreign hooks alike): an
 *  entry with trusted_hash counts as trusted unless enabled = false. */
export function countTrustedHooksIn(configToml: string, hooksJsonPath: string): TrustCount {
  const lines = configToml.split('\n');
  const result: TrustCount = { trusted: 0, disabled: 0 };
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes(`[hooks.state."${hooksJsonPath}:`)) continue;
    let hasHash = false;
    let disabled = false;
    for (let j = i + 1; j < lines.length && !lines[j].trimStart().startsWith('['); j++) {
      if (lines[j].includes('trusted_hash')) hasHash = true;
      if (/^\s*enabled\s*=\s*false/.test(lines[j])) disabled = true;
    }
    if (disabled) result.disabled++;
    else if (hasHash) result.trusted++;
  }
  return result;
}

/** Drop [hooks.state] sections for a hooks file whose commands changed —
 *  Codex can never match those hashes again, and leaving them makes the
 *  trust count lie. Same scoped line editing as the reader. */
export function pruneHookState(configToml: string, hooksJsonPath: string): string {
  const lines = configToml.split('\n');
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(`[hooks.state."${hooksJsonPath}:`)) {
      while (i + 1 < lines.length && !lines[i + 1].trimStart().startsWith('[')) i++;
      continue;
    }
    kept.push(lines[i]);
  }
  return kept.join('\n');
}

function atomicWrite(path: string, content: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, content, 'utf-8');
  renameSync(tmp, path);
}

function backupOnce(path: string): void {
  if (!existsSync(path)) return;
  const backup = `${path}.cairn-backup`;
  if (!existsSync(backup)) {
    copyFileSync(path, backup);
    console.log(`  ✓ backed up existing ${path} to ${backup}`);
  }
}

/** The Codex section of `cairn init`. Prints its own lines; never throws. */
export function runCodexInit(relayCmd: string, serverPath: string, dryRun: boolean, migrateRoutes = false): void {
  if (!existsSync(codexDir())) return;
  console.log(`\nCodex CLI (${codexHooksPath()}):`);

  let existing: Partial<CodexHooksFile> = {};
  if (existsSync(codexHooksPath())) {
    try {
      const parsed = JSON.parse(readFileSync(codexHooksPath(), 'utf-8')) as unknown;
      if (parsed === null || typeof parsed !== 'object') throw new Error('not a JSON object');
      existing = parsed as Partial<CodexHooksFile>;
    } catch (err) {
      // A broken hooks.json holds nothing worth preserving — init's job is
      // to produce a working config; the original survives in the backup.
      console.log(`  ! existing hooks.json is invalid (${(err as Error).message}) — rewriting it (backup kept)`);
      existing = {};
    }
  }

  let config = existsSync(codexConfigPath()) ? readFileSync(codexConfigPath(), 'utf-8') : '';
  const mcpRegistered = hasCairnMcpServer(config);
  const mcpBlock = mcpRegistered ? null : codexMcpBlock(serverPath);

  // Trust is hash-pinned to the exact command strings: a changed set means
  // Codex re-reviews, so "trusted" must never be reported across a change.
  const trustBefore = countTrustedHooksIn(config, codexHooksPath());
  const postToolRoute = postToolRouteFor(existing, trustBefore.trusted, migrateRoutes);
  const generated = codexHooks(relayCmd, postToolRoute);
  const merged = mergeCodexHooks(existing, generated);
  const total = codexHookCount(merged);

  const commandsChanged = existsSync(codexHooksPath())
    && JSON.stringify(cairnCommandSet(existing)) !== JSON.stringify(cairnCommandSet(generated));
  const invalidatesTrust = commandsChanged && trustBefore.trusted > 0;

  const wrote = dryRun ? 'would write' : 'writing';
  console.log(`  ✓ hooks.json — ${wrote} ${Object.keys(generated.hooks).length} Cairn hook events (${total} hooks total in file)`);
  if (postToolRoute === LEGACY_POST_TOOL_ROUTE) {
    console.log(`  = keeping deprecated '${LEGACY_POST_TOOL_ROUTE}' PostToolUse route — trusted wiring preserved.`);
    console.log(`    Migrate with \`cairn init --migrate-routes\` when convenient (one re-trust in codex).`);
  }
  if (mcpRegistered) {
    console.log('  = config.toml [mcp_servers.cairn] already registered');
  } else if (mcpBlock === null) {
    console.log(`  ! config.toml: a path contains a single quote, which init cannot express in TOML — add [mcp_servers.cairn] manually (command: ${process.execPath}, args: ["${serverPath}"])`);
  } else {
    console.log(`  ✓ config.toml [mcp_servers.cairn] — ${dryRun ? 'would append' : 'appending'}`);
  }

  if (!dryRun) {
    try {
      backupOnce(codexHooksPath());
      atomicWrite(codexHooksPath(), `${JSON.stringify(merged, null, 2)}\n`);
      if (mcpBlock !== null || invalidatesTrust) {
        backupOnce(codexConfigPath());
        let next = config;
        // Prune state entries the changed commands orphaned, so doctor's
        // trust report stays honest after this write.
        if (invalidatesTrust) next = pruneHookState(next, codexHooksPath());
        if (mcpBlock !== null) next = next + mcpBlock;
        atomicWrite(codexConfigPath(), next);
        config = next;
      }
    } catch (err) {
      console.log(`  ✗ could not write Codex config: ${(err as Error).message} — left untouched`);
      return;
    }
  }

  if (invalidatesTrust) {
    console.log(`  ! HOOK COMMANDS CHANGED — the ${trustBefore.trusted} previously trusted hook(s) are`);
    console.log(`    invalidated (Codex pins trust to exact commands). Start \`codex\` — the startup`);
    console.log(`    review will ask you to re-approve the Cairn hooks — then re-run \`cairn doctor\`.`);
    return;
  }
  const trust = countTrustedHooksIn(config, codexHooksPath());
  if (trust.trusted >= total && total > 0) {
    console.log(`  ✓ hooks trusted (${trust.trusted}/${total}${trust.disabled > 0 ? `, ${trust.disabled} disabled` : ''})`);
  } else {
    console.log(`  ! ONE-TIME TRUST STEP REQUIRED (${trust.trusted}/${total} trusted): Codex hash-pins hooks`);
    console.log(`    and silently skips them until you approve. Start \`codex\` — the startup review`);
    console.log(`    lists the Cairn memory hooks — accept them (or use /hooks). Re-run`);
    console.log(`    \`cairn doctor\` afterwards to confirm.`);
  }
}
