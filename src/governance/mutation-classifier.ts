import { isAbsolute, posix, relative, resolve, sep } from 'node:path';
import { tokenizeSimpleCommand } from './command-match.js';
import type {
  AdaptedClaudeEvent, MutationClassification, NormalizedCommandInput,
} from './types.js';

export const READ_ONLY_COMMAND_ALLOWLIST_VERSION = 1;

/** Exact argv forms only. Additions require a version bump and fixtures. */
export const READ_ONLY_COMMANDS_V1: readonly (readonly string[])[] = Object.freeze([
  Object.freeze(['pwd']),
  Object.freeze(['git', 'status']),
  Object.freeze(['git', 'status', '--short']),
  Object.freeze(['git', 'diff', '--quiet']),
  Object.freeze(['git', 'diff', '--cached', '--quiet']),
  Object.freeze(['git', 'rev-parse', '--is-inside-work-tree']),
  Object.freeze(['git', 'status', '--porcelain=v2', '-z', '--untracked-files=all']),
]);

function exactArgv(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function commandArgv(command: NormalizedCommandInput | null): string[] | null {
  if (command === null) return null;
  if (command.tokenizedArgv !== null) return [...command.tokenizedArgv];
  if (command.shellCommand === null) return null;
  const tokenized = tokenizeSimpleCommand(command.shellCommand);
  return tokenized.ok ? tokenized.argv : null;
}

function normalizedTarget(root: string, target: string): string | null {
  if (!target || target.includes('\0') || /^[A-Za-z]:/.test(target)) return null;
  const slashPath = target.replaceAll('\\', '/');
  if (slashPath.split('/').includes('..')) return null;
  const canonicalRoot = resolve(root);
  const absolute = isAbsolute(slashPath)
    ? resolve(slashPath)
    : resolve(canonicalRoot, slashPath);
  const child = relative(canonicalRoot, absolute);
  if (child === '' || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) return null;
  return posix.normalize(child.replaceAll('\\', '/'));
}

function editTargets(toolName: string, toolInput: Record<string, unknown>): string[] | null {
  const rawTargets: string[] = [];
  if (typeof toolInput.file_path === 'string') rawTargets.push(toolInput.file_path);
  else if (toolName !== 'MultiEdit') return null;

  if (toolName === 'MultiEdit' && Array.isArray(toolInput.edits)) {
    for (const edit of toolInput.edits) {
      if (edit !== null && typeof edit === 'object' && !Array.isArray(edit) &&
          typeof (edit as Record<string, unknown>).file_path === 'string') {
        rawTargets.push((edit as Record<string, unknown>).file_path as string);
      }
    }
  }
  return rawTargets.length > 0 ? [...new Set(rawTargets)] : null;
}

function unknown(reason: string, allowlistVersion: number | null = null): MutationClassification {
  return { mutationClass: 'unknown', affectedPaths: [], allowlistVersion, reason };
}

/** Conservative, filesystem-free mutation classification for Gate 3. */
export function classifyMutation(event: AdaptedClaudeEvent): MutationClassification {
  if (event.kind === 'adapter_error') return unknown('adapter_error');

  if (event.kind === 'file_changed') {
    const path = normalizedTarget(event.cwd, event.filePath);
    return path === null
      ? unknown('invalid FileChanged path')
      : { mutationClass: 'scoped', affectedPaths: [path], allowlistVersion: null, reason: 'FileChanged' };
  }

  if (event.captureStatus !== 'complete') return unknown('incomplete tool event');
  if (event.toolName === 'Write' || event.toolName === 'Edit' || event.toolName === 'MultiEdit') {
    if (event.result.outcome !== 'success') return unknown('edit tool did not complete successfully');
    const rawTargets = editTargets(event.toolName, event.toolInput);
    if (rawTargets === null) return unknown('edit tool target is missing');
    const normalized = rawTargets.map(target => normalizedTarget(event.cwd, target));
    if (normalized.some(path => path === null)) return unknown('edit tool target is invalid');
    return {
      mutationClass: 'scoped',
      affectedPaths: [...new Set(normalized as string[])].sort(),
      allowlistVersion: null,
      reason: 'successful edit tool',
    };
  }

  if (event.toolName === 'Bash') {
    if (event.result.outcome !== 'success') return unknown('failed Bash may have mutated');
    const argv = commandArgv(event.command);
    if (argv === null) {
      return unknown('Bash command is not one simple command', READ_ONLY_COMMAND_ALLOWLIST_VERSION);
    }
    const readOnly = READ_ONLY_COMMANDS_V1.some(candidate => exactArgv(argv, candidate));
    return readOnly
      ? {
          mutationClass: 'none', affectedPaths: [],
          allowlistVersion: READ_ONLY_COMMAND_ALLOWLIST_VERSION,
          reason: 'exact read-only command',
        }
      : unknown(
          'Bash command is not on the exact read-only allowlist',
          READ_ONLY_COMMAND_ALLOWLIST_VERSION,
        );
  }

  return unknown('unknown tool');
}
