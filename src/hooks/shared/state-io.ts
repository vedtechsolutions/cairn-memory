/**
 * Read/write the waykeep-state.json shared state file.
 * Written by StatusLine, read by MCP server and hooks.
 */
import { readFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { writeFileAtomic } from '../../utils/atomic-write.js';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { STATE_STALENESS_MS, CONTEXT_MODES, type ContextMode } from '../../constants/index.js';
import { ENV } from '../../constants/env.js';
import { FILES } from '../../constants/paths.js';
import { CLAUDE_CODE } from '../../constants/claude-code.js';

export interface WaykeepState {
  mode: ContextMode;
  freeUntilCompact: number;
}

/** Bounds for freeUntilCompact — a percentage of remaining context. */
const FREE_MIN = 0;
const FREE_MAX = 100;

/** Validate a parsed state object before trusting it (L1). The state file is
 *  writable by anything with local FS access; a forged `mode: "critical"`
 *  would silently suppress memory tooling. Reject anything off-shape and let
 *  the caller fall back to the safe `normal` default. */
function isValidState(value: unknown): value is WaykeepState {
  if (!value || typeof value !== 'object') return false;
  const s = value as Record<string, unknown>;
  return typeof s.mode === 'string'
    && (CONTEXT_MODES as readonly string[]).includes(s.mode)
    && typeof s.freeUntilCompact === 'number'
    && Number.isFinite(s.freeUntilCompact)
    && s.freeUntilCompact >= FREE_MIN
    && s.freeUntilCompact <= FREE_MAX;
}

/** State file location — WAYKEEP_STATE_PATH env override (mirrors WAYKEEP_DIR /
 *  WAYKEEP_DB_PATH) keeps tests and sandboxed environments off the real
 *  ~/.claude. Resolved lazily so the override works regardless of import order. */
function statePath(): string {
  return process.env[ENV.STATE_PATH] ?? join(homedir(), CLAUDE_CODE.CONFIG_DIR, FILES.CLIENT_STATE);
}

export function readState(): WaykeepState {
  const defaults: WaykeepState = { mode: 'normal', freeUntilCompact: 100 };
  const path = statePath();
  try {
    if (!existsSync(path)) return defaults;

    // If the state file is too old, the context may have changed — default to normal (fail-open)
    const stat = statSync(path);
    const ageMs = Date.now() - stat.mtimeMs;
    if (ageMs > STATE_STALENESS_MS) return defaults;

    const raw = readFileSync(path, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    return isValidState(parsed) ? parsed : defaults;
  } catch {
    return defaults;
  }
}

export function writeState(state: WaykeepState): void {
  const path = statePath();
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  // Atomic replace: written on every statusline fire and read by every hook,
  // so a plain write risks torn reads.
  writeFileAtomic(path, JSON.stringify(state));
}
