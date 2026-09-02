#!/usr/bin/env node
/**
 * CI dependency audit gate.
 *
 * `npm audit` alone can't pass while known-unfixable transitive advisories
 * exist, and blanket-ignoring severities hides real ones. This gate fails on
 * any PRODUCTION (`--omit=dev`) high/critical advisory whose package is not on
 * the dated allowlist (.github/audit-allowlist.json), and additionally fails
 * when an allowlist entry is past its review-by date — so accepted risk can
 * never silently become permanent.
 *
 * Exit codes: 0 clean, 1 gate failure, 2 gate self-error.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ALLOWLIST_PATH = join(ROOT, '.github', 'audit-allowlist.json');
const BLOCKING_SEVERITIES = new Set(['high', 'critical']);

/** npm audit exits non-zero whenever advisories exist, so capture stdout from
 *  the thrown error rather than treating that exit as a gate self-error. */
function runAuditJson() {
  try {
    return execFileSync('npm', ['audit', '--omit=dev', '--json'], {
      cwd: ROOT, encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024,
    });
  } catch (err) {
    if (typeof err.stdout === 'string' && err.stdout.length > 0) return err.stdout;
    throw err;
  }
}

function main() {
  const allowlist = JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf-8'));
  const allowed = new Map(allowlist.allow.map((entry) => [entry.package, entry]));
  const now = new Date();

  const expired = allowlist.allow.filter((entry) => new Date(entry.reviewBy) < now);
  if (expired.length > 0) {
    console.error('Audit gate FAILED: allowlist entries past their review-by date:');
    for (const entry of expired) console.error(`  - ${entry.package} (reviewBy ${entry.reviewBy})`);
    console.error('Re-evaluate the advisory and extend or remove the exception.');
    process.exit(1);
  }

  const audit = JSON.parse(runAuditJson());
  const offenders = [];
  for (const [name, record] of Object.entries(audit.vulnerabilities ?? {})) {
    if (!BLOCKING_SEVERITIES.has(record.severity)) continue;
    if (allowed.has(name)) continue;
    offenders.push({ name, severity: record.severity });
  }

  if (offenders.length > 0) {
    console.error('Audit gate FAILED: unlisted high/critical advisories:');
    for (const offender of offenders) console.error(`  - ${offender.name} (${offender.severity})`);
    console.error('Fix in-range (npm audit fix), or add a dated exception to');
    console.error('.github/audit-allowlist.json if the advisory is unreachable in Waykeep.');
    process.exit(1);
  }

  const names = [...allowed.keys()].join(', ');
  console.log(`Audit gate passed: no unlisted high/critical advisories (allowlisted: ${names || 'none'}).`);
}

try {
  main();
} catch (err) {
  console.error('Audit gate self-error:', err instanceof Error ? err.message : err);
  process.exit(2);
}
