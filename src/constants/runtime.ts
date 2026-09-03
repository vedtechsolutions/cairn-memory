// ============================================================================
// Version, database defaults and filesystem permissions
// ============================================================================

import { DB_DEFAULT_PATH } from './paths.js';

// --- DB Config --------------------------------------------------------------

export const DB = {
  DEFAULT_PATH: DB_DEFAULT_PATH,
  BUSY_TIMEOUT_MS: 5000,
  /** Contention budget for a telemetry rollup write. The global busy_timeout
   *  above is longer than both relays' 3s deadlines, so a contended ROLLUP
   *  insert on a sync path could starve a ready briefing out of its delivery
   *  window (review P1). A bookkeeping row is never worth that: near-zero
   *  budget, dropped on contention. */
  ROLLUP_BUSY_TIMEOUT_MS: 50,
} as const;

// --- Standalone daemon lifecycle ----------------------------------------------

export const DAEMON = {
  /** Retry cadence while a legacy embedded owner still holds the socket; the
   *  daemon waits for it to exit rather than displacing it. */
  CLAIM_RETRY_INTERVAL_MS: 10_000,
  /** Grace period for in-flight hook requests after a shutdown signal. */
  SHUTDOWN_GRACE_MS: 3_000,
} as const;

// --- Diagnostic logging -----------------------------------------------------

/** Levels for the stderr diagnostics of the long-running processes and the
 *  data layer, most to least severe. `WAYKEEP_LOG_LEVEL` selects the least
 *  severe level still printed; `WAYKEEP_VERBOSE=1` is a shortcut for debug. */
export const LOG_LEVELS = ['silent', 'error', 'warn', 'info', 'debug'] as const;
export type LogLevel = typeof LOG_LEVELS[number];
export const DEFAULT_LOG_LEVEL: LogLevel = 'info';

// --- Atomic file replacement ------------------------------------------------

/** Temp-name allocation for writeFileAtomic: names carry this many random
 *  bytes and are opened exclusively, so a pre-planted path (a symlink at a
 *  predictable name) cannot be written through; a collision — astronomically
 *  rare — is retried this many times before giving up. */
export const ATOMIC_WRITE = {
  TEMP_NAME_RANDOM_BYTES: 8,
  TEMP_NAME_ATTEMPTS: 3,
  /** For the no-clobber (hard-link) publish: link collisions handled per attempt. */
  NO_REPLACE_LINK_ATTEMPTS: 4,
} as const;

// --- Filesystem permissions -------------------------------------------------

/** Owner-only permissions for the Waykeep state directory and the sensitive
 *  files inside it (database, hook socket, PID file). The hook socket carries
 *  no authentication of its own, so 0700 directory containment IS the access
 *  control: on a shared or root host it keeps other local users from
 *  connecting to the socket, claiming its ownership, or reading the database.
 *  Cross-UID sharing (a root daemon serving non-root clients) is intentionally
 *  not supported by these perms and needs a future peer-credential design. */
export const FS_PERMS = {
  DIR: 0o700,
  FILE: 0o600,
  /** Group + other permission bits. A path is "owner-only" when none are set;
   *  the fail-closed socket self-verify asserts `(mode & GROUP_OTHER_BITS) === 0`. */
  GROUP_OTHER_BITS: 0o077,
  /** Mode for a compiled artifact that must be runnable (the C relay). */
  EXECUTABLE: 0o755,
} as const;

// --- Config cache -------------------------------------------------------------

export const CONFIG_CACHE = {
  /** mtime resolution assumed when deciding a config file is "fresh"; a file
   *  modified within this many ms of now is re-read rather than served from
   *  cache, so back-to-back edits are never missed. */
  MTIME_GRANULARITY_MS: 2,
} as const;

// --- Engine floor -------------------------------------------------------------

/** Mirrors package.json `engines.node`; `waykeep doctor` fails below it. */
export const ENGINE = {
  MIN_NODE_MAJOR: 20,
} as const;
