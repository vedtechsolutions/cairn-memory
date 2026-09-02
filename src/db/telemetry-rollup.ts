/**
 * Durable tokens-saved aggregates (schema v30, `telemetry_rollup`).
 *
 * hook_telemetry answers "are the hooks healthy" and is pruned at 7 days;
 * this table answers "what is Waykeep worth in tokens" and keeps a year.
 * One row per (session, surface) event, written best-effort from the
 * hook handlers — a rollup failure must never affect a hook, and when
 * disabled (config `report.rollup: false`, or WAYKEEP_ROLLUP=0) the write
 * path is a true no-op: zero statements executed.
 *
 * The METRIC vocabulary is internal (constants), and the report is
 * honest about provenance: `compact_saved` is client-reported,
 * `impact_proxy` is an ESTIMATE (impact events × a documented constant),
 * `injected` is a cost, and net = gross − cost.
 */
import type Database from 'better-sqlite3';
import { loadWaykeepConfig } from '../config/waykeep-config.js';
import { ROLLUP, ROLLUP_METRICS } from '../constants/index.js';
import { ENV } from '../constants/env.js';

export type RollupMetric = (typeof ROLLUP_METRICS)[keyof typeof ROLLUP_METRICS];

export function rollupEnabled(): boolean {
  // '0' matches the WAYKEEP_TAILER convention; 'false' is accepted because
  // it is the obvious guess and silently ignoring it breaks the opt-out.
  const env = process.env[ENV.ROLLUP];
  if (env === '0' || env === 'false') return false;
  return loadWaykeepConfig().report.rollup !== false;
}

/** Contention budget for a rollup write, ms. The connection's global
 *  busy_timeout is 5s — longer than both relays' 3s deadlines, so a
 *  contended ROLLUP insert on a sync path could starve a ready briefing
 *  out of its delivery window (review P1). A bookkeeping row is never
 *  worth that: give it a near-zero budget and drop it on contention. */
const ROLLUP_BUSY_TIMEOUT_MS = 50;

/** Best-effort insert; skips zero/negative token counts (an empty
 *  injection costs nothing and a zero row is pure noise). `events`
 *  persists the event COUNT so the report never has to reverse-derive it
 *  from tokens ÷ a tuning constant that may since have changed. */
export function recordRollup(
  db: Database.Database,
  sessionId: string,
  metric: RollupMetric,
  surface: string,
  tokens: number,
  events = 1,
): void {
  if (tokens <= 0) return;
  if (!rollupEnabled()) return;
  let restoreTimeout: number | null = null;
  try {
    restoreTimeout = db.pragma('busy_timeout', { simple: true }) as number;
    db.pragma(`busy_timeout = ${ROLLUP_BUSY_TIMEOUT_MS}`);
    db.prepare(`
      INSERT INTO telemetry_rollup (session_id, day, metric, surface, tokens, events)
      VALUES (?, date('now'), ?, ?, ?, ?)
    `).run(sessionId, metric, surface, Math.round(tokens), events);
  } catch {
    // Rollup must never affect hook behavior (pre-v30 DB, contention, …).
  } finally {
    if (restoreTimeout !== null) {
      try { db.pragma(`busy_timeout = ${restoreTimeout}`); } catch { /* best-effort */ }
    }
  }
}

export interface RollupReport {
  days: number;
  /** Client-reported PostCompact savings. */
  compactSaved: number;
  /** Estimated: impact events × ROLLUP.IMPACT_PROXY_TOKENS. */
  impactProxy: number;
  impactEvents: number;
  gross: number;
  /** Injected context cost, total and per surface. */
  cost: number;
  costBySurface: Record<string, number>;
  net: number;
  perDay: Array<{ day: string; gross: number; cost: number; net: number }>;
}

/** Aggregate the window. Exported for the CLI and for tests to check
 *  hand-computed numbers against the same arithmetic the user sees. */
export function computeRollupReport(db: Database.Database, days: number = ROLLUP.REPORT_DAYS): RollupReport {
  // `-${days-1}`: an inclusive lower bound at -N selects N+1 calendar
  // dates (review P2) — days=1 must mean today only. Days are UTC.
  const rows = db.prepare(`
    SELECT day, metric, surface, SUM(tokens) AS tokens, SUM(events) AS events
    FROM telemetry_rollup
    WHERE day >= date('now', ?)
    GROUP BY day, metric, surface
    ORDER BY day
  `).all(`-${Math.max(0, days - 1)} days`) as Array<{ day: string; metric: string; surface: string; tokens: number; events: number }>;

  let compactSaved = 0;
  let impactProxy = 0;
  let impactEvents = 0;
  let cost = 0;
  const costBySurface: Record<string, number> = {};
  const byDay = new Map<string, { gross: number; cost: number }>();

  for (const row of rows) {
    const day = byDay.get(row.day) ?? { gross: 0, cost: 0 };
    if (row.metric === ROLLUP_METRICS.COMPACT_SAVED) {
      compactSaved += row.tokens;
      day.gross += row.tokens;
    } else if (row.metric === ROLLUP_METRICS.IMPACT_PROXY) {
      impactProxy += row.tokens;
      // Persisted count — NEVER tokens ÷ the current constant, which
      // would mislabel rows written under an older tuning value.
      impactEvents += row.events;
      day.gross += row.tokens;
    } else if (row.metric === ROLLUP_METRICS.INJECTED) {
      cost += row.tokens;
      costBySurface[row.surface] = (costBySurface[row.surface] ?? 0) + row.tokens;
      day.cost += row.tokens;
    }
    byDay.set(row.day, day);
  }

  const gross = compactSaved + impactProxy;
  return {
    days,
    compactSaved,
    impactProxy,
    impactEvents,
    gross,
    cost,
    costBySurface,
    net: gross - cost,
    perDay: [...byDay.entries()].map(([day, v]) => ({ day, gross: v.gross, cost: v.cost, net: v.gross - v.cost })),
  };
}

/** Long-retention prune (maintenance). */
export function pruneRollup(db: Database.Database): number {
  try {
    return db.prepare(
      `DELETE FROM telemetry_rollup WHERE created_at < datetime('now', '-${ROLLUP.RETENTION_DAYS} days')`,
    ).run().changes;
  } catch {
    return 0;
  }
}
