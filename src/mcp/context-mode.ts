import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { type ContextMode } from '../constants/index.js';
import { FILES } from '../constants/paths.js';

const STATE_PATH = join(homedir(), '.claude', FILES.CLIENT_STATE);

interface WaykeepState {
  mode: ContextMode;
  freeUntilCompact: number;
}

/**
 * Read current context mode from the shared state file written by StatusLine.
 * Returns 'normal' if the file doesn't exist yet.
 */
export function getContextMode(): ContextMode {
  try {
    if (!existsSync(STATE_PATH)) return 'normal';
    const raw = readFileSync(STATE_PATH, 'utf-8');
    const state: WaykeepState = JSON.parse(raw);
    return state.mode ?? 'normal';
  } catch {
    return 'normal';
  }
}
