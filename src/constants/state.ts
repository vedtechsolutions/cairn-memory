// ============================================================================
// Edit-tracker files, lock timing and project scanning
// ============================================================================

// --- Shared State -----------------------------------------------------------

export const TRACKER_FILENAME = 'edit-tracker.json';
/** Max age (days) before orphaned session tracker files are cleaned up */
export const TRACKER_ORPHAN_MAX_AGE_DAYS = 7;
export const STATE_STALENESS_MS = 30_000;
/** updateTracker lock (H6 lost-update fix): a lock dir older than this is a
 *  crashed holder and gets stolen — generous vs the few-ms critical section */
export const TRACKER_LOCK_STALE_MS = 2_000;
/** Max time a hook waits for the tracker lock before proceeding unlocked
 *  (fail-open: hooks must never hang Claude Code) */
export const TRACKER_LOCK_MAX_WAIT_MS = 250;
/** Delay between tracker lock acquisition retries */
export const TRACKER_LOCK_RETRY_MS = 10;

// --- Project Context Scanning -----------------------------------------------

export const PROJECT_SCAN = {
  IGNORED_DIRS: [
    '.git', 'node_modules', 'dist', '__pycache__', '.venv', 'venv',
    'target', 'build', '.next', '.cache', 'coverage', '.tox', '.mypy_cache',
    '.pytest_cache', '.nyc_output', '.turbo', 'vendor',
  ] as readonly string[],
  MAX_TOP_DIRS: 15,
  MAX_SUB_DEPTH: 1,
  MAX_CACHE_PER_PROJECT: 5,
  CONFIG_FILES: [
    'package.json', 'tsconfig.json', 'Cargo.toml', 'pyproject.toml',
    'go.mod', 'Makefile', 'docker-compose.yml', 'build.gradle',
    'pom.xml', 'CMakeLists.txt', 'setup.py', 'setup.cfg',
  ] as readonly string[],
} as const;
