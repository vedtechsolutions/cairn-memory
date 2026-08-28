/**
 * Capability probe for tests that assert against a real `git` invocation.
 *
 * Some sandboxes deny Node's native spawn (execFileSync throws EPERM even
 * when shell git works). Production code fail-safes to null there by design,
 * so tests asserting real git output must skip rather than fail.
 */
import { execFileSync } from 'node:child_process';

const PROBE_TIMEOUT_MS = 5000;
const PROBE_EXIT_MARKER = 42;

let gitCached: string | null | undefined;

/** Null when Node can spawn git; otherwise a human-readable skip reason. */
export function gitSpawnSkipReason(): string | null {
  if (gitCached === undefined) {
    try {
      execFileSync('git', ['--version'], { stdio: 'pipe', timeout: PROBE_TIMEOUT_MS });
      gitCached = null;
    } catch (err) {
      gitCached = `git not spawnable from Node in this environment: ${(err as Error).message}`;
    }
  }
  return gitCached;
}

let grandchildCached: string | null | undefined;

/** Null when a non-Node parent process can fork+exec `node` (what the C
 *  relay's fallback does); otherwise a skip reason. Probed via sh so the
 *  intermediate parent is a plain binary, like the relay. */
export function nodeGrandchildSkipReason(): string | null {
  if (grandchildCached === undefined) {
    try {
      execFileSync('/bin/sh', ['-c', `node -e "process.exit(${PROBE_EXIT_MARKER})"`], {
        stdio: 'pipe',
        timeout: PROBE_TIMEOUT_MS,
      });
      grandchildCached = 'probe error: marker exit expected'; // exit 42 should throw
    } catch (err) {
      const status = (err as { status?: number }).status;
      grandchildCached = status === PROBE_EXIT_MARKER
        ? null
        : `node not runnable as a grandchild in this environment: ${(err as Error).message}`;
    }
  }
  return grandchildCached;
}
