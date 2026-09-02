/**
 * Diagnostic logging for the long-running processes (MCP server, daemon,
 * hook socket), the hooks, and the data layer — stderr only, because the
 * MCP server's stdout is the protocol stream and a hook's stdout is its
 * output to the agent. Levels come from WAYKEEP_LOG_LEVEL — the knob
 * `waykeep init` has always set in the MCP env and nothing read until now
 * (audit) — with WAYKEEP_VERBOSE=1 as a debug shortcut. CLI commands keep
 * printing their user-facing output with console.log: that is presentation,
 * not logging.
 *
 * The prefix derives from the namespace, so the five hand-spelled variants
 * of "[waykeep…]" collapse into `[waykeep]` and `[waykeep:<scope>]`.
 */
import { NAMESPACE } from 'waykeep-contract';
import { ENV } from '../constants/env.js';
import { LOG_LEVELS, DEFAULT_LOG_LEVEL, type LogLevel } from '../constants/runtime.js';

export interface Logger {
  error(message: string, ...detail: unknown[]): void;
  warn(message: string, ...detail: unknown[]): void;
  info(message: string, ...detail: unknown[]): void;
  debug(message: string, ...detail: unknown[]): void;
  /** A logger whose prefix carries `scope` — e.g. `[waykeep:daemon]`. */
  child(scope: string): Logger;
}

/** Resolved on every call, not at import: hooks are short-lived and tests set
 *  the env after modules load. An unknown value falls back to the default. */
export function currentLogLevel(): LogLevel {
  if (process.env[ENV.VERBOSE] === '1') return 'debug';
  const raw = process.env[ENV.LOG_LEVEL];
  return (LOG_LEVELS as readonly string[]).includes(raw ?? '') ? (raw as LogLevel) : DEFAULT_LOG_LEVEL;
}

function enabled(level: LogLevel): boolean {
  return LOG_LEVELS.indexOf(level) <= LOG_LEVELS.indexOf(currentLogLevel());
}

export function createLogger(scope?: string): Logger {
  const prefix = scope ? `[${NAMESPACE}:${scope}]` : `[${NAMESPACE}]`;
  const emit = (level: LogLevel) => (message: string, ...detail: unknown[]): void => {
    if (enabled(level)) console.error(`${prefix} ${message}`, ...detail);
  };
  return {
    error: emit('error'),
    warn: emit('warn'),
    info: emit('info'),
    debug: emit('debug'),
    child: (sub) => createLogger(scope ? `${scope}:${sub}` : sub),
  };
}

/** The process-wide logger. */
export const log: Logger = createLogger();
