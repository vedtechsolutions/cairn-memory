/**
 * `waykeep build-relay` — compile the C hook relay from the shipped source.
 *
 * The compiled relay is an optional fast path (it avoids per-hook process
 * startup). Where a C compiler is available, this builds it with the same
 * hardening flags as `npm run build:relay`; where it is not, hooks keep
 * working through the shell relay. Prints one line and returns an exit code.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, copyFileSync, chmodSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SRC = join(PKG_ROOT, 'src', 'hooks', 'hook-relay.c');
const SHELL_SRC = join(PKG_ROOT, 'src', 'hooks', 'hook-relay.sh');
const OUT = join(PKG_ROOT, 'dist', 'src', 'hooks', 'hook-relay');
const SHELL_OUT = join(PKG_ROOT, 'dist', 'src', 'hooks', 'hook-relay.sh');
const EXEC_MODE = 0o755;
const CC_FLAGS = [
  '-O2', '-D_FORTIFY_SOURCE=2', '-fstack-protector-strong', '-fPIE', '-pie',
  '-Wall', '-Wextra', '-Wformat', '-Werror=format-security',
];

export function runBuildRelay(): number {
  if (!existsSync(SRC)) {
    console.error(`waykeep build-relay: relay source missing at ${SRC}`);
    return 1;
  }
  mkdirSync(dirname(OUT), { recursive: true });
  const cc = process.env.CC ?? 'cc';
  const compile = (flags: readonly string[]): ReturnType<typeof spawnSync> =>
    spawnSync(cc, [...flags, '-o', OUT, SRC], { stdio: 'inherit' });

  let result = compile(CC_FLAGS);
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    const hint = code === 'ENOENT'
      ? `no C compiler found (tried "${cc}") — set CC or install one; hooks use the shell fallback meanwhile`
      : result.error.message;
    console.error(`waykeep build-relay: ${hint}`);
    return 1;
  }
  if (result.status !== 0) {
    // A stricter/older or non-gcc/clang compiler may reject a hardening flag;
    // retry with plain -O2 so a machine that HAS a compiler still gets the fast
    // path (the security flags are a hardening nicety, not a correctness need).
    console.error('waykeep build-relay: hardened compile failed; retrying with -O2 only');
    result = compile(['-O2']);
    if (result.error || result.status !== 0) {
      console.error(`waykeep build-relay: compilation failed (exit ${result.status ?? 'signal'})`);
      return 1;
    }
  }
  chmodSync(OUT, EXEC_MODE);
  // Keep the shell fallback beside it, matching the build script.
  if (existsSync(SHELL_SRC)) {
    copyFileSync(SHELL_SRC, SHELL_OUT);
    chmodSync(SHELL_OUT, EXEC_MODE);
  }
  console.log(`waykeep build-relay: compiled ${OUT}`);
  return 0;
}
