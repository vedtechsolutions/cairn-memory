/**
 * Session Cache — in-memory cache for immutable/deterministic data.
 * Lives in the MCP server process, shared across all hook invocations.
 *
 * SNR Protection: Only caches data that is immutable or deterministic.
 * All mutable SNR fields (surface_count, impact_count, confidence,
 * invalidated, last_recalled) are ALWAYS queried live from the DB.
 *
 * Cacheable (immutable/deterministic):
 *   - Git hash/branch (invalidated on file-changed)
 *   - Project context (keyed by git hash)
 *   - Fingerprint overlap scores (deterministic computation)
 *   - FTS candidate memory IDs (content is immutable; 30s TTL)
 *   - Skip-gate hook output (keyed on memoryVersion + session state)
 *
 * NOT cached (mutable, SNR-critical):
 *   - surface_count, impact_count, confidence, invalidated, last_recalled
 *   - Ranking/scoring that depends on mutable fields
 *   - Cooldown checks (last_recalled timestamp)
 *
 * Skip-gate correctness:
 *   - memoryVersion is bumped by MCP write tools (cairn_learn, cairn_correct,
 *     cairn_forget, cairn_weaken, cairn_strengthen, cairn_promote, cairn_cleanup)
 *     and by error-learning-handler when it creates new pitfalls.
 *   - NOT bumped by metric-only updates (incrementSurface, incrementImpact) to
 *     avoid self-invalidating the cache on every hot-path call.
 *   - Cache key includes memoryVersion so any write forces a miss on next read,
 *     guaranteeing a staleness bound of zero for correction→learning edges.
 *   - A 60s hard TTL is the belt-and-braces defense against any missed bump path.
 */
import type Database from 'better-sqlite3';

import type { EditTracker } from './edit-tracker.js';
import type { ProjectContext } from '../../utils/project-scanner.js';
import type { ContextFingerprint } from '../../utils/fingerprint.js';

// --- Cache entry types ---

interface FTSCacheEntry {
  /** Memory IDs returned by FTS search */
  memoryIds: string[];
  /** Timestamp when cached */
  cachedAt: number;
}

interface GitCacheEntry {
  hash: string | null;
  branch: string | null;
  cachedAt: number;
}

interface SkipGateEntry {
  /** Output to return on cache hit (null for no-injection hooks) */
  output: string | null;
  /** memoryVersion at the time the entry was written */
  memoryVersion: number;
  /** Hard-TTL expiry */
  expiresAt: number;
}

// --- Constants ---

const FTS_CACHE_TTL_MS = 30_000;       // 30 seconds for FTS candidates
const GIT_CACHE_TTL_MS = 300_000;      // 5 minutes fallback TTL for git
const MAX_FTS_CACHE_ENTRIES = 50;      // Prevent unbounded growth
const MAX_FINGERPRINT_ENTRIES = 200;   // Max cached overlap scores
const TRACKER_FLUSH_INTERVAL_MS = 60_000; // Flush trackers to disk every 60s
const SKIP_GATE_TTL_MS = 60_000;       // Hard-TTL on skip-gate entries (staleness bound)
const MAX_SKIP_GATE_ENTRIES = 200;     // Per-process cap

// --- Session Cache ---

export class SessionCache {
  // Git state — invalidated on file-changed events
  private gitCache = new Map<string, GitCacheEntry>();

  // Project context — keyed by (projectId, gitHash)
  private projectContextCache = new Map<string, ProjectContext>();

  // Fingerprint overlap scores — deterministic (immutable input → same output)
  private fingerprintScores = new Map<string, number>();

  // FTS candidate cache — 30s TTL
  private ftsCache = new Map<string, FTSCacheEntry>();

  // Monotonic memory version counter — bumped by MCP write tools that change
  // memory content or authority. Hook handlers include this in their skip-gate
  // key; any bump forces a cache miss on the next read, giving corrections a
  // staleness bound of zero. Deliberately NOT bumped by incrementSurface /
  // incrementImpact — those metric updates would self-invalidate on every call.
  private memoryVersion = 0;

  // Skip-gate cache — per-hook cached output keyed on a composite of
  // (tool_name, filePathHash, memoryVersion, sessionStateHash, contextMode).
  // Hit path does zero DB work; miss path falls through to the full handler.
  private skipGateCache = new Map<string, SkipGateEntry>();

  // Durable memory generation last observed (D8 item 7 / X16): -1 =
  // never checked. Another PROCESS applying remote sync mutations bumps
  // the durable generation; this process's memoryVersion cannot see
  // that, so every memory-derived cache read verifies the generation
  // first and a mismatch invalidates the skip gate AND the FTS
  // candidate cache (the brief's named gap: only the former was
  // cleared).
  private lastSeenGeneration = -1;

  // Fired after every bump — set by MCP servers that share an
  // out-of-process hook-socket owner so the invalidation crosses the
  // socket too. Null (the default) in the owner's own cache: its bumps are
  // already in-process, and a notifier there would echo forever.
  private bumpNotifier: (() => void) | null = null;

  // In-memory trackers — replaces file I/O per hook call
  private trackers = new Map<string, EditTracker>();
  private trackersDirty = new Set<string>();
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private trackerFlushFn: ((tracker: EditTracker, sessionId: string) => void) | null = null;

  /** Start periodic tracker flushing to disk */
  startPeriodicFlush(flushFn: (tracker: EditTracker, sessionId: string) => void): void {
    this.trackerFlushFn = flushFn;
    if (this.flushTimer) return;
    this.flushTimer = setInterval(() => this.flushDirtyTrackers(), TRACKER_FLUSH_INTERVAL_MS);
    // Don't prevent process exit
    if (this.flushTimer.unref) this.flushTimer.unref();
  }

  /** Flush all dirty trackers to disk */
  flushDirtyTrackers(): void {
    if (!this.trackerFlushFn) return;
    for (const sessionId of this.trackersDirty) {
      const tracker = this.trackers.get(sessionId);
      if (tracker) {
        try {
          this.trackerFlushFn(tracker, sessionId);
        } catch { /* best-effort */ }
      }
    }
    this.trackersDirty.clear();
  }

  // --- Tracker methods (replaces file I/O) ---

  getTracker(sessionId: string): EditTracker | undefined {
    return this.trackers.get(sessionId);
  }

  setTracker(sessionId: string, tracker: EditTracker): void {
    this.trackers.set(sessionId, tracker);
    this.trackersDirty.add(sessionId);
  }

  deleteTracker(sessionId: string): void {
    this.trackers.delete(sessionId);
    this.trackersDirty.delete(sessionId);
  }

  // --- Memory version + skip-gate ---

  /** Current memory version — included in every skip-gate key. */
  getMemoryVersion(): number {
    return this.memoryVersion;
  }

  /**
   * Bump the memory version. Call from MCP write tools (cairn_learn, cairn_correct,
   * cairn_forget, cairn_weaken, cairn_strengthen, cairn_promote, cairn_cleanup) and
   * from error-learning-handler after a new pitfall is auto-created. Do NOT call
   * from incrementSurface / incrementImpact / last_recalled updates — those are
   * metric-only and would self-invalidate the hot-path cache.
   */
  bumpMemoryVersion(): void {
    // ONE invalidator for every memory-derived cache (Codex H4): a local
    // semantic write can also change fingerprint bytes (storeMemory
    // merges enrich fingerprints) and FTS-relevant content, so the
    // skip-gate-only clear left the un-TTL'd fingerprint scores stale
    // for the life of the process.
    this.invalidateMemoryDerived();
    this.bumpNotifier?.();
  }

  /**
   * Register a callback fired after each bump. Set only by MCP servers whose
   * hook socket is owned by ANOTHER process (standalone daemon or a peer
   * client's server) to relay the invalidation across the socket. Must stay
   * unset in the socket owner's cache — its bumps are already in-process.
   */
  setBumpNotifier(fn: (() => void) | null): void {
    this.bumpNotifier = fn;
  }

  /**
   * D8 item 7: verify the durable memory generation before trusting ANY
   * memory-derived cache. One indexed point-read per call — inside the
   * hook latency budget by design; the M1-exit matrix measures it. Call
   * before getSkipGate/getFTSCandidates consultations.
   */
  checkDurableGeneration(db: Database.Database): void {
    let generation = 0;
    try {
      const row = db.prepare("SELECT v FROM sync_state WHERE ns = 'memory' AND k = 'generation'").get() as { v: string } | undefined;
      generation = row ? Number(row.v) : 0;
    } catch (err) {
      // ONLY the missing-table case is a legitimate no-op (pre-v32:
      // nothing replicates, nothing to check). Every OTHER failure —
      // SQLITE_BUSY, corruption, schema drift — is UNKNOWN state, and
      // unknown must fail closed: flush rather than trust (review C1 —
      // the broad catch silently served stale memory after a real
      // remote apply).
      if (String((err as Error).message).includes('no such table')) return;
      this.invalidateMemoryDerived();
      return;
    }
    if (generation === this.lastSeenGeneration) return;
    if (this.lastSeenGeneration !== -1) this.invalidateMemoryDerived();
    this.lastSeenGeneration = generation;
  }

  /** Flush every MEMORY-DERIVED cache: the skip gate, the FTS candidate
   *  cache, and the fingerprint scores — the last is keyed by memoryId
   *  and a remote edit rewrites the fingerprint bytes it scored (review
   *  C2). memoryVersion++ directly — never through bumpMemoryVersion,
   *  whose notifier would push a redundant relay: the durable generation
   *  IS the shared channel, and every peer discovers the change
   *  independently on its next read. */
  private invalidateMemoryDerived(): void {
    this.skipGateCache.clear();
    this.ftsCache.clear();
    this.fingerprintScores.clear();
    this.memoryVersion++;
  }

  /**
   * Skip-gate cache read. Returns the cached entry iff the composite key matches
   * AND the entry's memoryVersion equals the current version AND the hard TTL has
   * not expired. The caller is responsible for building the key.
   */
  getSkipGate(key: string): SkipGateEntry | null {
    const entry = this.skipGateCache.get(key);
    if (!entry) return null;
    if (entry.memoryVersion !== this.memoryVersion) {
      this.skipGateCache.delete(key);
      return null;
    }
    if (Date.now() > entry.expiresAt) {
      this.skipGateCache.delete(key);
      return null;
    }
    return entry;
  }

  /** Skip-gate cache write. The entry captures the current memoryVersion. */
  setSkipGate(key: string, output: string | null): void {
    this.skipGateCache.set(key, {
      output,
      memoryVersion: this.memoryVersion,
      expiresAt: Date.now() + SKIP_GATE_TTL_MS,
    });
    if (this.skipGateCache.size > MAX_SKIP_GATE_ENTRIES) {
      const first = this.skipGateCache.keys().next().value;
      if (first) this.skipGateCache.delete(first);
    }
  }

  // --- Git cache ---

  getGitState(cwd: string): GitCacheEntry | null {
    const entry = this.gitCache.get(cwd);
    if (!entry) return null;
    if (Date.now() - entry.cachedAt > GIT_CACHE_TTL_MS) {
      this.gitCache.delete(cwd);
      return null;
    }
    return entry;
  }

  setGitState(cwd: string, hash: string | null, branch: string | null): void {
    this.gitCache.set(cwd, { hash, branch, cachedAt: Date.now() });
  }

  /** Invalidate git cache for a cwd — called on file-changed events */
  invalidateGit(cwd: string): void {
    this.gitCache.delete(cwd);
  }

  // --- Project context cache ---

  getProjectContext(projectId: string, gitHash: string): ProjectContext | null {
    return this.projectContextCache.get(`${projectId}:${gitHash}`) ?? null;
  }

  setProjectContext(projectId: string, gitHash: string, ctx: ProjectContext): void {
    const key = `${projectId}:${gitHash}`;
    this.projectContextCache.set(key, ctx);
    // Keep max 5 entries per project
    if (this.projectContextCache.size > 10) {
      const first = this.projectContextCache.keys().next().value;
      if (first) this.projectContextCache.delete(first);
    }
  }

  // --- Fingerprint overlap score cache ---

  /** Cache key: memoryId + serialized query fingerprint */
  getFingerprintScore(memoryId: string, queryFpKey: string): number | undefined {
    return this.fingerprintScores.get(`${memoryId}:${queryFpKey}`);
  }

  setFingerprintScore(memoryId: string, queryFpKey: string, score: number): void {
    const key = `${memoryId}:${queryFpKey}`;
    this.fingerprintScores.set(key, score);
    // Evict oldest if over limit
    if (this.fingerprintScores.size > MAX_FINGERPRINT_ENTRIES) {
      const first = this.fingerprintScores.keys().next().value;
      if (first) this.fingerprintScores.delete(first);
    }
  }

  // --- FTS candidate cache ---

  getFTSCandidates(queryKey: string): string[] | null {
    const entry = this.ftsCache.get(queryKey);
    if (!entry) return null;
    if (Date.now() - entry.cachedAt > FTS_CACHE_TTL_MS) {
      this.ftsCache.delete(queryKey);
      return null;
    }
    return entry.memoryIds;
  }

  setFTSCandidates(queryKey: string, memoryIds: string[]): void {
    this.ftsCache.set(queryKey, { memoryIds, cachedAt: Date.now() });
    // Evict oldest if over limit
    if (this.ftsCache.size > MAX_FTS_CACHE_ENTRIES) {
      const first = this.ftsCache.keys().next().value;
      if (first) this.ftsCache.delete(first);
    }
  }

  // --- Utility ---

  /** Build a stable cache key from a query fingerprint */
  static fingerprintKey(fp: ContextFingerprint): string {
    return `${fp.lang.sort().join(',')}|${fp.framework.sort().join(',')}|${fp.module.sort().join(',')}`;
  }

  /**
   * Build a composite skip-gate key from the per-hook inputs. All components
   * are joined with a separator that cannot appear in tool names, file paths,
   * or intent strings so collisions are impossible.
   */
  static skipGateKey(parts: {
    hookName: string;
    toolName?: string;
    filePath?: string | null;
    contextMode: string;
    /** Cheap hash of session-dependent state (error counts, recent tool chain, etc.) */
    sessionStateHash: string;
    /** Optional extra payload-specific discriminator (e.g. prompt intent) */
    extra?: string;
  }): string {
    return [
      parts.hookName,
      parts.toolName ?? '',
      parts.filePath ?? '',
      parts.contextMode,
      parts.sessionStateHash,
      parts.extra ?? '',
    ].join('\x1f');
  }

  /** Cleanup on shutdown */
  destroy(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    this.flushDirtyTrackers();
  }
}
