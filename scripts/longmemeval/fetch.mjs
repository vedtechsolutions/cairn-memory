#!/usr/bin/env node
/**
 * Download a LongMemEval dataset file at the manifest-pinned revision and
 * verify its sha256 against the manifest. Never used by CI (CI runs on the
 * checked-in fixture only). Cache lives OUTSIDE the repo and outside the live
 * store's directory semantics: ~/.cairn/benchmarks/longmemeval/.
 *
 * Usage:
 *   node scripts/longmemeval/fetch.mjs                                # longmemeval_s_cleaned.json
 *   node scripts/longmemeval/fetch.mjs --file longmemeval_oracle.json
 */
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const here = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(await readFile(join(here, 'manifest.json'), 'utf8'));

const args = process.argv.slice(2);
const argValue = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
};

const fileName = argValue('--file') ?? 'longmemeval_s_cleaned.json';
const entry = manifest.files[fileName];
if (!entry) {
  console.error(`Unknown file ${fileName}. Manifest files: ${Object.keys(manifest.files).join(', ')}`);
  process.exit(1);
}

const cacheDir = join(homedir(), '.cairn', 'benchmarks', 'longmemeval');
await mkdir(cacheDir, { recursive: true });
const destPath = join(cacheDir, fileName);

async function sha256Of(path) {
  const hash = createHash('sha256');
  const { createReadStream } = await import('node:fs');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

// Already present and verified → done.
try {
  await stat(destPath);
  const existing = await sha256Of(destPath);
  if (existing === entry.sha256) {
    console.log(`Already cached and verified: ${destPath}`);
    process.exit(0);
  }
  console.log('Cached file fails checksum — re-downloading.');
} catch { /* not cached yet */ }

const url = `https://huggingface.co/datasets/${manifest.dataset}/resolve/${manifest.revision}/${fileName}`;
console.log(`Fetching ${url}`);
console.log(`Expecting sha256 ${entry.sha256} (${entry.bytes} bytes)`);

const res = await fetch(url);
if (!res.ok || !res.body) {
  console.error(`Download failed: HTTP ${res.status}`);
  process.exit(1);
}

const tmpPath = `${destPath}.part`;
await pipeline(Readable.fromWeb(res.body), createWriteStream(tmpPath));

const actual = await sha256Of(tmpPath);
if (actual !== entry.sha256) {
  console.error(`CHECKSUM MISMATCH for ${fileName}:`);
  console.error(`  expected ${entry.sha256}`);
  console.error(`  actual   ${actual}`);
  console.error('File left at .part path for inspection; NOT installed.');
  process.exit(1);
}

await rename(tmpPath, destPath);
console.log(`Verified and installed: ${destPath}`);
