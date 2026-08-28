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
import { existsSync, mkdtempSync, cpSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export const RELAY_SOURCE = join(process.cwd(), 'src/hooks/hook-relay.c');
export const RELAY_BINARY = join(process.cwd(), 'dist/src/hooks/hook-relay');

/** Hard cap on every spawned process — restricted sandboxes must fail fast
 *  with a clear error, never hang the suite. Generous vs the relay's own 3s
 *  daemon-response timeout. */
export const SPAWN_TIMEOUT_MS = 10_000;

/** Generous governance/daemon timeout (ms, as an env string) for round-trip
 *  correctness tests. They exercise response handling, not the production SLA,
 *  so they must not race a wall-clock deadline against a CPU-starved mock
 *  socket under full-suite load. Timing-specific tests keep the tight default. */
export const TEST_GENEROUS_TIMEOUT_MS = '30000';

/** Copy the compiled relay (or compile a fresh one) into a new temp dir so
 *  the binary's sibling `<hook-type>.js` lookup resolves to test-controlled
 *  stubs. Returns the temp dir; callers own its cleanup. */
export function prepareRelayDir(prefix: string): string {
  let relayBin: string;
  if (existsSync(RELAY_BINARY)) {
    relayBin = RELAY_BINARY;
  } else {
    const out = join(tmpdir(), `${prefix}-bin-${process.pid}`);
    const compile = spawnSync('cc', ['-O2', '-o', out, RELAY_SOURCE], { stdio: 'pipe', timeout: SPAWN_TIMEOUT_MS });
    if (compile.status !== 0) {
      throw new Error(`failed to compile hook-relay.c: ${compile.stderr?.toString()}`);
    }
    relayBin = out;
  }
  const dir = mkdtempSync(join(tmpdir(), `${prefix}-`));
  cpSync(relayBin, join(dir, 'hook-relay'));
  chmodSync(join(dir, 'hook-relay'), 0o755);
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
    const child = spawn(bin, [hookType], { env: { ...process.env, HOME: home, ...env } });
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
