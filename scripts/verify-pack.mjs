#!/usr/bin/env node
/**
 * prepack gate: the tarball must be able to carry its bundled contract.
 * npm pack/publish silently produce a contract-less artifact when
 * node_modules/cairn-contract is absent (the original ship-blocker
 * reintroduced), and a version-pin drift makes installs fall through to
 * the registry for an unpublished name. Fail the pack before either can
 * happen. Silent on success — `npm pack --json` parses stdout.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const fail = (msg) => {
  console.error(`verify-pack: ${msg}`);
  process.exit(1);
};

const installedDist = join(ROOT, 'node_modules', 'cairn-contract', 'dist', 'index.js');
if (!existsSync(installedDist)) {
  fail('node_modules/cairn-contract/dist is missing — the tarball would ship WITHOUT its bundled contract (fatal at install). Run `npm install && npm run build` first.');
}

const rootPkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
const contractPkg = JSON.parse(readFileSync(join(ROOT, 'packages', 'contract', 'package.json'), 'utf-8'));
const pin = rootPkg.dependencies?.['cairn-contract'];
if (pin !== contractPkg.version) {
  fail(`version-pin drift: root depends on cairn-contract@${pin} but packages/contract is ${contractPkg.version} — installs would hit the registry for an unpublished name`);
}
if (!(rootPkg.bundleDependencies ?? []).includes('cairn-contract')) {
  fail('bundleDependencies must include cairn-contract or the tarball ships without it');
}
