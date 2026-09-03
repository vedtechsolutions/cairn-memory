/**
 * Frozen-rendering cache for memory-tool paging (W4 v3.1 §7). A full view
 * freezes its rendering here so subsequent view_range pages serve the SAME
 * lines — pages can never duplicate or drop records because ranking moved
 * between requests. Session-scoped, best-effort ONLY: eviction or absence
 * degrades to a fresh rendering with a visible notice, never to incorrect
 * behavior.
 *
 * Bounds (frozen design): LRU over at most 8 renderings, 5-minute TTL per
 * entry, 4 MiB aggregate. Clock is injectable for deterministic tests;
 * eviction is deterministic (expired first, then least-recently-used until
 * both count and aggregate bounds hold).
 */
import { createHash } from 'node:crypto';
import { RENDER_CACHE } from '../constants/memory-tool.js';

export interface FrozenRendering {
  readonly lines: readonly string[];
  readonly renderingHash: string;
  readonly bytes: number;
}

interface CacheEntry {
  /** A frozen CLONE of the caller's array — later mutation of the source
   *  (or of a returned snapshot) cannot alter the freeze. */
  lines: readonly string[];
  renderingHash: string;
  bytes: number;
  insertedAt: number;
  lastAccess: number;
}

export type Clock = () => number;

export class RenderCache {
  private readonly entries = new Map<string, CacheEntry>();

  constructor(private readonly clock: Clock = Date.now) {}

  /** Freeze a rendering for a path (replaces any previous freeze). The
   *  lines are CLONED and Object.frozen at set time — mutating the source
   *  array afterwards changes nothing here, and the snapshot handed back
   *  is immutable. The internal entry is never exposed. */
  set(path: string, lines: readonly string[]): FrozenRendering {
    const now = this.clock();
    const frozenLines = Object.freeze([...lines]);
    const joined = frozenLines.join('\n');
    const entry: CacheEntry = {
      lines: frozenLines,
      renderingHash: createHash('sha256').update(joined).digest('hex'),
      bytes: Buffer.byteLength(joined, 'utf8'),
      insertedAt: now,
      lastAccess: now,
    };
    this.entries.delete(path);
    this.entries.set(path, entry);
    this.evict(now);
    return { lines: entry.lines, renderingHash: entry.renderingHash, bytes: entry.bytes };
  }

  /** The frozen rendering for a path, or null when absent/expired/evicted.
   *  Returns a snapshot object — never the mutable internal entry. */
  get(path: string): FrozenRendering | null {
    const now = this.clock();
    const entry = this.entries.get(path);
    if (!entry) return null;
    if (now - entry.insertedAt > RENDER_CACHE.TTL_MS) {
      this.entries.delete(path);
      return null;
    }
    entry.lastAccess = now;
    // Refresh Map insertion order so eviction is true LRU
    this.entries.delete(path);
    this.entries.set(path, entry);
    return { lines: entry.lines, renderingHash: entry.renderingHash, bytes: entry.bytes };
  }

  /** Explicit invalidation — REQUIRED after any successful mutation
   *  through the owning handler (frozen pages must not outlive edits). */
  invalidate(path: string): void {
    this.entries.delete(path);
  }

  invalidateAll(): void {
    this.entries.clear();
  }

  /** Deterministic eviction: drop expired entries first, then the least-
   *  recently-used until both the entry-count and aggregate-byte bounds
   *  hold. Map iteration order (insertion order, refreshed on access)
   *  makes the LRU victim selection deterministic. */
  private evict(now: number): void {
    for (const [path, entry] of this.entries) {
      if (now - entry.insertedAt > RENDER_CACHE.TTL_MS) this.entries.delete(path);
    }
    while (this.entries.size > RENDER_CACHE.MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value as string;
      this.entries.delete(oldest);
    }
    let aggregate = 0;
    for (const entry of this.entries.values()) aggregate += entry.bytes;
    while (aggregate > RENDER_CACHE.MAX_AGGREGATE_BYTES && this.entries.size > 0) {
      const oldest = this.entries.keys().next().value as string;
      aggregate -= this.entries.get(oldest)!.bytes;
      this.entries.delete(oldest);
    }
  }
}
