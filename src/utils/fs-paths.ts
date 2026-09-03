/**
 * Path helpers shared by the CLI diagnostics.
 */
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

/** realpath when the path exists, else its lexical resolution — so the same
 *  install reached through a symlink never reads as a different install, and
 *  a missing path still compares sensibly. */
export function canonicalPath(p: string): string {
  try { return realpathSync(p); } catch { return resolve(p); }
}
