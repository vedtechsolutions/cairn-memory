/**
 * Live-store fork-hazard guards (Phase B — codex B1 review, findings 1 & 6).
 *
 * Every script that touches a user's real memory store MUST resolve its path
 * through resolveStateRoot() and REFUSE to create/target a store that does not
 * exist — otherwise a hardcoded/current path lets `openDatabase` mint an empty
 * store that then shadows the populated one, presenting as total memory loss.
 * These gates run the REAL scripts under a controlled, storeless HOME and prove
 * they exit non-zero without minting anything.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let home: string;
const SCRIPTS = join(process.cwd(), 'scripts');

beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'fork-guard-home-')); });
afterEach(() => rmSync(home, { recursive: true, force: true }));

/** Run a script under the storeless HOME; return {code, stderr}. A zero exit
 *  is returned as code 0 (the assertions below demand non-zero). */
function run(script: string, args: string[]): { code: number; stderr: string } {
  try {
    execFileSync('node', [join(SCRIPTS, script), ...args], {
      env: { PATH: process.env.PATH ?? '', HOME: home }, encoding: 'utf8', stdio: 'pipe',
    });
    return { code: 0, stderr: '' };
  } catch (err) {
    const e = err as { status?: number; stderr?: string };
    return { code: e.status ?? -1, stderr: e.stderr ?? '' };
  }
}

/** No store directory may be minted under the controlled HOME. */
function noStoreMinted(): void {
  for (const dir of ['.waykeep', '.cairn']) {
    const p = join(home, dir);
    if (existsSync(p)) {
      assert.fail(`a store dir was minted at ${dir}: ${readdirSync(p).join(', ')}`);
    }
  }
}

describe('live-store scripts refuse to mint a shadow store (codex B1)', () => {
  it('snr-probe.mjs exits non-zero and creates nothing when no store exists', () => {
    const { code, stderr } = run('snr-probe.mjs', ['--startup']);
    assert.notEqual(code, 0, `snr-probe must refuse, stderr: ${stderr}`);
    assert.match(stderr, /no store at/, 'must name the missing store, not crash opaquely');
    noStoreMinted();
  });

  it('recall-replay.mjs exits non-zero and creates nothing when no store exists', () => {
    const { code, stderr } = run('recall-replay.mjs', ['--query', 'anything']);
    assert.notEqual(code, 0, `recall-replay must refuse, stderr: ${stderr}`);
    assert.match(stderr, /no store at/, 'must name the missing store');
    noStoreMinted();
  });

  it('remediate-truncated.mjs --live refuses a non-existent target and creates nothing', () => {
    const manifest = join(home, 'manifest.json');
    writeFileSync(manifest, JSON.stringify({ rows: [] }));
    const { code, stderr } = run('remediate-truncated.mjs', ['--apply', manifest, '--live']);
    assert.notEqual(code, 0, `remediate --live must refuse a missing store, stderr: ${stderr}`);
    assert.match(stderr, /REFUSED|does not exist/, 'must refuse rather than mint a store');
    noStoreMinted();
  });
});
