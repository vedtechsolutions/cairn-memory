/**
 * `cairn report` — the tokens-saved report.
 *
 * HONESTY RULES (the metric is defined, not implied): gross has two
 * components with different provenance — `compact-saved` is CLIENT-
 * REPORTED (the agent's own PostCompact tokens_saved) and `impact-proxy`
 * is an ESTIMATE (verified impact events × a documented constant). The
 * cost column is what Cairn itself injected. Net = gross − cost, and the
 * output labels every estimated number as an estimate. Read-only.
 */
import { existsSync } from 'node:fs';
import { resolveDbPath } from '../db/db-path.js';
import { ROLLUP } from '../constants/index.js';
import { computeRollupReport } from '../db/telemetry-rollup.js';

export async function runReport(days: number = ROLLUP.REPORT_DAYS): Promise<number> {
  const path = resolveDbPath(process.env.CAIRN_DB_PATH);
  if (!existsSync(path)) {
    console.log(`cairn report — no database yet at ${path} (nothing recorded).`);
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
      console.log('cairn report — no rollup data (database predates schema v30; data accrues from the next session).');
      return 0;
    }
    const report = computeRollupReport(db, days);

    console.log(`cairn report — tokens saved, last ${report.days} days\n`);
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
    console.log('  Disable recording with {"report":{"rollup":false}} in ~/.cairn/config.json or CAIRN_ROLLUP=0.');
    return 0;
  } finally {
    db.close();
  }
}

function fmt(n: number): string {
  return n.toLocaleString('en-US');
}
