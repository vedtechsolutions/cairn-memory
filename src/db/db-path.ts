import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { defaultDbPath } from '../constants/paths.js';

/**
 * Resolve the SQLite database path the way every Waykeep process must, so the
 * server, hooks, and `waykeep doctor` never diverge. `~` expands to the home
 * directory, `:memory:` passes through, and relative paths resolve against the
 * cwd. Pure and native-free — importable without loading better-sqlite3.
 */
export function resolveDbPath(input?: string): string {
  if (!input) {
    // Phase B: the database follows THE single state-root decision
    // (paths.ts resolveStateRoot) — never an independent existence check
    // that could split this process across namespaces.
    return defaultDbPath();
  }
  if (input === ':memory:') return input;
  if (input.startsWith('~')) return input.replace('~', homedir());
  return resolve(input);
}
