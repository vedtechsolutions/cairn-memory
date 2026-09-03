/**
 * `waykeep import` — one-way migration from other memory systems into
 * Waykeep, riding the shared learn pipeline (dedup, neutralization, secret
 * scrub via the repository gateway). CLI rather than MCP tool so it works
 * before any agent session and can print a dry-run preview.
 *
 * Sources:
 *   codex-memories  ~/.codex/memories (structured MEMORY.md handbook)
 *   memory-md       a freeform MEMORY.md (+ sibling topic files)
 *   claude-mem      the community claude-mem archive (format-versioned)
 */
import { homedir } from 'node:os';
import { NAMESPACE } from 'waykeep-contract';
import { join } from 'node:path';
import { openDatabase } from '../db/connection.js';
import { resolveDbPath } from '../db/db-path.js';
import { MemoryRepository } from '../db/memory-repository.js';
import { learnSections, safeExcerpt, type LearnSection } from '../importers/learn-pipeline.js';
import { isPrivateProject } from '../config/waykeep-config.js';
import { transformCodexMemories } from '../importers/codex-memories.js';
import { transformMemoryMd } from '../importers/memory-md.js';
import { transformClaudeMem } from '../importers/claude-mem.js';
import { ENV } from '../constants/env.js';
import { CODEX } from '../constants/codex.js';

export interface ImportOptions {
  from: string;
  path?: string;
  project?: string | null;
  dryRun?: boolean;
  includeNotes?: boolean;
}

export function runImport(options: ImportOptions): number {
  let sections: LearnSection[];
  let excluded: Array<{ name: string; reason: string }> = [];
  let notes: string[];

  try {
    switch (options.from) {
      case 'codex-memories': {
        const dir = options.path ?? join(process.env[ENV.CODEX_DIR] ?? join(homedir(), CODEX.CONFIG_DIR), CODEX.MEMORIES_SUBDIR);
        const result = transformCodexMemories(dir, { includeNotes: options.includeNotes });
        ({ sections, excluded, notes } = result);
        break;
      }
      case 'memory-md': {
        if (!options.path) {
          console.error(`${NAMESPACE} import --from memory-md requires --path <MEMORY.md>`);
          return 1;
        }
        const result = transformMemoryMd(options.path, { includeSiblings: options.includeNotes });
        ({ sections, notes } = result);
        excluded = result.excluded ?? [];
        break;
      }
      case 'claude-mem': {
        const result = transformClaudeMem(options.path);
        ({ sections, notes } = result);
        excluded = result.excluded ?? [];
        break;
      }
      default:
        console.error(`waykeep import: unknown source "${options.from}" (expected codex-memories | memory-md | claude-mem)`);
        return 1;
    }
  } catch (err) {
    console.error(`waykeep import: ${(err as Error).message}`);
    return 1;
  }

  console.log(`waykeep import — ${options.from}`);
  for (const note of notes) console.log(`  ${note}`);
  for (const ex of excluded) console.log(`  excluded: ${ex.name} (${ex.reason})`);
  if (sections.length === 0) {
    console.log('  Nothing to import.');
    return 0;
  }

  if (options.dryRun) {
    console.log(`  DRY RUN — ${sections.length} memories would be imported:`);
    for (const s of sections) {
      const scope = s.project === undefined ? (options.project ?? 'global') : (s.project ?? 'global');
      const privateFlag = scope !== 'global' && isPrivateProject(scope) ? ' [PRIVATE]' : '';
      // Scrubbed excerpt: a source bullet can BEGIN with a credential,
      // and dry-run output must never print it verbatim (review).
      console.log(`    [${s.kind}] (${scope}${privateFlag}) ${safeExcerpt(s.content)}`);
    }
    return 0;
  }

  const db = openDatabase({ dbPath: resolveDbPath(process.env[ENV.DB_PATH]) });
  try {
    const repo = new MemoryRepository(db);
    const result = learnSections(repo, sections, options.project ?? null);
    console.log(`  imported: ${result.ingested}, identical (skipped): ${result.exactDuplicates}, merged into existing: ${result.merged.length}${result.errors.length > 0 ? `, errors: ${result.errors.length}` : ''}`);
    // MERGES are lossy — the source wording is absorbed into a similar
    // existing row. The importer is the one caller that knows the source
    // records were distinct, so it says exactly what happened to each.
    for (const m of result.merged) {
      console.log(`    ~ merged: "${m.source}"`);
      console.log(`      with existing: "${m.existing}" (the longer text is kept)`);
    }
    for (const e of result.errors) console.log(`    ⚠ ${e}`);

    // Scope disclosure: writes into scopes chosen by the SOURCE FILE
    // (applies_to) must be named, and private targets flagged — never an
    // undisclosed placement into the most-trusted scope (review).
    const byScope = new Map<string, number>();
    for (const s2 of sections) {
      const scope = s2.project === undefined ? (options.project ?? 'global') : (s2.project ?? 'global');
      byScope.set(scope, (byScope.get(scope) ?? 0) + 1);
    }
    console.log('  Scopes written:');
    for (const [scope, count] of byScope) {
      const privateFlag = scope !== 'global' && isPrivateProject(scope) ? '  [PRIVATE project]' : '';
      console.log(`    ${scope}: ${count}${privateFlag}`);
    }
    console.log('  Re-running is safe for identical content; near-duplicates merge (reported above).');
    return result.errors.length > 0 ? 1 : 0;
  } finally {
    db.close();
  }
}
