/**
 * Decay, cleanup, and maintenance operations.
 * Called periodically or on session start. The sweeps live in the sibling
 * modules (maintenance-cleanup, staleness, consolidation-runner, decay) and
 * are re-exported here so every existing import path keeps working; this
 * module owns the rate-gated orchestration.
 */
import type Database from 'better-sqlite3';
import { DECAY, ROLLOUT_TAILER } from '../constants/index.js';
import { applyConfidenceDecay, expireTtlMemories } from './decay.js';
import {
  archiveUntouchedPlans, cleanupArchivedPlans, cleanupGovernanceEvidence, cleanupSnapshots, cleanupTelemetry,
} from './maintenance-cleanup.js';
import { runAutoPromotion, runConsolidation } from './consolidation-runner.js';

// Incremental Ebbinghaus decay lives in decay.ts; re-exported here so existing
// importers (tests, handlers) keep their `from './maintenance.js'` paths.
export { applyConfidenceDecay, expireTtlMemories } from './decay.js';
export {
  archiveUntouchedPlans, cleanupArchivedPlans, cleanupGovernanceEvidence, cleanupSnapshots, cleanupTelemetry,
  findStaleProjects, forgetProject,
} from './maintenance-cleanup.js';
export {
  runStalenessDetection, updateAnchorsForRenames, weakenDeletedFileMemories, weakenStaleFingerprintMemories,
  weakenZeroImpactPitfalls,
} from './staleness.js';
export { buildEmbeddingSimilarityMap, runAutoPromotion, runConsolidation } from './consolidation-runner.js';

export interface MaintenanceResult {
  decayed: number;
  deleted: number;
  expired: number;
  snapshotsCleaned: number;
  archivedPlansCleaned: number;
  untouchedPlansArchived: number;
  telemetryCleaned: number;
  governanceEvidenceCleaned: number;
  consolidated: number;
  promoted: number;
  /** True when the run was skipped by the rate gate (nothing executed) */
  skipped?: boolean;
}

function getLastMaintenanceMs(db: Database.Database): number | null {
  try {
    const row = db.prepare(
      "SELECT value FROM maintenance_meta WHERE key = 'last_run_at'"
    ).get() as { value: string } | undefined;
    if (!row) return null;
    const ms = Date.parse(row.value);
    return Number.isFinite(ms) ? ms : null;
  } catch {
    return null; // table missing on a pre-v25 DB mid-migration — treat as never run
  }
}

function recordMaintenanceRun(db: Database.Database, nowMs: number): void {
  try {
    db.prepare(`
      INSERT INTO maintenance_meta (key, value) VALUES ('last_run_at', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(new Date(nowMs).toISOString());
  } catch { /* best-effort — a missed record only means one extra sweep */ }
}

/** Run all maintenance tasks. Rate-gated: decay is time-idempotent, so the
 *  gate exists to bound sweep cost (consolidation/promotion scans), not for
 *  correctness. TTL expiration runs BEFORE the gate on every entry — retrieval
 *  paths like tag recall and briefings don't filter expires_at, so a gated
 *  sweep must not leave expired memories surfaceable. `options.force` bypasses
 *  the gate; `options.nowMs` injects a clock for tests. */
export function runMaintenance(
  db: Database.Database,
  currentSessionId?: string,
  options?: { nowMs?: number; force?: boolean },
): MaintenanceResult {
  const nowMs = options?.nowMs ?? Date.now();

  const expired = expireTtlMemories(db, nowMs);
  // Retention is a hard evidence ceiling, so this cheap indexed cleanup runs
  // even when the broader decay/consolidation sweep is rate-gated.
  const governanceCleanup = cleanupGovernanceEvidence(db, { nowMs });

  // Codex hook/tailer dedup markers (parity Slice B): pruned HERE — not in
  // the tailer — because the hook path writes them on every hosting mode
  // (MCP-embedded socket included) while the tailer only runs in the
  // standalone daemon. Runs pre-gate: one row per codex tool call adds up.
  try {
    const markerCutoff = new Date(nowMs - ROLLOUT_TAILER.MARKER_TTL_MS).toISOString();
    db.prepare(
      "DELETE FROM maintenance_meta WHERE key LIKE 'codex_seen:%' AND value < ?",
    ).run(markerCutoff);
  } catch { /* best-effort */ }

  const lastRun = getLastMaintenanceMs(db);
  const minIntervalMs = DECAY.MAINTENANCE_MIN_INTERVAL_HOURS * 3_600_000;
  if (!options?.force && lastRun !== null && nowMs - lastRun < minIntervalMs) {
    return {
      decayed: 0, deleted: 0, expired, snapshotsCleaned: 0,
      archivedPlansCleaned: 0, untouchedPlansArchived: 0, telemetryCleaned: 0,
      governanceEvidenceCleaned:
        governanceCleanup.gateRunsDeleted + governanceCleanup.toolEventsDeleted,
      consolidated: 0, promoted: 0, skipped: true,
    };
  }

  const decay = applyConfidenceDecay(db, nowMs);
  const snapshotsCleaned = cleanupSnapshots(db, currentSessionId);
  const archivedPlansCleaned = cleanupArchivedPlans(db);
  const untouchedPlansArchived = archiveUntouchedPlans(db);
  const telemetryCleaned = cleanupTelemetry(db);
  const consolidation = runConsolidation(db);
  const promotion = runAutoPromotion(db);
  recordMaintenanceRun(db, nowMs);

  return {
    ...decay,
    expired,
    snapshotsCleaned,
    archivedPlansCleaned,
    untouchedPlansArchived,
    telemetryCleaned,
    governanceEvidenceCleaned:
      governanceCleanup.gateRunsDeleted + governanceCleanup.toolEventsDeleted,
    consolidated: consolidation.merged,
    promoted: promotion.promoted,
  };
}
