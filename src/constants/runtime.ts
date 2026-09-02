// ============================================================================
// Version, database defaults and filesystem permissions
// ============================================================================

import { DB_DEFAULT_PATH } from './paths.js';

// --- DB Config --------------------------------------------------------------

export const DB = {
  DEFAULT_PATH: DB_DEFAULT_PATH,
  BUSY_TIMEOUT_MS: 5000,
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
} as const;
