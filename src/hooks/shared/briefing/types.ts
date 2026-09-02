/** Shared briefing types — the compiler's input context and output shape. */
import type { ProjectContext, GitWorkingState } from '../../../utils/project-scanner.js';
import type { GovernanceBriefingSection } from '../../../governance/briefing.js';

export interface BriefingContext {
  project: string | null;
  sessionType: 'startup' | 'compact' | 'resume' | 'clear';
  interrupted: boolean;
  maxPitfalls?: number;
  /** SNR v3 Commit 4: three-tier goal rendering — Now / Feature / Project.
   *
   *  Project (this field): durable branch-spanning goal. Sourced from
   *  waykeep_plan(create), waykeep_learn corrections, or transcript mining —
   *  anything EXCEPT branch-name synthesis. Staleness = explicit pivot only;
   *  never auto-drops on branch change or shipped detection.
   *
   *  source ∈ {'transcript' | 'plan' | 'user'} after Commit 4. The old
   *  'branch' source is split out into `featureGoal` below so both tiers
   *  can coexist (a durable project goal + a per-branch feature goal). */
  projectGoal?: { text: string; source: string; capturedAt?: string | null } | null;
  /** SNR v3 Commit 4: Feature-tier goal — branch-scoped synthesis. Rendered
   *  as the middle tier between Now (per-turn task) and Project (durable).
   *  Staleness gates: branch mismatch + carryCount + completedStep + shipped
   *  by commit (reuses `evaluateCarriedGoal` — same logic as initialGoal).
   *  Populated by session-start-handler by querying the most recent
   *  compaction_snapshots row with project_goal_source='branch'. */
  featureGoal?: { text: string; capturedAt?: string | null; branch?: string | null } | null;
  /** SNR v3 Commit 4: current session id — used by the Now-tier staleness
   *  gate to drop goals carried from a different session. When the reader
   *  is resuming the same session that wrote the snapshot, Now is fresh;
   *  when it's falling back to "any recent snap in this project", the
   *  session_id differs and Now is treated as stale (Feature/Project may
   *  still survive). Optional so tests can omit it without breaking. */
  currentSessionId?: string | null;
  /** Resume cursor — last successful edit location (Phase 2). Surfaced as
   *  "Resume: <basename>:<line> (<tool>, Nm ago)" when fresh. Suppressed when
   *  older than LIMITS.RESUME_CURSOR_STALE_MS — a long context switch is
   *  cheaper to resolve by re-reading the file than trusting a stale pointer.
   *  Populated by session-start-handler from the persisted EditTracker. */
  lastEditCursor?: {
    file: string;
    line: number | null;
    tool: 'Write' | 'Edit' | 'MultiEdit';
    at: number;
  } | null;
  previousSessionSummary?: string | null;
  previousSessionQuality?: { label: string; summary: string } | null;
  compactionSnapshot?: {
    recentFiles: string[];
    recentReadFiles: string[];
    recentCommands: Array<{ command: string; outputSummary: string }>;
    userContext: string[];
    approachNotes: string[];
    initialGoal: string | null;
    /** SNR v3 Commit 4: when `initialGoal` was first captured. Inherited
     *  across snapshots so the Now-tier age clock doesn't reset on every
     *  compaction. Drives the "Nm/h/d ago" label. Null for rows written
     *  before schema v23 or when no goal was captured at all. */
    goalCapturedAt?: string | null;
    /** SNR v3 Commit 4: the session_id this snapshot was captured in.
     *  Now-tier staleness drops the goal when the reader's session_id
     *  differs — short-tier goals never survive across sessions. */
    snapshotSessionId?: string | null;
    goalBranch?: string | null;
    goalCarryCount?: number;
    recentDecisions?: Array<{ chose: string; why: string }>;
    reasoningState?: { hypotheses: string[]; openQuestions: string[] };
    errorContext?: Array<{ errorKey: string; errorText?: string; count: number; lastFile: string | null }>;
    /** GAP G: memory IDs already injected pre-compact (from tracker.injectedMemoryIds).
     *  compileIndexBriefing filters these out in compact mode so Claude gets
     *  "what was lost" instead of re-surfacing what it already saw. */
    alreadySurfacedMemoryIds?: string[];
  };
  projectContext?: ProjectContext;
  gitState?: GitWorkingState | null;
  planUpdatedAt?: string | null;
  /** Pre-fetched resolved investigation chains for briefing (caller provides) */
  resolvedChains?: Array<{
    trigger_error: string;
    attempts: Array<{ approach: string }>;
    resolution: string | null;
  }>;
  /** Pre-fetched structured user model compact string (caller provides) */
  structuredUserProfile?: string | null;
  /** Dynamic budget override — scales with available context window */
  budgetOverride?: number;
  /**
   * Briefing rendering mode. 'full' emits the tier-based detail briefing,
   * 'index' emits a compact progressive-disclosure index with stable ID
   * prefixes that Claude passes to waykeep_expand on demand. 'auto' picks
   * full on startup/clear and index on compact/resume. Defaults to the
   * BRIEFING_MODE.DEFAULT constant.
   */
  briefingMode?: 'full' | 'index' | 'auto';
  /** Bounded, redacted advisory governance status. Omitted for non-governed projects. */
  governance?: GovernanceBriefingSection | null;
}

export interface BriefingOutput {
  text: string;
  tokenEstimate: number;
  /** IDs of pitfalls included in this briefing (for correction pass) */
  includedPitfallIds: string[];
  /** All memory IDs rendered in this briefing — for cross-hook dedup */
  renderedMemoryIds: string[];
}
