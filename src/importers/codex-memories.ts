/**
 * Importer: Codex CLI native memories (~/.codex/memories/).
 *
 * MEMORY.md is a STRUCTURED curated handbook with a STRICT format
 * (spec extracted verbatim from the codex 0.150.x binary's consolidation
 * prompt; note the `v1` marker belongs to memory_summary.md, NOT this
 * file): `# Task Group:` blocks each carrying
 * `scope:` and `applies_to:` header lines, `## Task <n>` sections
 * (provenance: `### rollout_summary_files`, `### keywords`), and
 * consolidated block-level sections `## User preferences`,
 * `## Reusable knowledge`, `## Failures and how to do differently`.
 *
 * Mapping (each consolidated BULLET is already a distilled lesson —
 * exactly Cairn's memory grain):
 *   - Failures and how to do differently → pitfall
 *   - User preferences                   → fact, tagged `preference`
 *   - Reusable knowledge                 → fact
 *   - kind upgrade: a Reusable-knowledge bullet phrased as a choice
 *     ("chose/decided/prefer X over Y") → decision
 * Task sections are provenance, not lessons — they become context, never
 * rows. `applies_to: cwd=<path>` maps to Cairn's project scope via
 * projectId(path) (deterministic; a missing dir hashes the path). Task
 * Group name + scope travel in context.why; task-local keywords become
 * tags (capped).
 *
 * EXCLUDED by design [X5]: memory_summary.md (duplicate summary),
 * raw_memories.md (temp input), rollout_summaries/ (evidence, referenced
 * not imported), skills/ + extensions/ (executable guidance), *.sqlite
 * (undocumented internals). Ad-hoc topic files import only with
 * includeNotes (freeform, via the memory-md transformer's section rules).
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { projectId } from '../utils/project-id.js';
import { IMPORT } from '../constants/index.js';
import type { LearnSection } from './learn-pipeline.js';
import { sectionsFromFreeformMarkdown } from './memory-md.js';
import { inferKind } from './shared.js';

export interface CodexMemoriesImport {
  sections: LearnSection[];
  /** Files deliberately not imported, with reasons — reported, never silent. */
  excluded: Array<{ name: string; reason: string }>;
  notes: string[];
}

const EXCLUDED_NAMES: ReadonlyArray<{ match: (n: string) => boolean; reason: string }> = [
  { match: (n) => n === 'memory_summary.md', reason: 'duplicate summary of MEMORY.md' },
  { match: (n) => n === 'raw_memories.md', reason: 'temporary consolidation input' },
  { match: (n) => n === 'rollout_summaries', reason: 'per-session evidence (referenced, not imported)' },
  { match: (n) => n === 'skills', reason: 'executable guidance (import would run-by-reference)' },
  { match: (n) => n === 'extensions', reason: 'executable guidance' },
  { match: (n) => n.endsWith('.sqlite'), reason: 'undocumented internal database' },
];

interface TaskGroup {
  name: string;
  scope: string;
  appliesTo: string;
  cwd: string | null;
  /** Task-LOCAL keywords by task number — a [Task 3] lesson must carry
   *  Task 3's retrieval handles, not a flattened group union (review). */
  taskKeywords: Map<number, string[]>;
  preferences: string[];
  knowledge: string[];
  failures: string[];
  warnings: string[];
}

function parseTaskGroups(markdown: string): TaskGroup[] {
  const normalized = markdown.replace(/\r\n/g, '\n');
  const groups: TaskGroup[] = [];
  // Split on top-level Task Group headers (any preamble falls away with
  // the first split segment; MEMORY.md itself has no version marker).
  const blocks = normalized.split(/^# Task Group:[ \t]*/m).slice(1);
  for (const block of blocks) {
    const lines = block.split('\n');
    const name = (lines[0] ?? '').trim();
    if (!name) continue;
    const warnings: string[] = [];
    const scope = lines.find((l) => l.startsWith('scope:'))?.slice(6).trim() ?? '';
    const appliesTo = lines.find((l) => l.startsWith('applies_to:'))?.slice(11).trim() ?? '';
    // cwd runs to the ';' boundary, a space-separated `reuse_rule=`
    // boundary (both real shapes), or end of line — spaced paths must
    // not truncate at the first space, and the space-form must not glue
    // reuse_rule onto the path (both reviewed rounds).
    let cwd = /cwd=([^;]+?)(?:;|\s+reuse_rule=|$)/.exec(appliesTo)?.[1]?.trim() || null;
    if (!appliesTo) warnings.push(`task group "${name}": applies_to header missing — scoping falls back to --project/global`);
    else if (!cwd) warnings.push(`task group "${name}": applies_to has no cwd= segment — scoping falls back to --project/global`);
    // Only ABSOLUTE paths map to a project: a relative cwd (or a Windows
    // path evaluated on POSIX) would resolve against the IMPORTER's own
    // working directory and inherit whatever repo the user is standing
    // in (review, reproduced). Non-absolute → warn + fall back.
    if (cwd && !cwd.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(cwd)) {
      warnings.push(`task group "${name}": cwd "${cwd}" is not absolute — scoping falls back to --project/global`);
      cwd = null;
    } else if (cwd && /^[A-Za-z]:[\\/]/.test(cwd) && process.platform !== 'win32') {
      warnings.push(`task group "${name}": Windows path "${cwd}" cannot map on this platform — scoping falls back to --project/global`);
      cwd = null;
    }

    // Per-task keywords: ## Task <n> ... ### keywords\n- a, b, c
    const taskKeywords = new Map<number, string[]>();
    for (const tm of block.matchAll(/^## Task (\d+)[^\n]*\n([\s\S]*?)(?=^## |^# |$(?![\s\S]))/gm)) {
      const kw = /^### keywords\n-[ \t]*(.+)$/m.exec(tm[2])?.[1];
      if (kw) taskKeywords.set(Number(tm[1]), kw.split(',').map((k) => k.trim()).filter(Boolean));
    }

    const sectionBullets = (heading: string): string[] => {
      const re = new RegExp(`^## ${heading}\\n([\\s\\S]*?)(?=^## |^# |$(?![\\s\\S]))`, 'm');
      const body = re.exec(block)?.[1] ?? '';
      return [...body.matchAll(/^-\s+(.+(?:\n {2,}.+)*)/gm)]
        .map((m) => m[1].replace(/\n\s+/g, ' ').trim())
        .filter((b) => b.length > 0);
    };

    groups.push({
      name,
      scope,
      appliesTo,
      cwd,
      taskKeywords,
      preferences: sectionBullets('User preferences'),
      knowledge: sectionBullets('Reusable knowledge'),
      failures: sectionBullets('Failures and how to do differently'),
      warnings,
    });
  }
  return groups;
}

/** Keywords for one bullet: the union of the tasks it cites via
 *  [Task n] refs; a ref-less bullet gets the group union. Capped. */
function keywordsForBullet(group: TaskGroup, bullet: string): string[] {
  const refs = [...bullet.matchAll(/\[Task (\d+)\]/g)].map((m) => Number(m[1]));
  const source = refs.length > 0
    ? refs.flatMap((n) => group.taskKeywords.get(n) ?? [])
    : [...group.taskKeywords.values()].flat();
  return [...new Set(source)].slice(0, IMPORT.MAX_KEYWORD_TAGS);
}

/** Strip the `[Task 1]` provenance refs the strict format appends. */
function stripTaskRefs(bullet: string): string {
  return bullet.replace(/\s*(\[Task \d+\])+\s*$/g, '').trim();
}

function groupSections(group: TaskGroup): LearnSection[] {
  // A mapped cwd wins; an unmappable group leaves project UNDEFINED so
  // the CLI --project fallback (or global) applies — never a silent
  // hard-null that blocks the fallback (review).
  const project = group.cwd ? projectId(group.cwd) : undefined;
  const groupSlug = group.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  const baseTags = ['import:codex-memories', ...(groupSlug ? [`group:${groupSlug}`] : [])];
  const why = `Codex task group "${group.name}"${group.scope ? ` — ${group.scope}` : ''}`.slice(0, 200);
  const context = { why };

  const make = (kind: LearnSection['kind'], bullet: string, extraTags: string[] = []): LearnSection => ({
    kind,
    content: stripTaskRefs(bullet),
    // Semantic markers BEFORE harvested keywords: the pipeline caps at
    // MAX_TAGS from the front, and 'preference' silently falling off the
    // end defeated the mapping it implements (review).
    tags: [...baseTags, ...extraTags, ...keywordsForBullet(group, bullet)],
    project,
    context,
    originClient: 'codex',
  });

  const out: LearnSection[] = [];
  for (const bullet of group.failures) out.push(make('pitfall', bullet));
  for (const bullet of group.preferences) out.push(make('fact', bullet, ['preference']));
  for (const bullet of group.knowledge) {
    out.push(make(inferKind(stripTaskRefs(bullet)) === 'decision' ? 'decision' : 'fact', bullet));
  }
  return out;
}

export function transformCodexMemories(dir: string, opts: { includeNotes?: boolean } = {}): CodexMemoriesImport {
  const excluded: Array<{ name: string; reason: string }> = [];
  const notes: string[] = [];
  const sections: LearnSection[] = [];

  if (!existsSync(dir)) {
    throw new Error(`codex memories directory not found: ${dir}`);
  }

  const entries = readdirSync(dir);
  const adHoc: string[] = [];
  for (const name of entries) {
    const rule = EXCLUDED_NAMES.find((r) => r.match(name));
    if (rule) {
      excluded.push({ name, reason: rule.reason });
      continue;
    }
    if (name !== 'MEMORY.md' && name.endsWith('.md')) adHoc.push(name);
    else if (name !== 'MEMORY.md') {
      // 'Enforced AND reported' means EVERY skip is visible — a stray
      // notes.txt or MEMORY.md.bak must not vanish silently (review).
      excluded.push({ name, reason: 'unrecognized format' });
    }
  }

  const memoryPath = join(dir, 'MEMORY.md');
  if (existsSync(memoryPath)) {
    const groups = parseTaskGroups(readFileSync(memoryPath, 'utf-8'));
    for (const group of groups) {
      sections.push(...groupSections(group));
      notes.push(...group.warnings.map((w) => `warning: ${w}`));
    }
    notes.push(`MEMORY.md: ${groups.length} task group(s)`);
  } else {
    notes.push('MEMORY.md not present — nothing structured to import');
  }

  if (adHoc.length > 0) {
    if (opts.includeNotes) {
      for (const name of adHoc) {
        try {
          const fileSections = sectionsFromFreeformMarkdown(
            readFileSync(join(dir, name), 'utf-8'), ['import:codex-memories', 'ad-hoc']);
          sections.push(...fileSections);
          notes.push(`${name}: ${fileSections.length} note section(s)`);
        } catch (err) {
          excluded.push({ name, reason: `unreadable (${(err as NodeJS.ErrnoException).code ?? 'error'})` });
        }
      }
    } else {
      for (const name of adHoc) excluded.push({ name, reason: 'ad-hoc note (use --include-notes to import)' });
    }
  }

  return { sections, excluded, notes };
}
