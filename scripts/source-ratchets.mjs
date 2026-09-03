#!/usr/bin/env node
/**
 * Print or re-pin the source-hygiene baselines (see src/utils/source-ratchets.ts).
 *   node scripts/source-ratchets.mjs          # report current counts vs baseline
 *   node scripts/source-ratchets.mjs --write  # re-pin after a cleanup LOWERED counts
 *   node scripts/source-ratchets.mjs --write --force  # accept a RAISE (say why in the commit)
 * Run after `npm run build` (reads the compiled scanner, one source of truth).
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const { numericLiteralCounts, oversizedFiles } = await import(join(REPO, 'dist', 'src', 'utils', 'source-ratchets.js'));
const FIXTURES = join(REPO, 'tests', 'fixtures');
const targets = [
  ['numeric-literal-baseline.json', numericLiteralCounts(REPO)],
  ['file-length-baseline.json', oversizedFiles(REPO)],
];
const write = process.argv.includes('--write');
const force = process.argv.includes('--force');
let refused = false;
for (const [name, current] of targets) {
  const path = join(FIXTURES, name);
  const previous = existsSync(path) ? JSON.parse(readFileSync(path, 'utf-8')) : {};
  const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
  const grew = Object.entries(current).filter(([f, n]) => n > (previous[f] ?? 0));
  console.log(`${name}: ${Object.keys(current).length} files, total ${sum(current)} (baseline total ${sum(previous)}, ${grew.length} file(s) above baseline)`);
  for (const [f, n] of grew) console.log(`  + ${f}: ${n} (baseline ${previous[f] ?? 0})`);
  if (!write) continue;
  if (grew.length > 0 && !force) {
    // The ratchet only turns one way: a baseline is re-pinned after a cleanup
    // LOWERED it. Writing over growth would let the guard be bypassed by the
    // very command it advertises (Codex review); --force is the explicit,
    // reviewable exception.
    console.log(`  REFUSED — ${grew.length} file(s) grew; name the values under src/constants/, or pass --force to accept the raise deliberately`);
    refused = true;
    continue;
  }
  writeFileSync(path, JSON.stringify(current, null, 2) + '\n');
  console.log(`  pinned → ${path}`);
}
if (refused) process.exit(1);
