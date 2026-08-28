/**
 * `cairn import` — one-way migration from other memory systems into
 * Cairn, riding the shared learn pipeline (dedup, neutralization, secret
 * scrub via the repository gateway). CLI rather than MCP tool so it works
 * before any agent session and can print a dry-run preview.
 *
 * Sources:
 *   codex-memories  ~/.codex/memories (structured MEMORY.md handbook)
 *   memory-md       a freeform MEMORY.md (+ sibling topic files)
 *   claude-mem      the community claude-mem archive (format-versioned)
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../db/connection.js';
import { resolveDbPath } from '../db/db-path.js';
import { MemoryRepository } from '../db/memory-repository.js';
import { learnSections, type LearnSection } from '../importers/learn-pipeline.js';
import { transformCodexMemories } from '../importers/codex-memories.js';
import { transformMemoryMd } from '../importers/memory-md.js';
import { transformClaudeMem } from '../importers/claude-mem.js';

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
        const dir = options.path ?? join(process.env.CAIRN_CODEX_DIR ?? join(homedir(), '.codex'), 'memories');
        const result = transformCodexMemories(dir, { includeNotes: options.includeNotes });
        ({ sections, excluded, notes } = result);
        break;
      }
      case 'memory-md': {
        if (!options.path) {
          console.error('cairn import --from memory-md requires --path <MEMORY.md>');
          return 1;
        }
        ({ sections, notes } = transformMemoryMd(options.path));
        break;
      }
      case 'claude-mem': {
        const result = transformClaudeMem(options.path);
        ({ sections, notes } = result);
        excluded = result.excluded ?? [];
        break;
      }
      default:
        console.error(`cairn import: unknown source "${options.from}" (expected codex-memories | memory-md | claude-mem)`);
        return 1;
    }
  } catch (err) {
    console.error(`cairn import: ${(err as Error).message}`);
    return 1;
  }

  console.log(`cairn import — ${options.from}`);
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
      console.log(`    [${s.kind}] (${scope}) ${s.content.slice(0, 90)}${s.content.length > 90 ? '…' : ''}`);
    }
    return 0;
  }

  const db = openDatabase({ dbPath: resolveDbPath(process.env.CAIRN_DB_PATH) });
  try {
    const repo = new MemoryRepository(db);
    const result = learnSections(repo, sections, options.project ?? null);
    console.log(`  imported: ${result.ingested}, deduplicated: ${result.deduplicated}${result.errors.length > 0 ? `, errors: ${result.errors.length}` : ''}`);
    for (const e of result.errors) console.log(`    ⚠ ${e}`);
    console.log('  Re-running is safe: identical content deduplicates.');
    return result.errors.length > 0 ? 1 : 0;
  } finally {
    db.close();
  }
}
