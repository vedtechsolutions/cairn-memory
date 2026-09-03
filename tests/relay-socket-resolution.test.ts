/**
 * Relay socket resolution is migration-marker-aware (Phase B, codex
 * re-review block 1).
 *
 * The compiled/shell relay must reach the socket of the daemon that owns
 * the AUTHORITATIVE store — resolved the same way as resolveStateRoot():
 * WAYKEEP_DIR override; else current when the migration marker exists; else
 * an existing legacy store; else current. Getting this wrong routes hooks
 * (and governance, which has no direct-node fallback) to the wrong store or
 * silently disarms them. These gates run the REAL compiled relay against a
 * mock daemon placed at each candidate location.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { existsSync } from 'node:fs';
import { DATA_DIR_NAME } from 'waykeep-contract';
import { afterBody, prepareRelayDir, runRelay, TEST_GENEROUS_TIMEOUT_MS } from './relay-harness.js';
import { ENV } from '../src/constants/env.js';

const LEGACY_DIR = '.cairn';
const SOCKET_FILE = 'hook-daemon.sock';
const GENEROUS = { [ENV.DAEMON_TIMEOUT_MS]: TEST_GENEROUS_TIMEOUT_MS };

let binDir: string;
let skip: string | null = null;
const homes: string[] = [];
const servers: Server[] = [];

/** Start a mock daemon that returns a LABELED response so a test can prove
 *  WHICH candidate socket the relay actually reached. */
async function daemonAt(dir: string, label: string): Promise<void> {
  mkdirSync(dir, { recursive: true });
  const server = createServer((req, res) => afterBody(req, () => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ reached: label }));
  }));
  servers.push(server);
  await new Promise<void>((ok, bad) => {
    server.once('error', bad);
    server.listen(join(dir, SOCKET_FILE), () => ok());
  });
}
const reached = (stdout: string): string | undefined => {
  try { return (JSON.parse(stdout) as { reached?: string }).reached; } catch { return undefined; }
};

before(async () => {
  binDir = prepareRelayDir('relay-socket-res');
  try {
    const probeHome = mkdtempSync(join(tmpdir(), 'relay-res-probe-'));
    homes.push(probeHome);
    await daemonAt(join(probeHome, DATA_DIR_NAME), 'probe');
  } catch (err) {
    skip = `unix-socket listen not permitted: ${(err as Error).message}`;
  }
});

after(async () => {
  await Promise.all(servers.map(s => new Promise<void>(r => s.close(() => r()))));
  for (const h of homes) rmSync(h, { recursive: true, force: true });
});

function freshHome(): string {
  const h = mkdtempSync(join(tmpdir(), 'relay-res-home-'));
  homes.push(h);
  return h;
}

describe('relay socket resolution (marker-aware, compiled C relay)', () => {
  it('un-migrated: reaches the LEGACY daemon when ~/.cairn/cairn.db exists and no marker', async (t) => {
    if (skip) return t.skip(skip);
    const home = freshHome();
    writeFileSync(join(mkdirIn(home, LEGACY_DIR), 'cairn.db'), '');
    await daemonAt(join(home, LEGACY_DIR), 'legacy');
    const res = await runRelay(join(binDir, 'hook-relay'), 'ok-hook', '{}', home, GENEROUS);
    assert.equal(res.status, 0);
    assert.equal(reached(res.stdout), 'legacy', `wrong daemon, got: ${res.stdout || '(empty)'}`);
  });

  it('migrated: reaches the CURRENT daemon, IGNORING a live legacy socket', async (t) => {
    if (skip) return t.skip(skip);
    const home = freshHome();
    writeFileSync(join(mkdirIn(home, LEGACY_DIR), 'cairn.db'), '');
    await daemonAt(join(home, LEGACY_DIR), 'legacy'); // live legacy daemon present
    writeFileSync(join(mkdirIn(home, DATA_DIR_NAME), 'waykeep-migrated.json'), '{}');
    await daemonAt(join(home, DATA_DIR_NAME), 'current');
    const res = await runRelay(join(binDir, 'hook-relay'), 'ok-hook', '{}', home, GENEROUS);
    assert.equal(res.status, 0);
    assert.equal(reached(res.stdout), 'current', `must reach CURRENT after migration, got: ${res.stdout || '(empty)'}`);
  });

  it('a DIRECTORY-shaped marker does not count as migrated — reaches the legacy daemon', async (t) => {
    if (skip) return t.skip(skip);
    const home = freshHome();
    writeFileSync(join(mkdirIn(home, LEGACY_DIR), 'cairn.db'), '');
    await daemonAt(join(home, LEGACY_DIR), 'legacy');
    mkdirIn(join(home, DATA_DIR_NAME), 'waykeep-migrated.json'); // a DIR, not a file
    const res = await runRelay(join(binDir, 'hook-relay'), 'ok-hook', '{}', home, GENEROUS);
    assert.equal(res.status, 0);
    assert.equal(reached(res.stdout), 'legacy', 'a dir-shaped marker must not select current');
  });

  it('WAYKEEP_DIR override wins; and a legacy-only CAIRN_DIR override is honored', async (t) => {
    if (skip) return t.skip(skip);
    const home = freshHome();
    const overrideW = freshHome();
    await daemonAt(overrideW, 'override-current');
    const rw = await runRelay(join(binDir, 'hook-relay'), 'ok-hook', '{}', home, { ...GENEROUS, [ENV.DIR]: overrideW });
    assert.equal(reached(rw.stdout), 'override-current', `WAYKEEP_DIR must win, got: ${rw.stdout || '(empty)'}`);

    const home2 = freshHome();
    const overrideC = freshHome();
    await daemonAt(overrideC, 'override-legacy');
    const rc = await runRelay(join(binDir, 'hook-relay'), 'ok-hook', '{}', home2, { ...GENEROUS, CAIRN_DIR: overrideC });
    assert.equal(reached(rc.stdout), 'override-legacy',
      `a legacy-only CAIRN_DIR export must be followed (matches the TS bootstrap), got: ${rc.stdout || '(empty)'}`);
  });

  it('a DIR override is honored even with an UNRESOLVABLE HOME — override read before HOME (codex B1)', async (t) => {
    if (skip) return t.skip(skip);
    // Container/unmapped-uid shape: HOME empty (non-absolute) but WAYKEEP_DIR set.
    // The relay must read the override FIRST, not fail-closed on the missing HOME
    // — else all hooks silently stop despite a valid override.
    const overrideC = freshHome();
    await daemonAt(overrideC, 'override-no-home');
    const rc = await runRelay(join(binDir, 'hook-relay'), 'ok-hook', '{}', '', { ...GENEROUS, [ENV.DIR]: overrideC });
    assert.equal(reached(rc.stdout), 'override-no-home',
      `C relay: DIR override must win over the HOME requirement, got: ${rc.stdout || '(empty)'}`);

    const shell = join(binDir, 'hook-relay.sh');
    if (existsSync(shell)) {
      const overrideS = freshHome();
      await daemonAt(overrideS, 'override-no-home-sh');
      const rs = await runRelay(shell, 'prompt-check', '{}', '', { ...GENEROUS, [ENV.DIR]: overrideS });
      assert.equal(reached(rs.stdout), 'override-no-home-sh',
        `shell relay: DIR override must be read before requiring HOME, got: ${rs.stdout || '(empty)'}`);
    }
  });

  it('the SHELL relay resolves the same authoritative daemon', async (t) => {
    if (skip) return t.skip(skip);
    const shell = join(binDir, 'hook-relay.sh');
    if (!existsSync(shell)) return t.skip('shell relay not present in bin dir');
    const home = freshHome();
    writeFileSync(join(mkdirIn(home, LEGACY_DIR), 'cairn.db'), '');
    await daemonAt(join(home, LEGACY_DIR), 'legacy');
    // A SYNC hook (prompt-check): the shell relay waits for and PRINTS the
    // response only for sync hooks — async ones are fire-and-forget.
    const res = await runRelay(shell, 'prompt-check', '{}', home, GENEROUS);
    assert.equal(reached(res.stdout), 'legacy', `shell relay wrong daemon, got: ${res.stdout || '(empty)'}`);
  });

  it('the STATUSLINE relay resolves the same authoritative daemon (codex B1)', async (t) => {
    if (skip) return t.skip(skip);
    const statusline = join(binDir, 'statusline-relay.sh');
    if (!existsSync(statusline)) return t.skip('statusline relay not present in bin dir');
    const home = freshHome();
    writeFileSync(join(mkdirIn(home, LEGACY_DIR), 'cairn.db'), '');
    await daemonAt(join(home, LEGACY_DIR), 'legacy');
    // Un-migrated: a hardcoded current socket would miss the legacy daemon and
    // print the "ready" fallback (reached === undefined). Marker-aware, it must
    // reach the legacy daemon and echo its labeled body.
    const res = await runRelay(statusline, 'statusline', '{}', home, GENEROUS);
    assert.equal(reached(res.stdout), 'legacy',
      `statusline relay must reach the legacy daemon un-migrated, got: ${res.stdout || '(empty)'}`);
  });

  it('the fallback diagnostic log lands in the RESOLVED legacy dir, not the current one (codex B1)', async (t) => {
    if (skip) return t.skip(skip);
    const home = freshHome();
    writeFileSync(join(mkdirIn(home, LEGACY_DIR), 'cairn.db'), '');
    // No daemon socket anywhere → the relay takes the fallback path and logs.
    // The log used to hardcode ~/.waykeep; on this un-migrated store it must
    // instead share the resolved legacy root (or state splits across namespaces).
    await runRelay(join(binDir, 'hook-relay'), 'prompt-check', '{}', home, GENEROUS);
    const legacyLog = join(home, LEGACY_DIR, 'hook-relay-fallback.log');
    const currentLog = join(home, DATA_DIR_NAME, 'hook-relay-fallback.log');
    assert.ok(existsSync(legacyLog), 'fallback log must be under the resolved legacy dir');
    assert.ok(!existsSync(currentLog), 'must NOT split diagnostics into the current dir');
  });
});

function mkdirIn(home: string, sub: string): string {
  const d = join(home, sub);
  mkdirSync(d, { recursive: true });
  return d;
}
