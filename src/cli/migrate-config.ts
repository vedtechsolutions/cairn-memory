/**
 * Config-file migration policy for `waykeep migrate` (Phase B2). The database and
 * the privacy config move as ONE coherent unit; this module decides and applies
 * how the target `config.json` is reconciled with the legacy one, so the user's
 * privacy settings are never silently dropped for a fork's. See src/cli/migrate.ts.
 */
import { renameSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { FILES } from '../constants/paths.js';
import { FS_PERMS } from '../constants/index.js';
import { isFile, lexists, isRegularFile, sameBytes, freeBackupPath, publishFileNoReplace } from './migrate-fs.js';

export type ConfigPlan =
  | { kind: 'copy' } // legacy config exists, target has none → copy it
  | { kind: 'replace' } // target config diverges from legacy → move aside, copy legacy
  | { kind: 'identical' } // target already equals legacy → leave it
  | { kind: 'discard-fork' } // no legacy config; a stray target config → move aside (faithful defaults)
  | { kind: 'none' }; // neither exists

/** Decide how the config migrates so the target faithfully mirrors legacy — the
 *  legacy privacy config is NEVER silently dropped for a fork's. A SYMLINK at the
 *  target is never authoritative (even byte-identical: it points OUT of the store,
 *  so a later legacy-tree removal breaks it or its target could change privacy) —
 *  moved aside, real file written. Hence lstat (`lexists`/`isRegularFile`), not isFile. */
export function planConfig(legacyConfig: string, currentConfig: string): ConfigPlan {
  const haveLegacy = isFile(legacyConfig);
  const targetPresent = lexists(currentConfig); // any entry, symlink included
  const targetIsRegular = isRegularFile(currentConfig); // a real file, not a symlink
  if (!haveLegacy) return targetPresent ? { kind: 'discard-fork' } : { kind: 'none' };
  if (!targetPresent) return { kind: 'copy' };
  // Legacy config exists AND something is at the target path:
  if (targetIsRegular && sameBytes(legacyConfig, currentConfig)) return { kind: 'identical' };
  return { kind: 'replace' }; // divergent regular file, a symlink, or any other entry
}

export function describeConfig(plan: ConfigPlan, legacyConfig: string, currentConfig: string): string | null {
  switch (plan.kind) {
    case 'copy': return `  config:    ${legacyConfig} → ${currentConfig}`;
    case 'replace': return `  config:    ${legacyConfig} → ${currentConfig} (a DIVERGENT target config is moved aside, not dropped)`;
    case 'identical': return `  config:    ${currentConfig} already matches the legacy config — left as-is`;
    case 'discard-fork': return `  config:    no legacy config; a stray ${currentConfig} is moved aside so defaults match ${dirname(legacyConfig)}`;
    case 'none': return null;
  }
}

/** Apply the config plan. A divergent/stray target config is moved aside to a
 *  collision-free backup; the legacy config is published with NO-REPLACE (link)
 *  semantics, so even a file a hand-editing user races in is preserved, never
 *  clobbered. */
export function applyConfig(plan: ConfigPlan, legacyConfig: string, currentConfig: string, currentDir: string, stamp: string): void {
  const preserveAside = (raced: string): void => { renameSync(raced, freeBackupPath(raced, stamp, [''])); };
  // A divergent or stray target config is preserved (never dropped) before the
  // legacy config — the coherent unit — is written.
  if (plan.kind === 'replace' || plan.kind === 'discard-fork') {
    preserveAside(currentConfig);
  }
  if (plan.kind === 'copy' || plan.kind === 'replace') {
    publishFileNoReplace(currentDir, FILES.CONFIG, readFileSync(legacyConfig), FS_PERMS.FILE, preserveAside);
  }
  // 'identical' | 'none' → nothing to do.
}
