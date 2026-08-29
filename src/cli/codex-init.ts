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
 * Which PostToolUse route to generate. The canonical `post-tool` always,
 * EXCEPT when the EXACT legacy command this install would re-emit is
 * currently trusted — only then does preservation actually preserve
 * anything (trust is hash-pinned to the exact command string; a legacy
 * command with a different relay prefix re-reviews regardless, so that
 * re-trust rides the migration for free). Per-command trust matters: a
 * trusted foreign hook or an already-trusted canonical route must not
 * make an untrusted legacy command look preservation-worthy. Migration
 * is otherwise an explicit opt-in (`cairn init --migrate-routes`).
 */
export function postToolRouteFor(
  trustedCommands: readonly string[],
  candidateLegacyCommand: string,
  migrateRoutes: boolean,
): PostToolRoute {
  if (migrateRoutes) return POST_TOOL_ROUTE;
  return trustedCommands.includes(candidateLegacyCommand) ? LEGACY_POST_TOOL_ROUTE : POST_TOOL_ROUTE;
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

/**
 * Merge, POSITION-STABLE: Codex pins trust to (event, group, handler)
 * INDICES as well as command hashes, so a merge that reorders groups
 * silently invalidates trust for every shifted hook — including foreign
 * ones — without changing any command. Therefore: the first all-Cairn
 * group is replaced IN PLACE; extra all-Cairn groups are dropped; a
 * mixed group keeps its foreign handlers (Cairn handlers stripped) at
 * its original index; a file with no Cairn group appends at the end.
 * Foreign events untouched; description ours (documents the trust step).
 */
export function mergeCodexHooks(existing: Partial<CodexHooksFile>, generated: CodexHooksFile): CodexHooksFile {
  const hooks: Record<string, CodexMatcherGroup[]> = { ...(existing.hooks ?? {}) };
  for (const [event, cairnGroups] of Object.entries(generated.hooks)) {
    const merged: CodexMatcherGroup[] = [];
    let placed = false;
    for (const group of hooks[event] ?? []) {
      const foreign = group.hooks.filter((h) => !h.command.includes(CAIRN_HOOK_DIR_MARKER));
      if (foreign.length === group.hooks.length) {
        merged.push(group); // purely foreign — untouched
      } else if (foreign.length > 0) {
        merged.push({ ...group, hooks: foreign }); // mixed — keep the foreign handlers, same slot
      } else if (!placed) {
        merged.push(...cairnGroups); // first all-Cairn slot — replace in place
        placed = true;
      }
      // later all-Cairn groups: dropped (stale duplicates)
    }
    if (!placed) merged.push(...cairnGroups);
    hooks[event] = merged;
  }
  return { description: generated.description, hooks };
}

/** Codex trust-state keys use the snake_case event name. */
function snakeEvent(event: string): string {
  return event.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

export interface TrustStateEntry {
  /** The full quoted section key: `<hooksPath>:<snake_event>:<group>:<handler>`. */
  key: string;
  event: string;
  group: number;
  handler: number;
  trusted: boolean;
  disabled: boolean;
}

/** Parse every [hooks.state] section for a hooks file into structured
 *  entries — the join point between config.toml trust and hooks.json
 *  positions. Same scoped line scan as the counters. */
export function parseTrustState(configToml: string, hooksJsonPath: string): TrustStateEntry[] {
  const lines = configToml.split('\n');
  const entries: TrustStateEntry[] = [];
  const keyRe = new RegExp(`\\[hooks\\.state\\."(${hooksJsonPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:([a-z0-9_]+):(\\d+):(\\d+))"\\]`);
  for (let i = 0; i < lines.length; i++) {
    const m = keyRe.exec(lines[i]);
    if (!m) continue;
    let trusted = false;
    let disabled = false;
    for (let j = i + 1; j < lines.length && !lines[j].trimStart().startsWith('['); j++) {
      if (lines[j].includes('trusted_hash')) trusted = true;
      if (/^\s*enabled\s*=\s*false/.test(lines[j])) disabled = true;
    }
    entries.push({ key: m[1], event: m[2], group: Number(m[3]), handler: Number(m[4]), trusted: trusted && !disabled, disabled });
  }
  return entries;
}

/** The command a trust entry's pinned position resolves to in a hooks
 *  file, or null when the position no longer exists. */
export function commandAt(file: Partial<CodexHooksFile>, entry: Pick<TrustStateEntry, 'event' | 'group' | 'handler'>): string | null {
  for (const [event, groups] of Object.entries(file.hooks ?? {})) {
    if (snakeEvent(event) !== entry.event) continue;
    return groups[entry.group]?.hooks[entry.handler]?.command ?? null;
  }
  return null;
}

/**
 * Trust shadow: `trusted_hash` pins a command VALUE we cannot recompute
 * (the hash inputs are Codex-internal), so the position join alone would
 * attribute a stale hash to whatever command now occupies the position —
 * e.g. after a hand-edit of hooks.json. The shadow records what each
 * position held at OUR last write; a Cairn command that no longer matches
 * its shadow entry is treated as untrusted (fail-safe: the worst case is
 * an unnecessary "trust step required", never a false "trusted"). Foreign
 * commands are not ours to attest and keep position-join semantics.
 * Absent/invalid shadow (pre-shadow installs) means tolerant behavior.
 */
export function trustShadowPath(): string { return join(codexDir(), '.cairn-trust-shadow.json'); }

export function readTrustShadow(): Record<string, string> | null {
  try {
    const parsed = JSON.parse(readFileSync(trustShadowPath(), 'utf-8')) as { v?: number; positions?: unknown };
    if (parsed.v !== 1 || parsed.positions === null || typeof parsed.positions !== 'object') return null;
    const positions = parsed.positions as Record<string, unknown>;
    for (const value of Object.values(positions)) {
      if (typeof value !== 'string') return null;
    }
    return positions as Record<string, string>;
  } catch {
    return null;
  }
}

/** Snapshot every (position key → command) of the file just written.
 *  Best-effort: a shadow write failure must never fail init (it only
 *  costs tolerance, not correctness). */
export function writeTrustShadow(hooksJsonPath: string, file: CodexHooksFile): void {
  try {
    const positions: Record<string, string> = {};
    for (const [event, groups] of Object.entries(file.hooks ?? {})) {
      groups.forEach((group, g) => {
        group.hooks.forEach((hook, h) => {
          positions[`${hooksJsonPath}:${snakeEvent(event)}:${g}:${h}`] = hook.command;
        });
      });
    }
    atomicWrite(trustShadowPath(), `${JSON.stringify({ v: 1, positions }, null, 2)}\n`);
  } catch { /* tolerated — see doc comment */ }
}

/** The command strings whose pinned positions currently hold live trust
 *  (trusted_hash, not disabled), shadow-attested for Cairn commands —
 *  per-command trust, which the file-wide counters cannot give. */
export function trustedCommandsIn(configToml: string, hooksJsonPath: string, file: Partial<CodexHooksFile>): string[] {
  const shadow = readTrustShadow();
  const out: string[] = [];
  for (const entry of parseTrustState(configToml, hooksJsonPath)) {
    if (!entry.trusted) continue;
    const cmd = commandAt(file, entry);
    if (cmd === null) continue;
    if (shadow !== null && cmd.includes(CAIRN_HOOK_DIR_MARKER) && shadow[entry.key] !== cmd) continue;
    out.push(cmd);
  }
  return out;
}

/** Remove exactly the [hooks.state] sections named by `keys` — scoped
 *  pruning, so invalidating one changed Cairn command never wipes the
 *  trust of unrelated (foreign) hooks sharing the file. */
export function pruneTrustKeys(configToml: string, keys: ReadonlySet<string>): string {
  if (keys.size === 0) return configToml;
  const lines = configToml.split('\n');
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /\[hooks\.state\."([^"]+)"\]/.exec(lines[i]);
    if (m && keys.has(m[1])) {
      while (i + 1 < lines.length && !lines[i + 1].trimStart().startsWith('[')) i++;
      continue;
    }
    kept.push(lines[i]);
  }
  return kept.join('\n');
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

/** Count [hooks.state] entries for a hooks.json file. File-scoped like
 *  the state itself (Cairn and foreign hooks alike): an entry with
 *  trusted_hash counts as trusted unless enabled = false. Derived from
 *  parseTrustState — ONE parser: if Codex ever changes the key shape,
 *  decisions AND displayed counts go to zero together, which reads as
 *  "trust step required" (fail-safe) instead of a stale "10/10 trusted"
 *  while the strict decision path sees nothing (fail-green). */
export function countTrustedHooksIn(configToml: string, hooksJsonPath: string, file?: Partial<CodexHooksFile>): TrustCount {
  const entries = parseTrustState(configToml, hooksJsonPath);
  const shadow = file === undefined ? null : readTrustShadow();
  const trusted = (e: TrustStateEntry): boolean => {
    if (!e.trusted) return false;
    if (file === undefined) return true; // no join context — raw count
    const cmd = commandAt(file, e);
    if (cmd === null) return false; // stale position can never re-match
    if (shadow !== null && cmd.includes(CAIRN_HOOK_DIR_MARKER) && shadow[e.key] !== cmd) return false;
    return true;
  };
  return {
    trusted: entries.filter(trusted).length,
    disabled: entries.filter((e) => e.disabled).length,
  };
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

  const trustEntries = parseTrustState(config, codexHooksPath());
  // The legacy command THIS relay would emit — built through the
  // generator so the comparison can never drift from the emitted format.
  const candidateLegacy = codexHooks(relayCmd, LEGACY_POST_TOOL_ROUTE).hooks.PostToolUse[0].hooks[0].command;
  const postToolRoute = postToolRouteFor(
    trustedCommandsIn(config, codexHooksPath(), existing), candidateLegacy, migrateRoutes);
  const generated = codexHooks(relayCmd, postToolRoute);
  const merged = mergeCodexHooks(existing, generated);
  const total = codexHookCount(merged);

  // Trust is hash-pinned per (event, group, handler) POSITION: any state
  // entry whose pinned position now resolves to a different command (or
  // to none) can never hash-match again — prune exactly those, keeping
  // the trust of unrelated hooks that kept their position and command.
  // DISABLED entries are never pruned: `enabled = false` is the user's
  // recorded decision, and erasing it would present the hook as a fresh
  // approval at the next Codex review — an approve-all would re-enable
  // what they deliberately turned off. A kept disabled entry is inert
  // (the hook stays off) and is reported as disabled, never trusted.
  const oldShadow = readTrustShadow();
  const invalidated = trustEntries.filter((e) => {
    if (e.disabled) return false;
    if (commandAt(merged, e) !== commandAt(existing, e)) return true;
    // LAUNDERING GUARD: an externally reordered hooks.json is identical
    // between `existing` and `merged`, so there is no command delta — but
    // a Cairn position whose command mismatches what our LAST init
    // recorded there carries a hash we cannot vouch for. Without pruning
    // it here, the unconditional shadow refresh after the write would
    // re-attest it (reproduced: a swapped foreign group left its stale
    // hash counted as trust for Cairn's session-start).
    const cmd = commandAt(merged, e);
    return oldShadow !== null && cmd !== null
      && cmd.includes(CAIRN_HOOK_DIR_MARKER) && oldShadow[e.key] !== cmd;
  });
  const invalidatesTrust = invalidated.some((e) => e.trusted);

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
    // Config FIRST, hooks.json second: a failure between the two writes
    // must land fail-safe (trust pruned, old commands kept — an honest
    // re-review), never fail-green (new commands installed while stale
    // hashes still count as "trusted" and Codex silently skips them).
    let wroteConfig = false;
    try {
      if (mcpBlock !== null || invalidated.length > 0) {
        backupOnce(codexConfigPath());
        let next = pruneTrustKeys(config, new Set(invalidated.map((e) => e.key)));
        if (mcpBlock !== null) next = next + mcpBlock;
        atomicWrite(codexConfigPath(), next);
        config = next;
        wroteConfig = true;
      }
      backupOnce(codexHooksPath());
      atomicWrite(codexHooksPath(), `${JSON.stringify(merged, null, 2)}\n`);
      writeTrustShadow(codexHooksPath(), merged);
    } catch (err) {
      console.log(`  ✗ could not write Codex configuration: ${(err as Error).message} — ${
        wroteConfig
          ? 'config.toml was updated but hooks.json was NOT; re-run `cairn init` (hooks re-review pending either way)'
          : 'nothing was changed'}`);
      return;
    }
  }

  if (invalidatesTrust) {
    const count = invalidated.filter((e) => e.trusted).length;
    console.log(`  ! HOOK TRUST INVALIDATED — ${count} previously trusted hook(s) changed or moved`);
    console.log(`    (Codex pins trust to exact commands; unrelated hooks keep their trust).`);
    console.log(`    Start \`codex\` — the startup review will ask you to re-approve the changed`);
    console.log(`    Cairn hooks — then re-run \`cairn doctor\`.`);
    return;
  }
  const trust = countTrustedHooksIn(config, codexHooksPath(), merged);
  if (trust.trusted >= total && total > 0) {
    console.log(`  ✓ hooks trusted (${trust.trusted}/${total}${trust.disabled > 0 ? `, ${trust.disabled} disabled` : ''})`);
  } else {
    console.log(`  ! ONE-TIME TRUST STEP REQUIRED (${trust.trusted}/${total} trusted): Codex hash-pins hooks`);
    console.log(`    and silently skips them until you approve. Start \`codex\` — the startup review`);
    console.log(`    lists the Cairn memory hooks — accept them (or use /hooks). Re-run`);
    console.log(`    \`cairn doctor\` afterwards to confirm.`);
  }
}
