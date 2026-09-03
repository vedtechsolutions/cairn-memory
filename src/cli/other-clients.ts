/**
 * Other MCP clients `waykeep init` can only report, not wire (Codex is wired
 * for real by runCodexInit). Detection is advisory and runs after
 * configuration was written, so it must never throw.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { robustHomedir } from '../constants/paths.js';

/** Non-Claude MCP clients with no native wiring yet, reported not
 *  auto-edited. Codex is wired for real by runCodexInit. */
const OTHER_CLIENTS: Array<{ name: string; dir: string }> = [
  { name: 'Cursor', dir: '.cursor' },
  { name: 'Gemini CLI', dir: '.gemini' },
  { name: 'Windsurf', dir: '.codeium' },
];

/** Advisory only: with no resolvable home there is nothing to detect, and
 *  init has already written its configuration by the time it asks, so this
 *  must not throw. */
export function detectOtherClients(): typeof OTHER_CLIENTS[number][] {
  try {
    const home = robustHomedir();
    return OTHER_CLIENTS.filter(c => existsSync(join(home, c.dir)));
  } catch {
    return [];
  }
}
