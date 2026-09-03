/**
 * Shared harness for hook-relay binary tests.
 *
 * Drives the relay via async spawn + explicit stdin write/end. This matches
 * production (hook-relay.sh feeds stdin through a real shell pipe) and works
 * in sandboxes where spawnSync(..., { input }) never delivers stdin EOF to
 * the child — there the relay's read-to-EOF loop blocks and the sync call
 * times out even though the binary itself is fine.
 */
import { spawn, spawnSync } from 'node:child_process';
import type { IncomingMessage } from 'node:http';
import { existsSync, mkdtempSync, cpSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GENEROUS_RELAY_TIMEOUT_MS } from './helpers/test-budgets.js';

export const RELAY_SOURCE = join(process.cwd(), 'src/hooks/hook-relay.c');
/** hook-relay.c #includes the generated identity.h — a fresh compile needs it. */
export const GENERATED_INCLUDE = join(process.cwd(), 'dist/generated');
export const RELAY_BINARY = join(process.cwd(), 'dist/src/hooks/hook-relay');

/** Hard cap on every spawned process — restricted sandboxes must fail fast
 *  with a clear error, never hang the suite. Generous vs the relay's own 3s
 *  daemon-response timeout. */
export const SPAWN_TIMEOUT_MS = 10_000;

/** Generous governance/daemon timeout (ms, as an env string) for round-trip
 *  correctness tests. They exercise response handling, not the production SLA,
 *  so they must not race a wall-clock deadline against a CPU-starved mock
 *  socket under full-suite load. Timing-specific tests keep the tight default. */
export const TEST_GENEROUS_TIMEOUT_MS = String(GENEROUS_RELAY_TIMEOUT_MS);

/** Copy the compiled relay (or compile a fresh one) into a new temp dir so
 *  the binary's sibling `<hook-type>.js` lookup resolves to test-controlled
 *  stubs. Returns the temp dir; callers own its cleanup. */
export function prepareRelayDir(prefix: string): string {
  let relayBin: string;
  if (existsSync(RELAY_BINARY)) {
    relayBin = RELAY_BINARY;
  } else {
    const out = join(tmpdir(), `${prefix}-bin-${process.pid}`);
    const compile = spawnSync('cc', ['-O2', '-I', GENERATED_INCLUDE, '-o', out, RELAY_SOURCE], { stdio: 'pipe', timeout: SPAWN_TIMEOUT_MS });
    if (compile.status !== 0) {
      throw new Error(`failed to compile hook-relay.c: ${compile.stderr?.toString()}`);
    }
    relayBin = out;
  }
  const dir = mkdtempSync(join(tmpdir(), `${prefix}-`));
  cpSync(relayBin, join(dir, 'hook-relay'));
  chmodSync(join(dir, 'hook-relay'), 0o755);
  // The shell relay + its identity.sh, so tests can exercise the shell
  // artifact too (it sources identity.sh from its own dir).
  const shellSrc = join(process.cwd(), 'dist', 'src', 'hooks', 'hook-relay.sh');
  const identSrc = join(process.cwd(), 'dist', 'src', 'hooks', 'identity.sh');
  if (existsSync(shellSrc) && existsSync(identSrc)) {
    cpSync(shellSrc, join(dir, 'hook-relay.sh'));
    chmodSync(join(dir, 'hook-relay.sh'), 0o755);
    cpSync(identSrc, join(dir, 'identity.sh'));
    // The statusline relay too — it resolves the socket the same marker-aware
    // way and must be exercised against the same daemon placements.
    const statusSrc = join(process.cwd(), 'dist', 'src', 'hooks', 'statusline-relay.sh');
    if (existsSync(statusSrc)) {
      cpSync(statusSrc, join(dir, 'statusline-relay.sh'));
      chmodSync(join(dir, 'statusline-relay.sh'), 0o755);
    }
  }
  return dir;
}

export interface RelayResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/** Run the relay once, feeding `input` on stdin and collecting stdout,
 *  stderr, and the exit signal (all needed to diagnose sandbox failures).
 *  SIGKILLs the relay and rejects if it outlives SPAWN_TIMEOUT_MS. */
export function runRelay(
  bin: string,
  hookType: string,
  input: Buffer | string,
  home: string,
  env?: NodeJS.ProcessEnv,
): Promise<RelayResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    // The relay resolves its socket dir marker-aware from HOME (or an
    // explicit DIR override). The hermetic preload sets WAYKEEP_DIR to its
    // own temp dir on THIS process — leaking that into the spawned relay
    // would point it away from the socket the test placed under HOME. Strip
    // the state-dir overrides (current + legacy) unless a test sets one.
    const childEnv: NodeJS.ProcessEnv = { ...process.env, HOME: home, ...env };
    if (!env || !('WAYKEEP_DIR' in env)) delete childEnv.WAYKEEP_DIR;
    if (!env || !('CAIRN_DIR' in env)) delete childEnv.CAIRN_DIR;
    const child = spawn(bin, [hookType], { env: childEnv });
    const killTimer = setTimeout(() => {
      child.kill('SIGKILL');
      rejectPromise(new Error(`relay did not exit within ${SPAWN_TIMEOUT_MS}ms`));
    }, SPAWN_TIMEOUT_MS);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString('utf8'); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8'); });
    child.on('error', (err) => { clearTimeout(killTimer); rejectPromise(err); });
    child.on('close', (status, signal) => { clearTimeout(killTimer); resolvePromise({ status, signal, stdout, stderr }); });
    child.stdin.write(input);
    child.stdin.end();
  });
}

/** Answer a mock-daemon request only after its body is consumed, as the real
 *  daemon does. The relay sends headers and body in two writes; a mock that
 *  answers on the request event closes the HTTP/1.0 connection under the
 *  second write, and the relay reads that EPIPE as "daemon dropped the
 *  connection" — a silent direct-node fallback with empty stdout. That was
 *  the recorded full-suite flake in the status, socket-resolution and
 *  governance-gate relay tests. */
export function afterBody(req: IncomingMessage, respond: () => void): void {
  req.resume();
  req.on('end', respond);
}
