import type {
  MemoryKind,
  LearnableKind,
  MemorySource,
} from '../../constants/index.js';
import type { ContextFingerprint } from '../../utils/fingerprint.js';

// --- Types ------------------------------------------------------------------

export interface Memory {
  id: string;
  content: string;
  kind: MemoryKind;
  project: string | null;
  tags: string[];
  confidence: number;
  source: MemorySource;
  created_at: string;
  last_recalled: string | null;
  recall_count: number;
  invalidated: number;
  surface_count: number;
  impact_count: number;
  fingerprint: ContextFingerprint | null;
  context: { why?: string; how_to_apply?: string } | null;
  anchor: string | null;
  /** Structural CAS counter (schema v27) — bumped by trigger on any
   *  rendered-semantic column write; memory-tool edits compare against it. */
  revision: number;
}

export interface CreateMemoryInput {
  content: string;
  kind: LearnableKind;
  tags?: string[];
  project?: string | null;
  source?: MemorySource;
  /** Authoring agent client (claude, codex, …) — schema v29 provenance.
   *  Defaults to claude; distinct from `source` (capture mechanism). */
  originClient?: string;
  confidence?: number;
  expiresAt?: string;
  fingerprint?: ContextFingerprint;
  context?: { why?: string; how_to_apply?: string };
  /** Pre-computed embedding as Buffer (active-model-dim Float32Array stored
   *  as BLOB — dim comes from the embedding model registry, e.g. 384 for
   *  minilm-l6). Stamped with the active model key on write (schema v26). */
  embedding?: Buffer;
  /** Code-location anchor JSON string */
  anchor?: string;
  /** Backdate created_at (ISO). Internal — benchmark ingestion only; never
   *  exposed through any MCP tool schema. */
  createdAt?: string;
  /** Bypass the dedup/merge check. Internal — benchmark fixtures must keep
   *  per-turn identity so evidence sessions can't be merged away. */
  skipDedup?: boolean;
  /** Bypass truth-maintenance conflict detection (supersession/contradiction).
   *  Internal — benchmark corpora must be preserved verbatim: two opposing
   *  version claims in a haystack are BOTH retrieval targets, and supersession
   *  would hide the older one from search. */
  skipConflictDetection?: boolean;
}

export interface StoreDecisionInput {
  content: string;
  project: string | null;
  source?: MemorySource;
  originClient?: string;
  confidence?: number;
  fingerprint?: ContextFingerprint;
  context?: { why?: string; how_to_apply?: string };
  embedding?: Buffer;
  tags?: string[];
}

export interface StorePitfallInput {
  content: string;
  project: string | null;
  source?: MemorySource;
  originClient?: string;
  confidence?: number;
  fingerprint?: ContextFingerprint;
  context?: { why?: string; how_to_apply?: string };
  embedding?: Buffer;
  tags?: string[];
  anchor?: string;
}

/** Internal input for the unified smart-merge gateway */
export interface StoreMemoryInput {
  content: string;
  project: string | null;
  kind: 'decision' | 'pitfall';
  source?: MemorySource;
  originClient?: string;
  confidence?: number;
  fingerprint?: ContextFingerprint;
  context?: { why?: string; how_to_apply?: string };
  embedding?: Buffer;
  tags?: string[];
  anchor?: string;
}

export interface RecallOptions {
  project?: string | null;
  kind?: MemoryKind;
  maxResults?: number;
  minConfidence?: number;
  /** Skip recall-stat side effects (last_recalled / recall_count). Default
   *  false — production behavior unchanged. Benchmark harnesses set true so
   *  repeated evaluation queries stay order-independent and never perturb
   *  spaced-repetition state. Internal: not exposed via any MCP tool schema. */
  readOnly?: boolean;
}

export interface RecallResult {
  memory: Memory;
  score: number;
}

export interface CreateResult {
  id: string;
  deduplicated: boolean;
  /** Truth-maintenance outcome (observability). Set when this write retired an
   *  older claim (supersededId) or was flagged as conflicting with one
   *  (contradictionWith); the signal names which structural cue fired. */
  supersededId?: string | null;
  contradictionWith?: string | null;
  conflictSignal?: string | null;
}

/** Filter criteria for cleanup preview/delete (findByFilter/deleteByFilter) */
export interface CleanupFilter {
  project?: string;
  kind?: MemoryKind;
  maxConfidence?: number;
  olderThanDays?: number;
  neverRecalled?: boolean;
}

// --- Row type from DB -------------------------------------------------------

export interface MemoryRow {
  id: string;
  content: string;
  kind: string;
  project: string | null;
  tags: string | null;
  confidence: number;
  source: string;
  created_at: string;
  last_recalled: string | null;
  recall_count: number;
  invalidated: number;
  surface_count: number;
  impact_count: number;
  fingerprint: string | null;
  context: string | null;
  embedding: Buffer | null;
  /** Registry key of the model that produced `embedding` (schema v26);
   *  NULL when no embedding is stored. */
  embedding_model: string | null;
  anchor: string | null;
  /** Structural CAS counter (schema v27). */
  revision: number;
  superseded_by?: string | null;
  superseded_at?: string | null;
  rank?: number;
}
