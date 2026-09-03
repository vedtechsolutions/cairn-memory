/**
 * Session quality signal — telemetry-derived counts, a qualitative label and
 * the compact summary line the next briefing shows. Split from
 * session-end.ts (phase 4).
 */
import type Database from 'better-sqlite3';
import { loadTracker } from '../edit-tracker.js';
import { computeRecallPrecision } from '../../../utils/prediction.js';

export interface SessionQuality {
  errorCount: number;
  toolCallCount: number;
  errorRate: number;
  escalationCount: number;
  compactionCount: number;
  stepsCompleted: number;
  totalSteps: number;
  label: 'smooth' | 'productive' | 'rough' | 'stuck';
  summary: string;
  /** Recall precision: ratio of recalled memories that led to successful outcomes */
  recallPrecision?: number;
}

/** Compute session quality from existing telemetry + tracker data.
 *  Research: informative labels > prescriptive directives (SWE-PRM). */
export function computeSessionQuality(
  db: Database.Database,
  sessionId: string,
  project: string,
  stepsCompleted: number,
  totalSteps: number,
): SessionQuality {
  // Get session start time for telemetry window
  const session = db.prepare(
    'SELECT started_at FROM sessions WHERE id = ?',
  ).get(sessionId) as { started_at: string } | undefined;
  const startedAt = session?.started_at ?? new Date(0).toISOString();
  const endedAt = new Date().toISOString();

  // Error count from error-learning telemetry (time-windowed)
  const errorRow = db.prepare(`
    SELECT COUNT(*) AS n FROM hook_telemetry
    WHERE hook_name = 'error-learning'
      AND event_type NOT IN ('error', 'escalation')
      AND created_at BETWEEN ? AND ?
  `).get(startedAt, endedAt) as { n: number };
  const errorCount = errorRow?.n ?? 0;

  // Tool call count from pitfall-check telemetry (approximate)
  const toolRow = db.prepare(`
    SELECT COUNT(*) AS n FROM hook_telemetry
    WHERE hook_name = 'pitfall-check'
      AND event_type != 'error'
      AND created_at BETWEEN ? AND ?
  `).get(startedAt, endedAt) as { n: number };
  const toolCallCount = toolRow?.n ?? 0;

  // Escalation count (same error 3+ times)
  const escRow = db.prepare(`
    SELECT COUNT(*) AS n FROM hook_telemetry
    WHERE hook_name = 'error-learning'
      AND event_type = 'escalation'
      AND created_at BETWEEN ? AND ?
  `).get(startedAt, endedAt) as { n: number };
  const escalationCount = escRow?.n ?? 0;

  // Compaction count
  const compRow = db.prepare(`
    SELECT COUNT(*) AS n FROM compaction_snapshots
    WHERE session_id = ? AND project = ?
  `).get(sessionId, project) as { n: number };
  const compactionCount = compRow?.n ?? 0;

  // Error rate
  const errorRate = toolCallCount > 0 ? errorCount / toolCallCount : 0;

  // Also check EditTracker for session error key diversity
  let uniqueErrorKeys = 0;
  try {
    const tracker = loadTracker(sessionId);
    if (tracker.sessionId === sessionId) {
      uniqueErrorKeys = Object.keys(tracker.sessionErrorCounts).length;
    }
  } catch { /* best-effort */ }

  // Compute qualitative label
  const label = classifySession(errorRate, escalationCount, errorCount, uniqueErrorKeys);

  // Build summary line (research: compact, diagnostic, no prescriptive directives)
  const summary = buildSummary(label, errorCount, toolCallCount, stepsCompleted, totalSteps, escalationCount, compactionCount);

  // Compute recall precision from session_memories table
  let recallPrecision: number | undefined;
  try {
    const rp = computeRecallPrecision(db, sessionId);
    if (rp.recalled > 0) {
      recallPrecision = Math.round(rp.precision * 1000) / 1000;
    }
  } catch { /* table may not exist on older schemas */ }

  return {
    errorCount,
    toolCallCount,
    errorRate: Math.round(errorRate * 1000) / 1000,
    escalationCount,
    compactionCount,
    stepsCompleted,
    totalSteps,
    label,
    summary,
    recallPrecision,
  };
}

/** Classify session health based on metrics.
 *  Labels are informative, not prescriptive (SWE-PRM research). */
function classifySession(
  errorRate: number,
  escalationCount: number,
  errorCount: number,
  uniqueErrorKeys: number,
): SessionQuality['label'] {
  // Stuck: multiple escalations (same error 3+ times) or very high error diversity
  if (escalationCount >= 2 || (uniqueErrorKeys >= 4 && errorRate > 0.3)) return 'stuck';
  // Rough: high error rate or any escalation
  if (errorRate > 0.2 || escalationCount >= 1 || errorCount >= 5) return 'rough';
  // Smooth: very few or no errors
  if (errorCount <= 1) return 'smooth';
  // Productive: moderate errors but making progress
  return 'productive';
}

/** Build a compact summary line for briefing injection. */
function buildSummary(
  label: SessionQuality['label'],
  errorCount: number,
  toolCallCount: number,
  stepsCompleted: number,
  totalSteps: number,
  escalationCount: number,
  compactionCount: number,
): string {
  const parts: string[] = [];

  // Core ratio
  if (toolCallCount > 0) {
    parts.push(`${errorCount} error${errorCount !== 1 ? 's' : ''} / ${toolCallCount} tool calls`);
  }

  // Plan progress
  if (totalSteps > 0) {
    parts.push(`${stepsCompleted}/${totalSteps} plan steps done`);
  }

  // Escalations (strong signal)
  if (escalationCount > 0) {
    parts.push(`${escalationCount} escalation${escalationCount !== 1 ? 's' : ''}`);
  }

  // Compactions
  if (compactionCount > 0) {
    parts.push(`${compactionCount} compaction${compactionCount !== 1 ? 's' : ''}`);
  }

  const detail = parts.length > 0 ? ` (${parts.join(', ')})` : '';
  return `${label}${detail}`;
}
