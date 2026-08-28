/**
 * Read/write the cairn-state.json shared state file.
 * Written by StatusLine, read by MCP server and hooks.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { STATE_STALENESS_MS, CONTEXT_MODES, type ContextMode } from '../../constants/index.js';

export interface CairnState {
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
function isValidState(value: unknown): value is CairnState {
  if (!value || typeof value !== 'object') return false;
  const s = value as Record<string, unknown>;
  return typeof s.mode === 'string'
    && (CONTEXT_MODES as readonly string[]).includes(s.mode)
    && typeof s.freeUntilCompact === 'number'
    && Number.isFinite(s.freeUntilCompact)
    && s.freeUntilCompact >= FREE_MIN
    && s.freeUntilCompact <= FREE_MAX;
}

/** State file location — CAIRN_STATE_PATH env override (mirrors CAIRN_DIR /
 *  CAIRN_DB_PATH) keeps tests and sandboxed environments off the real
 *  ~/.claude. Resolved lazily so the override works regardless of import order. */
function statePath(): string {
  return process.env.CAIRN_STATE_PATH ?? join(homedir(), '.claude', 'cairn-state.json');
}

export function readState(): CairnState {
  const defaults: CairnState = { mode: 'normal', freeUntilCompact: 100 };
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

export function writeState(state: CairnState): void {
  const path = statePath();
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  // Temp + rename: written on every statusline fire and read by every hook,
  // so a plain write risks torn reads. Rename is atomic on POSIX; the pid
  // suffix keeps concurrent writers off the same temp file.
  const tmpPath = `${path}.${process.pid}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(state), 'utf-8');
  renameSync(tmpPath, path);
}
