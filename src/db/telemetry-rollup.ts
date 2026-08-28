/**
 * Durable tokens-saved aggregates (schema v30, `telemetry_rollup`).
 *
 * hook_telemetry answers "are the hooks healthy" and is pruned at 7 days;
 * this table answers "what is Cairn worth in tokens" and keeps a year.
 * One row per (session, surface) event, written best-effort from the
 * hook handlers — a rollup failure must never affect a hook, and when
 * disabled (config `report.rollup: false`, or CAIRN_ROLLUP=0) the write
 * path is a true no-op: zero statements executed.
 *
 * The METRIC vocabulary is internal (constants), and the report is
 * honest about provenance: `compact_saved` is client-reported,
 * `impact_proxy` is an ESTIMATE (impact events × a documented constant),
 * `injected` is a cost, and net = gross − cost.
 */
import type Database from 'better-sqlite3';
import { loadCairnConfig } from '../config/cairn-config.js';
import { ROLLUP, ROLLUP_METRICS } from '../constants/index.js';

export type RollupMetric = (typeof ROLLUP_METRICS)[keyof typeof ROLLUP_METRICS];

export function rollupEnabled(): boolean {
  if (process.env.CAIRN_ROLLUP === '0') return false;
  return loadCairnConfig().report.rollup !== false;
}

/** Best-effort insert; skips zero/negative token counts (an empty
 *  injection costs nothing and a zero row is pure noise). */
export function recordRollup(
  db: Database.Database,
  sessionId: string,
  metric: RollupMetric,
  surface: string,
  tokens: number,
): void {
  if (tokens <= 0) return;
  if (!rollupEnabled()) return;
  try {
    db.prepare(`
      INSERT INTO telemetry_rollup (session_id, day, metric, surface, tokens)
      VALUES (?, date('now'), ?, ?, ?)
    `).run(sessionId, metric, surface, Math.round(tokens));
  } catch {
    // Rollup must never affect hook behavior (e.g. a pre-v30 database).
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
  const rows = db.prepare(`
    SELECT day, metric, surface, SUM(tokens) AS tokens, COUNT(*) AS events
    FROM telemetry_rollup
    WHERE day >= date('now', ?)
    GROUP BY day, metric, surface
    ORDER BY day
  `).all(`-${days} days`) as Array<{ day: string; metric: string; surface: string; tokens: number; events: number }>;

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
      impactEvents += row.tokens / ROLLUP.IMPACT_PROXY_TOKENS;
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
    impactEvents: Math.round(impactEvents),
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
