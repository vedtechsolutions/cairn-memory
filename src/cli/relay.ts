/**
 * Hook-relay resolution shared by `waykeep init` and `waykeep doctor`.
 *
 * The compiled C relay is a performance optimization. The shell relay
 * (`hook-relay.sh`, bash + curl) is a complete drop-in — same socket protocol,
 * every subcommand — so an install with no compiled binary (a package
 * installed on a platform its prebuilt binary can't run, or a from-source
 * install that never compiled) still works. Prefer the binary when it is
 * present and executable, otherwise fall back to the shell relay.
 */
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { RELAY_PROBE_FLAG, RELAY_PROBE_SENTINEL } from 'waykeep-contract';

/** Bounds the execability probe below; the relay answers the probe flag
 *  immediately (before reading stdin or touching the socket), so this is only
 *  a scheduling safety net. */
const PROBE_TIMEOUT_MS = 2000;
const PROBE_ARG: string = RELAY_PROBE_FLAG;
/** Sentinel the real relay writes to stdout for the probe flag. */
const PROBE_SENTINEL: string = RELAY_PROBE_SENTINEL;

export interface RelayInvocation {
  kind: 'binary' | 'shell';
  /** Hook-command prefix: a subcommand is appended, e.g. `${command} stop`. */
  command: string;
}

export function relayBinaryPath(hookDir: string): string {
  return join(hookDir, 'hook-relay');
}

export function relayShellPath(hookDir: string): string {
  return join(hookDir, 'hook-relay.sh');
}

/** True when the compiled binary exists and actually runs on this host.
 *  An exec-bit check (X_OK) is insufficient: it passes for a wrong-architecture
 *  or wrong-OS ELF (a Linux binary shipped in the package, run on macOS/arm64/
 *  Windows) and, for root, even for a non-executable file — which would wire a
 *  binary that ENOEXECs into the hook config instead of falling back. So we
 *  actually execute it with no args; the relay exits immediately before reading
 *  stdin, and a spawn error (ENOEXEC/EACCES/…) means it isn't runnable here. */
export function binaryUsable(hookDir: string): boolean {
  const bin = relayBinaryPath(hookDir);
  if (!existsSync(bin)) return false;
  // A wrong-arch/OS file that is +x makes execvp fall back to /bin/sh (exit
  // 127, no spawn error), so the exit code alone can't tell us the relay ran.
  // Require the relay's own sentinel: only the real, runnable binary emits it.
  // The sentinel + clean exit is DEFINITIVE — do not also require
  // probe.error === undefined: some sandboxes (observed live: Codex's)
  // report a spawn-layer EPERM even though the child ran and exited 0,
  // and rejecting there would flip a working install to the shell relay,
  // changing every hook command string and invalidating Codex hook trust.
  const probe = spawnSync(bin, [PROBE_ARG], { timeout: PROBE_TIMEOUT_MS, encoding: 'utf8' });
  return probe.status === 0 && (probe.stdout ?? '').includes(PROBE_SENTINEL);
}

/** The relay invocation to use for hook commands on this install. */
export function resolveRelay(hookDir: string): RelayInvocation {
  return binaryUsable(hookDir)
    ? { kind: 'binary', command: relayBinaryPath(hookDir) }
    : { kind: 'shell', command: `bash ${relayShellPath(hookDir)}` };
}
