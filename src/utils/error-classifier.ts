/**
 * Error classifier for PostToolUseFailure hook.
 * Determines whether an error is worth encoding as a pitfall.
 * Persists dedup state to file so dedup works across hook invocations.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  LEARNABLE_ERROR_PATTERNS,
  NOISE_ERROR_PATTERNS,
  LIMITS,
} from '../constants/index.js';
import { errorDedupPath as sharedErrorDedupPath } from '../constants/paths.js';

export interface ErrorClassification {
  learnable: boolean;
  tags: string[];
  /** Stable key for dedup/escalation counting (normalized first line) */
  errorKey: string | null;
}

/** Dedup-state file — honors the WAYKEEP_DIR override (like edit-tracker /
 *  state-io), resolved lazily so tests and sandboxes stay off ~/.waykeep. */
function errorDedupPath(): string {
  return sharedErrorDedupPath();
}

/** Whether to use file-based persistence (disabled during testing) */
let persistToFile = true;

/** Load persisted dedup state from file */
function loadDedupState(): Map<string, number> {
  if (!persistToFile) return new Map(memoryDedup);
  try {
    const path = errorDedupPath();
    if (!existsSync(path)) return new Map();
    const raw = readFileSync(path, 'utf-8');
    const state = JSON.parse(raw) as { errors: Record<string, number> };
    return new Map(Object.entries(state.errors));
  } catch {
    return new Map();
  }
}

/** Save dedup state to file, pruning expired entries */
function saveDedupState(errors: Map<string, number>): void {
  if (!persistToFile) return;
  try {
    const path = errorDedupPath();
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const cutoff = Date.now() - LIMITS.RECENT_ERROR_WINDOW_MS;
    const filtered: Record<string, number> = {};
    for (const [key, ts] of errors) {
      if (ts >= cutoff) filtered[key] = ts;
    }
    writeFileSync(path, JSON.stringify({ errors: filtered }), 'utf-8');
  } catch {
    // Best-effort — don't block error classification
  }
}

/** In-memory dedup state (always active, also used as sole source in test mode) */
let memoryDedup = new Map<string, number>();

/** Classify whether an error is worth encoding as a pitfall */
export function classifyError(errorText: string): ErrorClassification {
  // Noise filter: skip environment/transient errors
  if (NOISE_ERROR_PATTERNS.some(p => p.test(errorText))) {
    return { learnable: false, tags: [], errorKey: null };
  }

  // Find matching learnable pattern
  for (const { pattern, tags } of LEARNABLE_ERROR_PATTERNS) {
    if (pattern.test(errorText)) {
      // Load dedup state (file-based for cross-invocation dedup)
      const recentErrors = loadDedupState();
      // Merge in-memory state (for within-invocation dedup)
      for (const [k, v] of memoryDedup) {
        const existing = recentErrors.get(k);
        if (!existing || v > existing) recentErrors.set(k, v);
      }

      const errorKey = extractErrorKey(errorText);
      const lastSeen = recentErrors.get(errorKey);
      const now = Date.now();

      if (lastSeen && now - lastSeen < LIMITS.RECENT_ERROR_WINDOW_MS) {
        // Deduped for pitfall creation, but still return the key for escalation counting
        return { learnable: false, tags: [...tags], errorKey };
      }

      recentErrors.set(errorKey, now);
      memoryDedup.set(errorKey, now);
      saveDedupState(recentErrors);

      return { learnable: true, tags: [...tags], errorKey };
    }
  }

  return { learnable: false, tags: [], errorKey: null };
}

/** Extract a stable key from an error message for dedup */
function extractErrorKey(errorText: string): string {
  // Take the first line and normalize whitespace
  const firstLine = errorText.split('\n')[0] ?? errorText;
  return firstLine
    .replace(/\d+/g, 'N')     // Normalize numbers
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

/** Reset the dedup tracker (for testing — also disables file persistence) */
export function resetErrorTracker(): void {
  memoryDedup = new Map();
  persistToFile = false;
}
