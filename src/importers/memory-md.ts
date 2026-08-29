/**
 * Importer: freeform MEMORY.md auto-memory (Claude Code's native
 * file-based memory, or any hand-kept MEMORY.md + sibling topic files).
 *
 * Freeform markdown has no strict grammar, so the transformer is
 * deliberately conservative: `##`-headed sections become one memory each
 * (heading + body distilled to the body when short, heading-prefixed
 * otherwise), top-level bullets outside any section become individual
 * fact rows, and kind is inferred from wording (never/avoid/broke →
 * pitfall; chose/decided/prefer-over → decision; else fact). Long prose
 * sections are truncated at the memory limit rather than dropped —
 * imports must be lossy-visible, not lossy-silent.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { IMPORT, LIMITS } from '../constants/index.js';
import { scrubSecrets } from '../utils/secret-scanner.js';
import type { LearnSection } from './learn-pipeline.js';
import { inferKind, slugTag } from './shared.js';

export interface MemoryMdImport {
  sections: LearnSection[];
  notes: string[];
  excluded?: Array<{ name: string; reason: string }>;
}

/** Native auto-memory topic files carry YAML frontmatter (`type:` of
 *  user|feedback|project|reference, `modified:` ISO). Strip it, and let
 *  the type hint the kind: feedback = a lesson from user correction. */
export function stripFrontmatter(markdown: string): { body: string; type: string | null } {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(markdown);
  if (!m) return { body: markdown, type: null };
  const type = /^type:\s*(\S+)/m.exec(m[1])?.[1] ?? null;
  return { body: markdown.slice(m[0].length), type };
}

const FRONTMATTER_KIND: Record<string, LearnSection['kind']> = {
  feedback: 'correction',
  user: 'fact',
  project: 'fact',
  reference: 'fact',
};

/** Only the documented auto-memory types mark a sibling as a topic file
 *  — ANY `type:` would let a README with `type: guide` through the gate
 *  (review round 2). */
export function isAutoMemoryType(type: string | null): boolean {
  // Own-property check: `in` walks the prototype chain, so `type:
  // constructor` (or toString/__proto__) passed the gate and even
  // produced a FUNCTION-valued kind via the lookup (closing review).
  return type !== null && Object.hasOwn(FRONTMATTER_KIND, type);
}



/** Drop fenced code blocks per CommonMark: an opener is 3+ backticks
 *  (info string may not contain a backtick — a line like ```lang` is
 *  ordinary text, and treating it as an opener DELETED every lesson
 *  after it) or 3+ tildes (any info string), up to 3 leading spaces; a
 *  closer is at least as many of the SAME character with only trailing
 *  whitespace (a mixed ```~~~ line is fence CONTENT, not a closer — the
 *  regex form falsely closed there and imported the rest of the fence
 *  as lessons); an unclosed fence runs to EOF. Line scanner because the
 *  closer's char and minimum length depend on the opener (review rounds
 *  2 and closing, all three shapes executed). */
function stripFences(markdown: string): { text: string; unclosedDropped: number } {
  const kept: string[] = [];
  let fence: { char: string; len: number } | null = null;
  let droppedInCurrent = 0;
  for (const line of markdown.split('\n')) {
    if (fence) {
      if (new RegExp(`^ {0,3}${fence.char}{${fence.len},}[ \\t]*$`).test(line)) fence = null;
      else droppedInCurrent++;
      continue; // fence lines (opener, content, closer) all drop
    }
    const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (open && (open[1][0] === '~' || !open[2].includes('`'))) {
      fence = { char: open[1][0], len: open[1].length };
      droppedInCurrent = 0;
      continue;
    }
    kept.push(line);
  }
  // A still-open fence at EOF swallowed everything after its opener —
  // CommonMark-correct, but the module promises lossy-VISIBLE: a stray
  // ``` must not silently vanish the rest of the file (review).
  return { text: kept.join('\n'), unclosedDropped: fence ? droppedInCurrent : 0 };
}

/** Transform one freeform markdown document into learn sections.
 *  `notes` (optional) receives lossy-visibility warnings. */

export function sectionsFromFreeformMarkdown(rawMarkdown: string, baseTags: string[], notes?: string[]): LearnSection[] {
  // CRLF normalize, then MASK fenced code blocks: a '## ' inside a fence
  // is an example, not a section boundary, and a '#' line inside one is
  // not a lesson (review). Imported lessons are prose — fences drop.
  const { text: noFences, unclosedDropped } = stripFences(rawMarkdown.replace(/\r\n/g, '\n'));
  if (unclosedDropped > 0) notes?.push(`unclosed code fence: ${unclosedDropped} line(s) dropped as fence content (no closing fence found)`);
  const { body: markdown, type } = stripFrontmatter(noFences);
  const kindHint = type && Object.hasOwn(FRONTMATTER_KIND, type) ? FRONTMATTER_KIND[type] : undefined;
  const typeTags = type ? [slugTag('type', type)] : [];
  const out: LearnSection[] = [];
  const push = (raw: string, extraTags: string[] = []): void => {
    // Scrub BEFORE the clip: slicing raw text can cut a credential at
    // the boundary so the scrubber no longer recognizes the remnant —
    // the pipeline scrubs-then-clips, and so must every upstream cap
    // (closing review, reproduced with a boundary-straddling token).
    const content = scrubSecrets(raw.trim().replace(/\s+/g, ' ')).text.slice(0, LIMITS.MAX_CONTENT_CHARS);
    if (content.length < IMPORT.MIN_SECTION_CHARS) return; // headers alone carry no lesson
    out.push({ kind: kindHint ?? inferKind(content), content, tags: [...baseTags, ...typeTags, ...extraTags] });
  };

  // Split into ## sections; the preamble (before any ##) is scanned for
  // standalone bullets.
  const parts = markdown.split(/^## +/m);
  const preamble = parts[0] ?? '';
  for (const m of preamble.matchAll(/^[-*] +(.+(?:\n {2,}.+)*)/gm)) {
    push(m[1].replace(/\n\s+/g, ' '));
  }
  for (const part of parts.slice(1)) {
    const newline = part.indexOf('\n');
    const heading = (newline === -1 ? part : part.slice(0, newline)).trim();
    const body = newline === -1 ? '' : part.slice(newline + 1).trim();
    const headingSlug = heading.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
    const tags = headingSlug ? [`topic:${headingSlug}`] : [];
    const bullets = [...body.matchAll(/^[-*] +(.+(?:\n {2,}.+)*)/gm)];
    if (bullets.length >= IMPORT.MIN_BULLETS_FOR_SPLIT) {
      // A bullet list under a heading: each bullet is its own lesson.
      for (const b of bullets) push(b[1].replace(/\n\s+/g, ' '), tags);
    } else if (body) {
      // Prose section: one memory, heading kept for retrieval.
      push(`${heading}: ${body}`, tags);
    }
  }
  return out;
}

export function transformMemoryMd(path: string, opts: { includeSiblings?: boolean } = {}): MemoryMdImport {
  if (!existsSync(path)) {
    throw new Error(`MEMORY.md not found: ${path}`);
  }
  const notes: string[] = [];
  const excluded: Array<{ name: string; reason: string }> = [];
  const sections: LearnSection[] = [];
  const baseTags = ['import:memory-md'];

  const fenceNotes: string[] = [];
  const main = sectionsFromFreeformMarkdown(readFileSync(path, 'utf-8'), baseTags, fenceNotes);
  sections.push(...main);
  notes.push(`${basename(path)}: ${main.length} section(s)`);
  notes.push(...fenceNotes.map((n) => `warning: ${basename(path)}: ${n}`));

  // Sibling .md files import ONLY when they are recognizably auto-memory
  // topic files (YAML frontmatter with a type:) or the caller opted in —
  // '--path ./MEMORY.md' in a repo root must not slurp README/CHANGELOG
  // as global facts (review). Per-file try/catch: one broken symlink
  // must not abort the whole migration.
  const dir = dirname(path);
  for (const name of readdirSync(dir)) {
    if (name === basename(path) || !name.endsWith('.md')) continue;
    try {
      const full = join(dir, name);
      if (!statSync(full).isFile()) continue;
      const raw = readFileSync(full, 'utf-8');
      const hasMemoryFrontmatter = isAutoMemoryType(stripFrontmatter(raw.replace(/\r\n/g, '\n')).type);
      if (!hasMemoryFrontmatter && !opts.includeSiblings) {
        excluded.push({ name, reason: 'no auto-memory frontmatter (use --include-notes to import siblings)' });
        continue;
      }
      const topicSlug = name.replace(/\.md$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
      const sibNotes: string[] = [];
      const fileSections = sectionsFromFreeformMarkdown(raw, [...baseTags, `topic:${topicSlug}`], sibNotes);
      sections.push(...fileSections);
      notes.push(`${name}: ${fileSections.length} section(s)`);
      notes.push(...sibNotes.map((n) => `warning: ${name}: ${n}`));
    } catch (err) {
      excluded.push({ name, reason: `unreadable (${(err as NodeJS.ErrnoException).code ?? 'error'})` });
    }
  }
  return { sections, notes, excluded };
}
