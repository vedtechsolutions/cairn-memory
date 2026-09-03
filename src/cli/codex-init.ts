/**
 * Codex CLI wiring for `waykeep init` / `waykeep doctor` (parity step 5).
 *
 * Generates ~/.codex/hooks.json from this install's resolved relay (every
 * event through `hook-relay --client codex`, mirroring the Claude wiring),
 * merges it idempotently (non-Waykeep hook groups preserved), and registers
 * the MCP server in ~/.codex/config.toml by appending a table when absent —
 * a scoped line-level edit, deliberately no TOML dependency.
 *
 * Trust is the one step init cannot do: Codex hash-pins every non-managed
 * hook and runs an interactive review before executing it. Init prints
 * exactly what that review will show, warns when a command change is about
 * to invalidate existing trust, and hooks are silently skipped until the
 * user accepts them.
 */
import { existsSync, readFileSync, copyFileSync } from 'node:fs';
import { writeFileAtomic } from '../utils/atomic-write.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CLIENT_CODEX } from '../constants/clients.js';
import { isWaykeepHookCommand } from '../constants/index.js';
import { ENV } from '../constants/env.js';
import { FILES, BACKUP_SUFFIX } from '../constants/paths.js';
import { MCP_SERVER_NAME } from '../constants/mcp.js';
import { LEGACY_NAMESPACES } from 'waykeep-contract';
import { parse as parseToml } from 'smol-toml';
import { isDeepStrictEqual } from 'node:util';
import { CODEX } from '../constants/codex.js';

/** ~/.codex, overridable for hermetic tests. */
export function codexDir(): string {
  return process.env[ENV.CODEX_DIR] ?? join(homedir(), CODEX.CONFIG_DIR);
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
 * is otherwise an explicit opt-in (`waykeep init --migrate-routes`).
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
    [{ hooks: [{ type: 'command', command: cmd(sub), timeout: CODEX.HOOK_TIMEOUT_S.SYNC, ...extra }] }];
  return {
    description: 'Waykeep memory hooks — passive briefing, ambient recall, pitfall warnings, auto-capture (same experience as Claude Code). Requires one interactive trust review at next Codex start.',
    hooks: {
      SessionStart: sync('session-start', { statusMessage: 'Waykeep briefing', additionalContextLimit: CODEX.CONTEXT_LIMIT_TOKENS }),
      UserPromptSubmit: sync('prompt-check', { additionalContextLimit: CODEX.CONTEXT_LIMIT_TOKENS }),
      PreToolUse: [{ matcher: 'Bash|apply_patch', hooks: [{ type: 'command', command: cmd('pitfall-check'), timeout: CODEX.HOOK_TIMEOUT_S.SYNC }] }],
      PostToolUse: [{ matcher: 'Bash|apply_patch', hooks: [{ type: 'command', command: cmd(postToolRoute), timeout: CODEX.HOOK_TIMEOUT_S.ASYNC, async: true }] }],
      Stop: [{ hooks: [{ type: 'command', command: cmd('stop'), timeout: CODEX.HOOK_TIMEOUT_S.ASYNC, async: true }] }],
      SubagentStart: sync('subagent-context'),
      SubagentStop: [{ hooks: [{ type: 'command', command: cmd('subagent-stop'), timeout: CODEX.HOOK_TIMEOUT_S.ASYNC, async: true }] }],
      PreCompact: sync('precompact'),
      PostCompact: sync('postcompact'),
      SessionEnd: sync('session-end', { timeout: CODEX.HOOK_TIMEOUT_S.SESSION_END }),
    },
  };
}

/** Count of (event, group, handler) hook tuples in the WHOLE file — the
 *  same basis the trust review and [hooks.state] use (file-scoped, not
 *  Waykeep-scoped), so numerator and denominator always agree. */
export function codexHookCount(file: CodexHooksFile): number {
  return Object.values(file.hooks ?? {}).reduce(
    (sum, groups) => sum + groups.reduce((s, g) => s + g.hooks.length, 0), 0);
}

/** The sorted Waykeep command strings in a hooks file — trust is hash-pinned
 *  per handler, so a changed command set means Codex will re-review. */
export function waykeepCommandSet(file: Partial<CodexHooksFile>): string[] {
  const commands: string[] = [];
  for (const groups of Object.values(file.hooks ?? {})) {
    for (const g of groups) {
      for (const h of g.hooks) {
        if (isWaykeepHookCommand(h.command)) commands.push(h.command);
      }
    }
  }
  return commands.sort();
}

/**
 * Merge, POSITION-STABLE: Codex pins trust to (event, group, handler)
 * INDICES as well as command hashes, so a merge that reorders groups
 * silently invalidates trust for every shifted hook — including foreign
 * ones — without changing any command. Therefore: the first all-Waykeep
 * group is replaced IN PLACE; extra all-Waykeep groups are dropped; a
 * mixed group keeps its foreign handlers (Waykeep handlers stripped) at
 * its original index; a file with no Waykeep group appends at the end.
 * Foreign events untouched; description ours (documents the trust step).
 */
export function mergeCodexHooks(existing: Partial<CodexHooksFile>, generated: CodexHooksFile): CodexHooksFile {
  const hooks: Record<string, CodexMatcherGroup[]> = { ...(existing.hooks ?? {}) };
  for (const [event, waykeepGroups] of Object.entries(generated.hooks)) {
    const merged: CodexMatcherGroup[] = [];
    let placed = false;
    for (const group of hooks[event] ?? []) {
      const foreign = group.hooks.filter((h) => !isWaykeepHookCommand(h.command));
      if (foreign.length === group.hooks.length) {
        merged.push(group); // purely foreign — untouched
      } else if (foreign.length > 0) {
        merged.push({ ...group, hooks: foreign }); // mixed — keep the foreign handlers, same slot
      } else if (!placed) {
        merged.push(...waykeepGroups); // first all-Waykeep slot — replace in place
        placed = true;
      }
      // later all-Waykeep groups: dropped (stale duplicates)
    }
    if (!placed) merged.push(...waykeepGroups);
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
 * position held at OUR last write; a Waykeep command that no longer matches
 * its shadow entry is treated as untrusted (fail-safe: the worst case is
 * an unnecessary "trust step required", never a false "trusted"). Foreign
 * commands are not ours to attest and keep position-join semantics.
 * Absent/invalid shadow (pre-shadow installs) means tolerant behavior.
 */
export function trustShadowPath(): string { return join(codexDir(), FILES.TRUST_SHADOW); }

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
    writeFileAtomic(trustShadowPath(), `${JSON.stringify({ v: 1, positions }, null, 2)}\n`);
  } catch { /* tolerated — see doc comment */ }
}

/** The command strings whose pinned positions currently hold live trust
 *  (trusted_hash, not disabled), shadow-attested for Waykeep commands —
 *  per-command trust, which the file-wide counters cannot give. */
export function trustedCommandsIn(configToml: string, hooksJsonPath: string, file: Partial<CodexHooksFile>): string[] {
  const shadow = readTrustShadow();
  const out: string[] = [];
  for (const entry of parseTrustState(configToml, hooksJsonPath)) {
    if (!entry.trusted) continue;
    const cmd = commandAt(file, entry);
    if (cmd === null) continue;
    if (shadow !== null && isWaykeepHookCommand(cmd) && shadow[entry.key] !== cmd) continue;
    out.push(cmd);
  }
  return out;
}

/** Remove exactly the [hooks.state] sections named by `keys` — scoped
 *  pruning, so invalidating one changed Waykeep command never wipes the
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
  return `\n[mcp_servers.${MCP_SERVER_NAME}]\ncommand = '${process.execPath}'\nargs = ['${serverPath}']\n`;
}

/** True when `configToml` is syntactically valid TOML. Init must NOT append an
 *  MCP block to a config it cannot parse — that would compound a broken file. */
export function configTomlParses(configToml: string): boolean {
  try { parseToml(configToml); return true; } catch { return false; }
}

/**
 * Verify a `pruneTrustKeys` result removed ONLY the intended `hooks.state` keys
 * and altered NOTHING else. pruneTrustKeys is line-based, so a `[hooks.state.…]`
 * -shaped line inside a user's MULTILINE STRING could be deleted while leaving
 * syntactically-valid TOML — a silent edit a re-parse alone would miss (codex
 * B1 review). We parse both sides, delete the intended keys from the BEFORE
 * object, and deep-compare: any remaining difference means the prune touched
 * something it should not have, so the caller refuses to write.
 */
export function pruneRemovedOnly(before: string, after: string, removedKeys: ReadonlySet<string>): boolean {
  let b: Record<string, unknown>, a: Record<string, unknown>;
  try { b = parseToml(before) as Record<string, unknown>; a = parseToml(after) as Record<string, unknown>; }
  catch { return false; }
  const hooks = b['hooks'];
  if (hooks && typeof hooks === 'object') {
    const state = (hooks as Record<string, unknown>)['state'];
    if (state && typeof state === 'object') {
      for (const k of removedKeys) delete (state as Record<string, unknown>)[k];
      if (Object.keys(state as object).length === 0) delete (hooks as Record<string, unknown>)['state'];
      if (Object.keys(hooks as object).length === 0) delete b['hooks'];
    }
  }
  return isDeepStrictEqual(b, a);
}

/**
 * True when config.toml declares the `mcp_servers.<name>` server in ANY valid
 * TOML form — appending a duplicate is a parse error that stops Codex starting.
 *
 * Parsed with a REAL TOML parser (smol-toml), because a hand-rolled reader kept
 * missing valid forms across many review rounds — nested inline tables (a
 * `waykeep` key under some OTHER server's `env`), unicode-escaped quoted keys
 * (`"waykeep"`), array-of-tables, comments, quoting and whitespace (codex
 * B1 review). The parser resolves the full key structure, so we simply check
 * `mcp_servers.<name>` as an own property. Unparseable TOML returns false — the
 * caller (runCodexInit) checks `configTomlParses` and refuses to append there.
 */
function configDeclaresMcpServer(configToml: string, name: string): boolean {
  let parsed: unknown;
  try { parsed = parseToml(configToml); } catch { return false; }
  const servers = (parsed as { mcp_servers?: unknown } | null)?.mcp_servers;
  return typeof servers === 'object' && servers !== null
    && Object.prototype.hasOwnProperty.call(servers, name);
}

export function hasWaykeepMcpServer(configToml: string): boolean {
  return configDeclaresMcpServer(configToml, MCP_SERVER_NAME);
}

/** Retired-namespace MCP servers (e.g. `cairn`) still declared in config.toml.
 *  Unlike the Claude JSON config, this tool is append-only for Codex's TOML
 *  (splicing an existing section risks corrupting hand-written config), so an
 *  upgraded install may still carry a legacy `[mcp_servers.cairn]` that starts
 *  a duplicate server under the retired name. We DETECT and warn rather than
 *  silently leave it (codex B1 review); the user removes it in one edit. */
export function detectLegacyMcpServers(configToml: string): string[] {
  return LEGACY_NAMESPACES.filter(ns => configDeclaresMcpServer(configToml, ns));
}

export interface TrustCount { trusted: number; disabled: number }

/** Count [hooks.state] entries for a hooks.json file. File-scoped like
 *  the state itself (Waykeep and foreign hooks alike): an entry with
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
    if (shadow !== null && isWaykeepHookCommand(cmd) && shadow[e.key] !== cmd) return false;
    return true;
  };
  return {
    trusted: entries.filter(trusted).length,
    disabled: entries.filter((e) => e.disabled).length,
  };
}

function backupOnce(path: string): void {
  if (!existsSync(path)) return;
  const backup = `${path}${BACKUP_SUFFIX}`;
  if (!existsSync(backup)) {
    copyFileSync(path, backup);
    console.log(`  ✓ backed up existing ${path} to ${backup}`);
  }
}

/** The Codex section of `waykeep init`. Prints its own lines; never throws. */
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
  // Never append an MCP block into TOML we cannot parse — that compounds a
  // broken file. An empty config is trivially fine (codex B1 review).
  const configParses = config.trim().length === 0 || configTomlParses(config);
  const mcpRegistered = configParses && hasWaykeepMcpServer(config);
  const candidateBlock = (mcpRegistered || !configParses) ? null : codexMcpBlock(serverPath);
  // Even with the server ABSENT, appending `[mcp_servers.<name>]` can produce
  // INVALID TOML when `mcp_servers` is a foreign INLINE table (which cannot be
  // extended by a section) — verify the concatenation parses before committing
  // to it, or init would corrupt a valid config (codex B1 review).
  const mcpAppendUnsafe = candidateBlock !== null && !configTomlParses(config + candidateBlock);
  const mcpBlock = mcpAppendUnsafe ? null : candidateBlock;

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
    // a Waykeep position whose command mismatches what our LAST init
    // recorded there carries a hash we cannot vouch for. Without pruning
    // it here, the unconditional shadow refresh after the write would
    // re-attest it (reproduced: a swapped foreign group left its stale
    // hash counted as trust for Waykeep's session-start).
    const cmd = commandAt(merged, e);
    return oldShadow !== null && cmd !== null
      && isWaykeepHookCommand(cmd) && oldShadow[e.key] !== cmd;
  });
  const invalidatesTrust = invalidated.some((e) => e.trusted);

  const wrote = dryRun ? 'would write' : 'writing';
  console.log(`  ✓ hooks.json — ${wrote} ${Object.keys(generated.hooks).length} Waykeep hook events (${total} hooks total in file)`);
  if (postToolRoute === LEGACY_POST_TOOL_ROUTE) {
    console.log(`  = keeping deprecated '${LEGACY_POST_TOOL_ROUTE}' PostToolUse route — trusted wiring preserved.`);
    console.log(`    Migrate with \`waykeep init --migrate-routes\` when convenient (one re-trust in codex).`);
  }
  if (!configParses) {
    console.log(`  ! config.toml is not valid TOML — init will NOT modify it. Fix the syntax, then re-run to add [mcp_servers.${MCP_SERVER_NAME}] (command: ${process.execPath}, args: ["${serverPath}"])`);
  } else if (mcpRegistered) {
    console.log(`  = config.toml [mcp_servers.${MCP_SERVER_NAME}] already registered`);
  } else if (mcpAppendUnsafe) {
    console.log(`  ! config.toml declares mcp_servers as an inline table that a [mcp_servers.${MCP_SERVER_NAME}] section cannot extend — add ${MCP_SERVER_NAME} to that inline table manually (command: ${process.execPath}, args: ["${serverPath}"])`);
  } else if (mcpBlock === null) {
    console.log(`  ! config.toml: a path contains a single quote, which init cannot express in TOML — add [mcp_servers.${MCP_SERVER_NAME}] manually (command: ${process.execPath}, args: ["${serverPath}"])`);
  } else {
    console.log(`  ✓ config.toml [mcp_servers.${MCP_SERVER_NAME}] — ${dryRun ? 'would append' : 'appending'}`);
  }
  for (const ns of detectLegacyMcpServers(config)) {
    console.log(`  ! config.toml still declares the retired [mcp_servers.${ns}] — it starts a duplicate server under the old namespace. Remove that block manually (this tool won't rewrite existing TOML).`);
  }

  if (!dryRun) {
    // Config FIRST, hooks.json second: a failure between the two writes
    // must land fail-safe (trust pruned, old commands kept — an honest
    // re-review), never fail-green (new commands installed while stale
    // hashes still count as "trusted" and Codex silently skips them).
    let wroteConfig = false;
    try {
      // Never rewrite a config we could not parse — the "will NOT modify it"
      // promise covers the trust-prune path too, not just the MCP append
      // (codex B1 review): pruneTrustKeys on invalid TOML would mangle it.
      if (configParses && (mcpBlock !== null || invalidated.length > 0)) {
        const removedKeys = new Set(invalidated.map((e) => e.key));
        const pruned = pruneTrustKeys(config, removedKeys);
        const next = mcpBlock !== null ? pruned + mcpBlock : pruned;
        // Two guards before committing (codex B1 review): (1) the prune removed
        // ONLY the intended trust keys and mangled nothing else — a line-based
        // edit could delete a `[hooks.state…]`-shaped line inside a user's
        // multiline string while STILL parsing; (2) the FINAL text re-parses
        // (append safety). Fail either → leave the config untouched.
        if (pruneRemovedOnly(config, pruned, removedKeys) && configTomlParses(next)) {
          backupOnce(codexConfigPath());
          writeFileAtomic(codexConfigPath(), next);
          config = next;
          wroteConfig = true;
        } else {
          console.log(`  ! config.toml left UNCHANGED — the trust-prune/append would alter or invalidate it (edit it by hand). Re-run \`waykeep init\` afterward.`);
        }
      }
      backupOnce(codexHooksPath());
      writeFileAtomic(codexHooksPath(), `${JSON.stringify(merged, null, 2)}\n`);
      writeTrustShadow(codexHooksPath(), merged);
    } catch (err) {
      console.log(`  ✗ could not write Codex configuration: ${(err as Error).message} — ${
        wroteConfig
          ? 'config.toml was updated but hooks.json was NOT; re-run `waykeep init` (hooks re-review pending either way)'
          : 'nothing was changed'}`);
      return;
    }
  }

  if (invalidatesTrust) {
    const count = invalidated.filter((e) => e.trusted).length;
    console.log(`  ! HOOK TRUST INVALIDATED — ${count} previously trusted hook(s) changed or moved`);
    console.log(`    (Codex pins trust to exact commands; unrelated hooks keep their trust).`);
    console.log(`    Start \`codex\` — the startup review will ask you to re-approve the changed`);
    console.log(`    Waykeep hooks — then re-run \`waykeep doctor\`.`);
    return;
  }
  const trust = countTrustedHooksIn(config, codexHooksPath(), merged);
  if (trust.trusted >= total && total > 0) {
    console.log(`  ✓ hooks trusted (${trust.trusted}/${total}${trust.disabled > 0 ? `, ${trust.disabled} disabled` : ''})`);
  } else {
    console.log(`  ! ONE-TIME TRUST STEP REQUIRED (${trust.trusted}/${total} trusted): Codex hash-pins hooks`);
    console.log(`    and silently skips them until you approve. Start \`codex\` — the startup review`);
    console.log(`    lists the Waykeep memory hooks — accept them (or use /hooks). Re-run`);
    console.log(`    \`waykeep doctor\` afterwards to confirm.`);
  }
}
