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
 * exactly what that review will show; hooks are silently skipped until the
 * user accepts them once.
 */
import { existsSync, readFileSync, writeFileSync, copyFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

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

/** Same identity marker init uses for Claude hooks. */
const CAIRN_HOOK_MARKER = 'dist/src/hooks/';

/** Codex clamps SessionEnd hook timeouts to 3s and warns above it. */
const SESSION_END_TIMEOUT_S = 3;
const SYNC_TIMEOUT_S = 10;
const ASYNC_TIMEOUT_S = 30;
/** Explicit so a Codex default change can't silently spill the briefing. */
const CONTEXT_LIMIT_TOKENS = 2500;

/** The canonical Codex hook set for this install's relay command. */
export function codexHooks(relayCmd: string): CodexHooksFile {
  const cmd = (sub: string): string => `${relayCmd} --client codex ${sub}`;
  const sync = (sub: string, extra: Partial<CodexHookCommand> = {}): CodexMatcherGroup[] =>
    [{ hooks: [{ type: 'command', command: cmd(sub), timeout: SYNC_TIMEOUT_S, ...extra }] }];
  return {
    description: 'Cairn memory hooks — passive briefing, ambient recall, pitfall warnings, auto-capture (same experience as Claude Code). Requires one interactive trust review at next Codex start.',
    hooks: {
      SessionStart: sync('session-start', { statusMessage: 'Cairn briefing', additionalContextLimit: CONTEXT_LIMIT_TOKENS }),
      UserPromptSubmit: sync('prompt-check', { additionalContextLimit: CONTEXT_LIMIT_TOKENS }),
      PreToolUse: [{ matcher: 'Bash|apply_patch', hooks: [{ type: 'command', command: cmd('pitfall-check'), timeout: SYNC_TIMEOUT_S }] }],
      PostToolUse: [{ matcher: 'Bash|apply_patch', hooks: [{ type: 'command', command: cmd('codex-post-tool'), timeout: ASYNC_TIMEOUT_S, async: true }] }],
      Stop: [{ hooks: [{ type: 'command', command: cmd('stop'), timeout: ASYNC_TIMEOUT_S, async: true }] }],
      SubagentStart: sync('subagent-context'),
      SubagentStop: [{ hooks: [{ type: 'command', command: cmd('subagent-stop'), timeout: ASYNC_TIMEOUT_S, async: true }] }],
      PreCompact: sync('precompact'),
      PostCompact: sync('postcompact'),
      SessionEnd: sync('session-end', { timeout: SESSION_END_TIMEOUT_S }),
    },
  };
}

/** Count of (event, group, handler) hook tuples — what the trust review shows. */
export function codexHookCount(file: CodexHooksFile): number {
  return Object.values(file.hooks).reduce(
    (sum, groups) => sum + groups.reduce((s, g) => s + g.hooks.length, 0), 0);
}

function isCairnGroup(group: CodexMatcherGroup): boolean {
  return group.hooks.some((h) => h.command.includes(CAIRN_HOOK_MARKER));
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

/** Append-only MCP registration: valid TOML at EOF, no parser needed. */
export function codexMcpBlock(serverPath: string): string {
  return `\n[mcp_servers.cairn]\ncommand = "${process.execPath}"\nargs = ["${serverPath}"]\n`;
}

export function hasCairnMcpServer(configToml: string): boolean {
  return /^\s*\[mcp_servers\.cairn\]/m.test(configToml);
}

/** Count trusted Cairn hook entries in [hooks.state] via a scoped line scan
 *  (keys are "<abs hooks.json path>:<event>:<group>:<handler>"). Codex
 *  invalidates trust on command change, so a count below the hook total
 *  means the review (or re-review) is pending. */
export function countTrustedCairnHooks(configToml: string, hooksJsonPath: string): number {
  const lines = configToml.split('\n');
  let count = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes(`[hooks.state."${hooksJsonPath}:`)) continue;
    // trusted_hash sits inside the section — scan until the next header.
    for (let j = i + 1; j < lines.length && !lines[j].trimStart().startsWith('['); j++) {
      if (lines[j].includes('trusted_hash')) { count++; break; }
    }
  }
  return count;
}

function atomicWrite(path: string, content: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, content, 'utf-8');
  renameSync(tmp, path);
}

function backupOnce(path: string, log: (line: string) => void): void {
  if (!existsSync(path)) return;
  const backup = `${path}.cairn-backup`;
  if (!existsSync(backup)) {
    copyFileSync(path, backup);
    log(`  ✓ backed up existing ${path} to ${backup}`);
  }
}

/** The Codex section of `cairn init`. Prints its own lines; never throws. */
export function runCodexInit(relayCmd: string, serverPath: string, dryRun: boolean): void {
  if (!existsSync(codexDir())) return;
  console.log(`\nCodex CLI (${codexHooksPath()}):`);

  const generated = codexHooks(relayCmd);
  let existing: Partial<CodexHooksFile> = {};
  try {
    if (existsSync(codexHooksPath())) {
      existing = JSON.parse(readFileSync(codexHooksPath(), 'utf-8')) as Partial<CodexHooksFile>;
    }
  } catch (err) {
    console.log(`  ✗ could not parse existing hooks.json (${(err as Error).message}) — left untouched`);
    return;
  }
  const merged = mergeCodexHooks(existing, generated);

  const config = existsSync(codexConfigPath()) ? readFileSync(codexConfigPath(), 'utf-8') : '';
  const needsMcp = !hasCairnMcpServer(config);

  console.log(`  ✓ hooks.json (${codexHookCount(generated)} Cairn hooks across ${Object.keys(generated.hooks).length} events)`);
  console.log(needsMcp
    ? '  ✓ config.toml [mcp_servers.cairn] (appended)'
    : '  = config.toml [mcp_servers.cairn] already registered');

  if (!dryRun) {
    backupOnce(codexHooksPath(), (l) => console.log(l));
    atomicWrite(codexHooksPath(), `${JSON.stringify(merged, null, 2)}\n`);
    if (needsMcp) {
      backupOnce(codexConfigPath(), (l) => console.log(l));
      atomicWrite(codexConfigPath(), config + codexMcpBlock(serverPath));
    }
  }

  const trusted = countTrustedCairnHooks(config, codexHooksPath());
  const total = codexHookCount(generated);
  if (trusted >= total) {
    console.log(`  ✓ hooks trusted (${trusted}/${total})`);
  } else {
    console.log(`  ! ONE-TIME TRUST STEP REQUIRED (${trusted}/${total} trusted): Codex hash-pins hooks`);
    console.log(`    and silently skips them until you approve. Start \`codex\` — the startup review`);
    console.log(`    lists the ${total} "Cairn memory hooks" — accept them (or use /hooks). Re-run`);
    console.log(`    \`cairn doctor\` afterwards to confirm.`);
  }
}
