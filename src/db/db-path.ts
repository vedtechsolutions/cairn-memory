import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { DB } from '../constants/index.js';

/**
 * Resolve the SQLite database path the way every Waykeep process must, so the
 * server, hooks, and `waykeep doctor` never diverge. `~` expands to the home
 * directory, `:memory:` passes through, and relative paths resolve against the
 * cwd. Pure and native-free — importable without loading better-sqlite3.
 */
export function resolveDbPath(input?: string): string {
  if (!input) {
    return DB.DEFAULT_PATH.replace('~', homedir());
  }
  if (input === ':memory:') return input;
  if (input.startsWith('~')) return input.replace('~', homedir());
  return resolve(input);
}
