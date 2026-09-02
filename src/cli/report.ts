import { NAMESPACE } from 'waykeep-contract';
/**
 * `waykeep report` — the tokens-saved report.
 *
 * HONESTY RULES (the metric is defined, not implied): gross has two
 * components with different provenance — `compact-saved` is CLIENT-
 * REPORTED (the agent's own PostCompact tokens_saved) and `impact-proxy`
 * is an ESTIMATE (verified impact events × a documented constant). The
 * cost column is what Waykeep itself injected. Net = gross − cost, and the
 * output labels every estimated number as an estimate. Read-only.
 */
import { existsSync } from 'node:fs';
import { resolveDbPath } from '../db/db-path.js';
import { ROLLUP } from '../constants/index.js';
import { computeRollupReport } from '../db/telemetry-rollup.js';
import { ENV } from '../constants/env.js';
import { CONFIG_DISPLAY_PATH } from '../constants/paths.js';

export async function runReport(days: number = ROLLUP.REPORT_DAYS): Promise<number> {
  const path = resolveDbPath(process.env[ENV.DB_PATH]);
  if (!existsSync(path)) {
    console.log(`waykeep report — no database yet at ${path} (nothing recorded).`);
    return 0;
  }
  const Database = (await import('better-sqlite3')).default;
  const db = new Database(path, { readonly: true });
  try {
    // Distinguish 'table absent' (pre-v30 — honest degrade) from every
    // OTHER failure (corruption, lock, future schema): conflating them
    // would report a real error as a version message (review P3).
    const hasTable = db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'telemetry_rollup'",
    ).get() !== undefined;
    if (!hasTable) {
      console.log(`${NAMESPACE} report — no rollup data (database predates schema v30; data accrues from the next session).`);
      return 0;
    }
    // A stale v30 shape (events column added while v30 was unreleased):
    // this READONLY connection cannot migrate — any session or `cairn
    // doctor` heals it on open. Degrade honestly instead of erroring.
    const columns = db.prepare('PRAGMA table_info(telemetry_rollup)').all() as Array<{ name: string }>;
    if (!columns.some((c) => c.name === 'events')) {
      console.log('waykeep report — rollup schema needs a one-time upgrade; run any session (or `waykeep doctor`) first, then re-run.');
      return 0;
    }
    const report = computeRollupReport(db, days);

    console.log(`waykeep report — tokens saved, last ${report.days} days\n`);
    if (report.gross === 0 && report.cost === 0) {
      console.log('  No data recorded in this window yet. Rollup rows accrue as sessions');
      console.log('  run (compactions, briefings, verified pitfall saves).');
      return 0;
    }

    console.log(`  Gross savings:   ${fmt(report.gross)} tokens`);
    console.log(`    compact-saved: ${fmt(report.compactSaved)}  (client-reported by your agent)`);
    // Only show the ×rate arithmetic when it actually reproduces the
    // total — rows written under an older tuning constant must not be
    // relabeled at the current rate.
    const rateLabel = report.impactProxy === report.impactEvents * ROLLUP.IMPACT_PROXY_TOKENS
      ? ` × ${ROLLUP.IMPACT_PROXY_TOKENS} tokens` : ' (mixed rates)';
    console.log(`    impact-proxy:  ${fmt(report.impactProxy)}  (ESTIMATE: ${report.impactEvents} verified impact${report.impactEvents === 1 ? '' : 's'}${rateLabel})`);
    console.log(`  Injection cost:  ${fmt(report.cost)} tokens`);
    for (const [surface, tokens] of Object.entries(report.costBySurface).sort((a, b) => b[1] - a[1])) {
      console.log(`    ${surface.padEnd(16)} ${fmt(tokens)}`);
    }
    console.log(`  Net:             ${fmt(report.net)} tokens ${report.net >= 0 ? 'saved' : 'SPENT (cost exceeds measured+estimated savings)'}\n`);

    if (report.perDay.length > 1) {
      console.log('  Day          Gross      Cost       Net');
      for (const d of report.perDay) {
        console.log(`  ${d.day}  ${fmt(d.gross).padStart(8)}  ${fmt(d.cost).padStart(8)}  ${fmt(d.net).padStart(8)}`);
      }
      console.log('');
    }
    console.log('  Notes: impact-proxy is an estimate, not a measurement; days are UTC.');
    console.log('  Not counted: governance policy nudges, and async-hook text the agent');
    console.log('  never receives (a known delivery gap, tracked separately).');
    console.log(`  Disable recording with {"report":{"rollup":false}} in ${CONFIG_DISPLAY_PATH} or ${ENV.ROLLUP}=0.`);
    return 0;
  } finally {
    db.close();
  }
}

function fmt(n: number): string {
  return n.toLocaleString('en-US');
}
