import type Database from 'better-sqlite3';
import { CONFIDENCE, type MemoryKind } from '../constants/index.js';
import type { ContextFingerprint } from '../utils/fingerprint.js';
import { trackCoRecall as trackCoRecallImpl } from '../utils/prediction.js';
import type {
  Memory,
  CreateMemoryInput,
  StoreDecisionInput,
  StorePitfallInput,
  RecallOptions,
  RecallResult,
  CreateResult,
  CleanupFilter,
} from './memory-repository/types.js';
import type { PortableFile, PortableRecord } from '../memory-tool/round-trip.js';
import * as portability from './memory-repository/portability.js';
import * as reads from './memory-repository/reads.js';
import * as writes from './memory-repository/writes.js';
import * as searchOps from './memory-repository/search.js';
import * as vectors from './memory-repository/vector-search.js';
import * as graph from './memory-repository/graph.js';
import * as feedback from './memory-repository/feedback.js';
import * as briefing from './memory-repository/briefing.js';
import * as stats from './memory-repository/stats.js';
import * as truth from './memory-repository/truth.js';
import type { ContradictionPair, StalenessInfo } from './memory-repository/truth.js';

export type {
  Memory,
  CreateMemoryInput,
  StoreDecisionInput,
  StorePitfallInput,
  RecallOptions,
  RecallResult,
  CreateResult,
  CleanupFilter,
} from './memory-repository/types.js';

// --- Repository -------------------------------------------------------------

/** Facade over the memory persistence layer. Implementation lives in the
 *  cohesive modules under ./memory-repository/ — this class only delegates,
 *  keeping the public API (and all its import sites) stable. */
export class MemoryRepository {
  constructor(private db: Database.Database) {}

  create(input: CreateMemoryInput): CreateResult {
    return writes.create(this.db, input);
  }

  /** Unified decision write gateway — all decision storage paths should use this. */
  storeDecision(input: StoreDecisionInput): CreateResult {
    return writes.storeMemory(this.db, { ...input, kind: 'decision' });
  }

  /** Unified pitfall write gateway — all pitfall storage paths should use this. */
  storePitfall(input: StorePitfallInput): CreateResult {
    return writes.storeMemory(this.db, { ...input, kind: 'pitfall' });
  }

  findById(id: string): Memory | null {
    return reads.findById(this.db, id);
  }

  /** Batch lookup — one query instead of N findById round-trips. */
  findByIds(ids: string[]): Memory[] {
    return reads.findByIds(this.db, ids);
  }

  /** Resolve a memory by its short-id prefix (first N chars of the full id). */
  findByShortId(shortId: string): Memory | null {
    return reads.findByShortId(this.db, shortId);
  }

  /** Search memories — read-only, does NOT update recall stats */
  search(query: string, options: RecallOptions = {}): RecallResult[] {
    return searchOps.search(this.db, query, options);
  }

  /** Search + track — updates recall stats for returned memories */
  recall(query: string, options: RecallOptions = {}): RecallResult[] {
    return searchOps.recall(this.db, query, options);
  }

  /** Recall by tags — lightweight query for hooks (no FTS) */
  recallByTags(tags: string[], options: RecallOptions = {}): Memory[] {
    return searchOps.recallByTags(this.db, tags, options);
  }

  /** Multi-signal retrieval using context fingerprints + content FTS. */
  recallByFingerprint(
    queryFp: ContextFingerprint,
    queryText: string,
    options: RecallOptions = {},
  ): RecallResult[] {
    return searchOps.recallByFingerprint(this.db, queryFp, queryText, options);
  }

  /** Hybrid search: combines FTS5 keyword search + vector cosine search using RRF. */
  recallHybrid(
    queryText: string,
    queryEmbedding: Buffer | null,
    options: RecallOptions = {},
  ): RecallResult[] {
    return vectors.recallHybrid(this.db, queryText, queryEmbedding, options);
  }

  /** Recall memories anchored to a specific file path. */
  recallByAnchor(filePath: string, options: RecallOptions = {}): Memory[] {
    return searchOps.recallByAnchor(this.db, filePath, options);
  }

  /** Track co-recall for a set of memory IDs recalled in the same session. */
  trackCoRecall(sessionId: string, memoryIds: string[]): void {
    if (memoryIds.length === 0) return;
    trackCoRecallImpl(this.db, sessionId, memoryIds);
  }

  /** Enrich recall results with 1-hop graph neighbors (via memory_edges). */
  enrichWithGraphNeighbors(results: RecallResult[], maxExtra: number = 2): RecallResult[] {
    return graph.enrichWithGraphNeighbors(this.db, results, maxExtra);
  }

  /** Get a memory's raw embedding for cosine comparison (no model load).
   *  ACTIVE-model only — foreign-model vectors return null. */
  getEmbedding(id: string): Buffer | null {
    return reads.getEmbedding(this.db, id);
  }

  /** Bump recall stats for exactly these ids (rerank path: wide read-only
   *  pool, side effects only for the returned top-k). */
  markRecalled(ids: string[]): void {
    reads.markRecalled(this.db, ids);
  }

  /** Store embedding for an existing memory (used by backfill) */
  storeEmbedding(id: string, embedding: Buffer): boolean {
    return reads.storeEmbedding(this.db, id, embedding);
  }

  /** Proxy vector search: use a stored memory's embedding to find semantically related memories. */
  searchByProxyEmbedding(
    proxyMemoryId: string,
    excludeIds: Set<string>,
    options: RecallOptions = {},
  ): RecallResult[] {
    return vectors.searchByProxyEmbedding(this.db, proxyMemoryId, excludeIds, options);
  }

  /** Get memories without embeddings (for backfill) */
  memoriesWithoutEmbeddings(limit: number = 50): Array<{ id: string; content: string }> {
    return reads.memoriesWithoutEmbeddings(this.db, limit);
  }

  update(id: string, newContent: string): boolean {
    return writes.update(this.db, id, newContent);
  }

  /** Get version history for a memory (most recent first) */
  getVersionHistory(memoryId: string): Array<{ oldContent: string; newContent: string; changedAt: string }> {
    return writes.getVersionHistory(this.db, memoryId);
  }

  invalidate(id: string): boolean {
    return writes.invalidate(this.db, id);
  }

  delete(id: string): boolean {
    return writes.deleteById(this.db, id);
  }

  boostConfidence(id: string, amount: number = CONFIDENCE.BOOST_INCREMENT): void {
    feedback.boostConfidence(this.db, id, amount);
  }

  /** Record that a memory was surfaced (shown to Claude before a tool call) */
  incrementSurface(id: string): void {
    feedback.incrementSurface(this.db, id);
  }

  /** Record that a surfaced memory led to a successful outcome */
  incrementImpact(id: string): void {
    feedback.incrementImpact(this.db, id);
  }

  /** Explicit positive feedback: increase trust in an accurate/useful memory */
  strengthenConfidence(id: string): boolean {
    return feedback.strengthenConfidence(this.db, id);
  }

  /** Phase 5: recall-precision feedback loop over the session_memories junction. */
  applyPrecisionFeedback(
    sessionId: string,
    strengthenIncrement: number,
    weakenFactor: number,
  ): { strengthened: number; weakened: number } {
    return feedback.applyPrecisionFeedback(this.db, sessionId, strengthenIncrement, weakenFactor);
  }

  /** Explicit negative feedback: decrease trust, auto-invalidate if below threshold */
  weakenConfidence(id: string): { weakened: boolean; invalidated: boolean } {
    return feedback.weakenConfidence(this.db, id);
  }

  /** Find top pitfalls for briefing. When queryFp is provided, uses context-aware ranking. */
  topPitfalls(project: string | null, limit: number, queryFp?: ContextFingerprint): Memory[] {
    return briefing.topPitfalls(this.db, project, limit, queryFp);
  }

  /** Find top decisions for briefing fallback when no plan decisions exist. */
  topDecisions(project: string | null, limit: number): Memory[] {
    return briefing.topDecisions(this.db, project, limit);
  }

  /** Find top decisions ranked by impact, confidence, and recency for tier-based briefing. */
  topDecisionsRanked(project: string | null, limit: number): Memory[] {
    return briefing.topDecisionsRanked(this.db, project, limit);
  }

  /** Filter out memories that have been superseded by newer ones (via memory_edges). */
  filterSuperseded(memories: Memory[]): Memory[] {
    return graph.filterSuperseded(this.db, memories);
  }

  /** Active unresolved contradiction pairs for a project (arbitration surfacing). */
  getContradictions(project: string | null): ContradictionPair[] {
    return truth.getContradictions(this.db, project);
  }

  /** Read-time staleness verdict for a claim-bearing memory, or null if it
   *  never decays. Non-destructive — the returned reason is the marker text. */
  claimStaleness(memory: Memory, nowMs?: number): StalenessInfo | null {
    return truth.classifyClaimStaleness(memory, nowMs);
  }

  /** Terse "verify" suffix for a stale claim-bearing memory ('' when fresh). */
  stalenessMarker(memory: Memory, nowMs?: number): string {
    return truth.stalenessMarker(memory, nowMs);
  }

  /** Find active corrections (global + project) */
  activeCorrections(project: string | null, limit: number): Memory[] {
    return briefing.activeCorrections(this.db, project, limit);
  }

  /** Export memories matching filter criteria (for cairn_export) */
  exportMemories(options: {
    project?: string | null;
    kind?: MemoryKind;
    minConfidence?: number;
  } = {}): Memory[] {
    return stats.exportMemories(this.db, options);
  }

  /** ACTIVE rows as the twelve-field portable contract (round-trip v2) */
  exportPortable(options: portability.PortableExportOptions = {}): PortableRecord[] {
    return portability.exportPortableRecords(this.db, options);
  }

  /** Free-form memory files for portable export (round-trip v2) */
  exportPortableFiles(): PortableFile[] {
    return portability.exportPortableFiles(this.db);
  }

  /** Strict restore-by-id: no merge, no boosts, no conflict detection */
  restore(record: PortableRecord & { id: string }): 'inserted' | 'updated' {
    return portability.restoreRecord(this.db, record);
  }

  /** Upsert one free-form memory file — VFS path gate, then adapter caps */
  restoreFile(file: PortableFile): void {
    portability.restoreFile(this.db, file);
  }

  /** Strict-restore a whole document in ONE immediate transaction */
  restoreAll(records: ReadonlyArray<PortableRecord & { id: string }>, files: readonly PortableFile[]): portability.RestoreCounts {
    return portability.restoreDocument(this.db, records, files);
  }

  /** Promote a project-scoped memory to global scope */
  promote(id: string): boolean {
    return writes.promote(this.db, id);
  }

  /** Count memories by project */
  countByProject(project: string | null): number {
    return stats.countByProject(this.db, project);
  }

  /** Aggregate stats for cairn_stats summary */
  getStats(): {
    total: number;
    active: number;
    invalidated: number;
    byKind: Record<string, number>;
  } {
    return stats.getStats(this.db);
  }

  /** Health metrics for cairn_stats health */
  getHealthMetrics(): {
    confidenceDistribution: { high: number; medium: number; low: number };
    decayCandidates: number;
    neverRecalled: number;
    avgConfidence: number;
    oldestMemory: { id: string; content: string; created_at: string } | null;
    mostRecalled: { id: string; content: string; recall_count: number } | null;
  } {
    return stats.getHealthMetrics(this.db);
  }

  /** Stats by kind */
  getStatsByKind(): Array<{ kind: string; count: number; avgConfidence: number; totalRecalls: number }> {
    return stats.getStatsByKind(this.db);
  }

  /** Stats by project */
  getStatsByProject(): Array<{ project: string | null; count: number; avgConfidence: number; lastActivity: string | null }> {
    return stats.getStatsByProject(this.db);
  }

  /** Find memories matching a cleanup filter (for preview/delete) */
  findByFilter(filter: CleanupFilter, limit = 100): Memory[] {
    return stats.findByFilter(this.db, filter, limit);
  }

  /** Delete memories matching a cleanup filter */
  deleteByFilter(filter: CleanupFilter, limit = 100): number {
    return stats.deleteByFilter(this.db, filter, limit);
  }

  /** Find high-impact pitfalls not in a given set. */
  highImpactPitfalls(
    project: string | null,
    excludeIds: string[],
    minImpact: number,
    limit: number,
  ): Memory[] {
    return briefing.highImpactPitfalls(this.db, project, excludeIds, minImpact, limit);
  }

  /** Find top user profiles for briefing (global scope only) */
  topUserProfiles(limit: number): Memory[] {
    return briefing.topUserProfiles(this.db, limit);
  }
}
