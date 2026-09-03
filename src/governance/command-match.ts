import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { NormalizedCommandForm, NormalizedGate } from './gate-config.js';
import { GOVERNANCE_BOUNDS } from '../constants/index.js';

export type CommandMismatchReason =
  | 'invalid_command'
  | 'argv_mismatch'
  | 'cwd_mismatch'
  | 'env_mismatch';

export type TokenizeResult =
  | { ok: true; argv: string[] }
  | { ok: false; reason: string };

export interface ObservedCommand {
  command?: string;
  argv?: readonly string[];
  cwd: string;
  environment?: Readonly<Record<string, string | undefined>>;
}

export interface CommandMatchContext {
  projectRoot: string;
  expectedEnvironment?: Readonly<Record<string, string | undefined>>;
}

export type CommandMatchResult =
  | {
      matched: true;
      form: 'primary' | 'alias';
      aliasIndex: number | null;
      argv: string[];
      cwd: string;
    }
  | { matched: false; reason: CommandMismatchReason };

const UNSUPPORTED_UNQUOTED = new Set([
  ';', '|', '&', '<', '>', '(', ')', '$', '`', '#', '*', '?', '[', ']', '{', '}', '!', '~',
]);

/**
 * Tokenize exactly one simple shell command. This is a recognizer, not a
 * shell: expansions, operators, globbing, comments, and compound syntax are
 * rejected, while quotes and backslash escapes only produce literal argv.
 */
export function tokenizeSimpleCommand(command: string): TokenizeResult {
  if (!command || command.length > GOVERNANCE_BOUNDS.MAX_SHELL_COMMAND_CHARS || command.includes('\0')) {
    return { ok: false, reason: 'empty, oversized, or NUL-bearing command' };
  }
  const argv: string[] = [];
  let token = '';
  let tokenStarted = false;
  let quote: 'single' | 'double' | null = null;

  const finishToken = (): void => {
    if (!tokenStarted) return;
    argv.push(token);
    token = '';
    tokenStarted = false;
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (char === '\n' || char === '\r') {
      return { ok: false, reason: 'newline control operator is unsupported' };
    }
    if (quote === 'single') {
      if (char === "'") quote = null;
      else token += char;
      continue;
    }
    if (quote === 'double') {
      if (char === '"') {
        quote = null;
        continue;
      }
      if (char === '$' || char === '`') {
        return { ok: false, reason: 'expansion is unsupported' };
      }
      if (char === '\\') {
        const escaped = command[index + 1];
        if (escaped === undefined || escaped === '\n' || escaped === '\r') {
          return { ok: false, reason: 'malformed escape' };
        }
        if (escaped === '$' || escaped === '`' || escaped === '"' || escaped === '\\') {
          index += 1;
          token += escaped;
        } else {
          token += '\\';
        }
        tokenStarted = true;
        continue;
      }
      token += char;
      tokenStarted = true;
      continue;
    }

    if (/\s/.test(char)) {
      finishToken();
      continue;
    }
    if (char === "'") {
      quote = 'single';
      tokenStarted = true;
      continue;
    }
    if (char === '"') {
      quote = 'double';
      tokenStarted = true;
      continue;
    }
    if (char === '\\') {
      index += 1;
      if (index >= command.length || command[index] === '\n' || command[index] === '\r') {
        return { ok: false, reason: 'malformed escape' };
      }
      token += command[index];
      tokenStarted = true;
      continue;
    }
    if (UNSUPPORTED_UNQUOTED.has(char)) {
      return { ok: false, reason: `unsupported shell syntax: ${char}` };
    }
    token += char;
    tokenStarted = true;
  }
  if (quote !== null) return { ok: false, reason: 'malformed quoting' };
  finishToken();
  if (argv.length === 0) return { ok: false, reason: 'empty command' };
  return { ok: true, argv };
}

function observedArgv(observed: ObservedCommand): string[] | null {
  if (observed.argv !== undefined) {
    if (observed.argv.length === 0 || observed.argv.length > GOVERNANCE_BOUNDS.MAX_OBSERVED_ARGV_ITEMS ||
        observed.argv.some(item => typeof item !== 'string' || item.includes('\0'))) return null;
    return [...observed.argv];
  }
  if (typeof observed.command !== 'string') return null;
  const tokenized = tokenizeSimpleCommand(observed.command);
  return tokenized.ok ? tokenized.argv : null;
}

function exactArgv(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function normalizedCwd(projectRoot: string, cwd: string): string | null {
  if (!cwd || cwd.includes('\0')) return null;
  const root = resolve(projectRoot);
  const candidate = isAbsolute(cwd) ? resolve(cwd) : resolve(root, cwd);
  const child = relative(root, candidate);
  if (child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) return null;
  return candidate;
}

function environmentMatches(
  names: readonly string[],
  observed: Readonly<Record<string, string | undefined>> | undefined,
  expected: Readonly<Record<string, string | undefined>> | undefined,
): boolean {
  if (names.length === 0) return true;
  if (observed === undefined || expected === undefined) return false;
  return names.every(name =>
    Object.hasOwn(observed, name) && Object.hasOwn(expected, name) && observed[name] === expected[name]);
}

/** Pure exact match against a gate's primary command and explicit aliases. */
export function matchGateCommand(
  observed: ObservedCommand,
  gate: NormalizedGate,
  context: CommandMatchContext,
): CommandMatchResult {
  const argv = observedArgv(observed);
  const observedCwd = normalizedCwd(context.projectRoot, observed.cwd);
  if (argv === null || observedCwd === null) return { matched: false, reason: 'invalid_command' };

  const forms: Array<{ form: NormalizedCommandForm; aliasIndex: number | null }> = [
    { form: gate, aliasIndex: null },
    ...gate.aliases.map((form, aliasIndex) => ({ form, aliasIndex })),
  ];
  let sawArgv = false;
  let sawCwd = false;
  for (const candidate of forms) {
    if (!exactArgv(argv, candidate.form.argv)) continue;
    sawArgv = true;
    const expectedCwd = normalizedCwd(context.projectRoot, candidate.form.cwd);
    if (expectedCwd === null || expectedCwd !== observedCwd) continue;
    sawCwd = true;
    if (!environmentMatches(gate.envNames, observed.environment, context.expectedEnvironment)) continue;
    return {
      matched: true,
      form: candidate.aliasIndex === null ? 'primary' : 'alias',
      aliasIndex: candidate.aliasIndex,
      argv,
      cwd: observedCwd,
    };
  }
  if (!sawArgv) return { matched: false, reason: 'argv_mismatch' };
  if (!sawCwd) return { matched: false, reason: 'cwd_mismatch' };
  return { matched: false, reason: 'env_mismatch' };
}
