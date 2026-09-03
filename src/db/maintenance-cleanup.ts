/**
 * Retention sweeps: compaction snapshots, untouched and archived plans, a
 * project's ordinary memories, stale projects, hook telemetry, and the
 * audited governance evidence ceiling. Split from maintenance.ts (phase 4).
 */
import type Database from 'better-sqlite3';
import { pruneRollup } from './telemetry-rollup.js';
import { LIMITS } from '../constants/index.js';
import { now } from '../utils/index.js';
import { GovernanceRepository } from '../governance/repository.js';
import { journalTombstonesForIds } from './memory-repository/journal.js';

/** Clean up old compaction snapshots (time-based retention) */
export function cleanupSnapshots(db: Database.Database, _currentSessionId?: string): number {
  const result = db.prepare(`
    DELETE FROM compaction_snapshots
    WHERE captured_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-' || ? || ' hours')
  `).run(LIMITS.SNAPSHOT_RETENTION_HOURS);
  return result.changes;
}

/** Auto-archive active plans where ALL steps are still pending (never started)
 *  and the plan hasn't been updated within PLAN_UNTOUCHED_ARCHIVE_HOURS.
 *  Prevents stale plans from leaking into briefings across sessions. */
export function archiveUntouchedPlans(db: Database.Database): number {
  // Find active plans older than the threshold
  const cutoff = new Date();
  cutoff.setHours(cutoff.getHours() - LIMITS.PLAN_UNTOUCHED_ARCHIVE_HOURS);
  const cutoffIso = cutoff.toISOString();

  const stalePlans = db.prepare(`
    SELECT p.id FROM plans p
    WHERE p.status = 'active'
      AND p.updated_at < ?
      AND NOT EXISTS (
        SELECT 1 FROM plan_steps ps
        WHERE ps.plan_id = p.id AND ps.status != 'pending'
      )
  `).all(cutoffIso) as Array<{ id: string }>;

  if (stalePlans.length === 0) return 0;

  const timestamp = now();
  const updateStmt = db.prepare(
    "UPDATE plans SET status = 'abandoned', updated_at = ? WHERE id = ?"
  );
  for (const plan of stalePlans) {
    updateStmt.run(timestamp, plan.id);
  }
  return stalePlans.length;
}

/** Clean up archived plans older than the retention period */
export function cleanupArchivedPlans(db: Database.Database): number {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - LIMITS.ARCHIVED_PLAN_CLEANUP_DAYS);

  const result = db.prepare(`
    DELETE FROM plans
    WHERE status IN ('completed', 'abandoned')
      AND updated_at < ?
  `).run(cutoff.toISOString());

  return result.changes;
}

/** Delete ordinary memories for a project. Governance policy has its own
 * explicit audited project-cleanup lifecycle. */
export function forgetProject(db: Database.Database, project: string, opts?: import('./memory-repository/journal.js').JournalOptions): number {
  // Explicit bulk retraction (journal.ts): log + journal, then delete.
  return db.transaction(() => {
    db.prepare(`
      INSERT INTO memory_tombstones (memory_id, action, project, kind, content, deleted_at)
      SELECT id, 'delete', project, kind, content, datetime('now')
      FROM memories WHERE project = ? AND kind != 'rule'
    `).run(project);
    const ids = (db.prepare("SELECT id FROM memories WHERE project = ? AND kind != 'rule'").all(project) as Array<{ id: string }>).map(r => r.id);
    journalTombstonesForIds(db, ids, opts);
    const result = db.prepare("DELETE FROM memories WHERE project = ? AND kind != 'rule'").run(project);
    return result.changes;
  })();
}

/** Find stale projects (no recall in N days) */
export function findStaleProjects(db: Database.Database): string[] {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - LIMITS.STALE_PROJECT_DAYS);

  const rows = db.prepare(`
    SELECT DISTINCT project FROM memories
    WHERE project IS NOT NULL
      AND invalidated = 0
      AND kind != 'rule'
      AND (last_recalled IS NULL OR last_recalled < ?)
    GROUP BY project
    HAVING MAX(COALESCE(last_recalled, created_at)) < ?
  `).all(cutoff.toISOString(), cutoff.toISOString()) as Array<{ project: string }>;

  return rows.map(r => r.project);
}

/** Clean up old hook telemetry (keep 7 days) */
export function cleanupTelemetry(db: Database.Database): number {
  try {
    const result = db.prepare(`
      DELETE FROM hook_telemetry WHERE created_at < datetime('now', '-7 days')
    `).run();
    // telemetry_rollup outlives the 7-day prune BY DESIGN (the tokens-
    // saved report needs months); it gets its own long retention.
    pruneRollup(db);
    return result.changes;
  } catch {
    return 0; // Table may not exist yet
  }
}

/** Governance evidence has a hard 30-day ceiling and an audited cleanup. */
export function cleanupGovernanceEvidence(
  db: Database.Database,
  options: { evidenceDays?: number; projectDays?: Readonly<Record<string, number>>; nowMs?: number } = {},
): { gateRunsDeleted: number; toolEventsDeleted: number; projectsAudited: number } {
  return new GovernanceRepository(db).cleanupEvidence(options);
}
