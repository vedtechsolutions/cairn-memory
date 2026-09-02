#!/usr/bin/env node
/**
 * Explicit confidence repair for stores crushed by the pre-v25 compounding
 * decay bug.
 *
 * Safety model (per Codex review):
 *   - Dry run (default) opens a READ-ONLY raw connection — it cannot migrate
 *     or otherwise write to the database. Its only output is stdout and the
 *     review CSV (intentional).
 *   - --execute takes an online backup (SQLite backup API, WAL-safe) from the
 *     read-only connection BEFORE the database is opened writable/migrated,
 *     so a v24 operator gets a pre-migration backup.
 *   - Analysis is re-run on the writable connection after backup/migration,
 *     and executeRepair re-checks every condition at write time with a
 *     monotone MAX lift — a concurrently boosted/invalidated/superseded
 *     memory is never lowered or touched.
 *
 * Usage:
 *   node scripts/repair-confidence.mjs                 # dry run against ~/.waykeep/waykeep.db (legacy ~/.cairn/cairn.db until migration)
 *   node scripts/repair-confidence.mjs --db /path/x.db # dry run against another store
 *   node scripts/repair-confidence.mjs --execute       # backup, migrate, re-analyze, apply
 *
 * The recalled-but-never-impactful review cohort goes to a CSV (default
 * <state dir>/repair-review-<timestamp>.csv) for human triage — those memories
 * have no outcome evidence and are never auto-lifted.
 */
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { analyzeRepair, executeRepair, toReviewCsv } from '../dist/src/db/repair.js';

const args = process.argv.slice(2);
const execute = args.includes('--execute');
const argValue = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
};

// THE coherent state root (Phase B): mutating the DB while the running
// server serves a different root would corrupt/split state — a
// standalone existsSync check independently recreated the fork hazard
// (codex B1 review). resolveStateRoot is marker-aware and shared.
const { resolveStateRoot } = await import('../dist/src/constants/paths.js');
const ROOT = resolveStateRoot();
const dbPath = argValue('--db') ?? join(ROOT.dir, ROOT.dbFilename);
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const csvPath = argValue('--csv') ?? join(ROOT.dir, `repair-review-${stamp}.csv`);

function report(analysis) {
  const byKind = new Map();
  for (const c of analysis.candidates) {
    byKind.set(c.kind, (byKind.get(c.kind) ?? 0) + 1);
  }
  console.log(`Lift candidates (evidence-backed, below their surfacing target): ${analysis.candidates.length}`);
  for (const [kind, n] of [...byKind.entries()].sort()) {
    console.log(`  ${kind}: ${n}`);
  }
  for (const c of analysis.candidates.slice(0, 10)) {
    console.log(`  [${c.reason}] ${c.kind} ${c.confidence.toFixed(2)} -> ${c.target.toFixed(2)}  ${c.content.slice(0, 70)}`);
  }
  if (analysis.candidates.length > 10) {
    console.log(`  ... and ${analysis.candidates.length - 10} more`);
  }
  console.log(`Review cohort (recalled, zero impact — exported, never auto-lifted): ${analysis.review.length}`);
  if (analysis.review.length > 0) {
    writeFileSync(csvPath, toReviewCsv(analysis.review));
    console.log(`Review CSV written: ${csvPath}`);
  }
}

console.log(`Store: ${dbPath}`);

if (!execute) {
  // Read-only raw connection: no openDatabase, no migration, no writes.
  let roDb;
  try {
    roDb = new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch (err) {
    console.error(`Cannot open ${dbPath} read-only: ${err.message}`);
    process.exit(1);
  }
  try {
    report(analyzeRepair(roDb));
    console.log('\nDRY RUN — no confidence changes (review CSV above is the only file written).');
    console.log('Re-run with --execute to back up, migrate if needed, and apply.');
  } catch (err) {
    console.error(`Analysis failed (store schema may predate v24): ${err.message}`);
    process.exit(1);
  } finally {
    roDb.close();
  }
  process.exit(0);
}

// --execute: backup FIRST (read-only online backup — pre-migration state),
// then open writable (migrates), then RE-analyze, then apply.
const backupPath = `${dbPath}.bak-${stamp}`;
{
  const roDb = new Database(dbPath, { readonly: true, fileMustExist: true });
  await roDb.backup(backupPath);
  roDb.close();
  console.log(`Backup written (pre-migration state): ${backupPath}`);
}

const { openDatabase } = await import('../dist/src/db/connection.js');
const db = openDatabase({ dbPath });
const analysis = analyzeRepair(db);
report(analysis);

const { repaired } = executeRepair(db, analysis);
console.log(`Repaired ${repaired} memories (monotone lift to surfacing targets; decay epoch reset).`);
console.log('Note: original confidence values are unrecoverable — this restores surfaceability, not history.');
db.close();
