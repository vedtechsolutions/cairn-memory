/**
 * `waykeep pack export|import` — the free manual repo-pack (D12).
 * Explicit, local, and git-free: exports shareable-kind observations to
 * a user-chosen directory as deterministic one-record-per-file
 * documents; imports them as untrusted learn observations. NEVER
 * invokes git — committing (or gitignoring) the directory is the
 * user's own arrangement, and the export prints a reminder.
 */
import { resolve } from 'node:path';

import { openDatabase } from '../db/connection.js';
import { resolveDbPath } from '../db/db-path.js';
import { packExport, packImport } from '../pack/pack.js';

export interface PackCliOptions {
  command: string;
  dir?: string;
  project?: string;
  global?: boolean;
}

export function runPack(opts: PackCliOptions): number {
  if (opts.command !== 'export' && opts.command !== 'import') {
    console.error('usage: waykeep pack export|import --dir <path> [--project ID | --global]');
    return 1;
  }
  if (!opts.dir) {
    console.error('waykeep pack: --dir is required (choose a normally-gitignored location)');
    return 1;
  }
  const dir = resolve(opts.dir);
  const db = openDatabase({ dbPath: resolveDbPath(process.env.CAIRN_DB_PATH) });
  try {
    if (opts.command === 'export') {
      // Bulk export covers every non-private project; a single project
      // (private included) must be named explicitly; --global exports
      // the global scope.
      const scope = opts.global ? null : (opts.project ?? 'all-shared');
      const r = packExport(db, dir, scope);
      console.log(`pack export: ${r.written} written, ${r.unchanged} unchanged, ${r.pruned} pruned → ${dir}`);
      for (const red of r.redactions) {
        console.error(`⚠ REDACTED ON EXPORT (a secret was resting in the DB): ${red.file} — "${red.excerpt}…"`);
      }
      console.log('reminder: waykeep never runs git — keep this directory gitignored unless you mean to share it.');
      return 0;
    }
    if (!opts.project && !opts.global) {
      console.error('waykeep pack import: name the target scope (--project ID or --global) — imports never guess.');
      return 1;
    }
    const r = packImport(db, dir, opts.global ? null : opts.project!);
    console.log(`pack import: ${r.ingested} ingested, ${r.exactDuplicates} exact no-ops, ${r.merged} merged`);
    for (const e of r.errors) console.error(`⚠ skipped: ${e}`);
    return r.errors.length > 0 ? 1 : 0;
  } finally {
    db.close();
  }
}
