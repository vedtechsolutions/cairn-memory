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
import type { LearnSection } from './learn-pipeline.js';

export interface MemoryMdImport {
  sections: LearnSection[];
  notes: string[];
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

function inferKind(text: string): LearnSection['kind'] {
  if (/\b(never|avoid|don'?t|broke|breaks|fails?|error|pitfall|gotcha|warning)\b/i.test(text)) return 'pitfall';
  if (/\b(chose|decided|prefer(red)?|opted|instead of|over)\b/i.test(text)) return 'decision';
  return 'fact';
}

function slugify(prefix: string, value: string): string {
  return `${prefix}:${value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)}`;
}

/** Transform one freeform markdown document into learn sections. */
export function sectionsFromFreeformMarkdown(rawMarkdown: string, baseTags: string[]): LearnSection[] {
  const { body: markdown, type } = stripFrontmatter(rawMarkdown);
  const kindHint = type ? FRONTMATTER_KIND[type] : undefined;
  const typeTags = type ? [slugify('type', type)] : [];
  const out: LearnSection[] = [];
  const push = (raw: string, extraTags: string[] = []): void => {
    const content = raw.trim().replace(/\s+/g, ' ').slice(0, LIMITS.MAX_CONTENT_CHARS);
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

export function transformMemoryMd(path: string): MemoryMdImport {
  if (!existsSync(path)) {
    throw new Error(`MEMORY.md not found: ${path}`);
  }
  const notes: string[] = [];
  const sections: LearnSection[] = [];
  const baseTags = ['import:memory-md'];

  const main = sectionsFromFreeformMarkdown(readFileSync(path, 'utf-8'), baseTags);
  sections.push(...main);
  notes.push(`${basename(path)}: ${main.length} section(s)`);

  // Sibling topic files (the auto-memory convention keeps them beside
  // MEMORY.md). Only same-directory .md files — never recurse.
  const dir = dirname(path);
  for (const name of readdirSync(dir)) {
    if (name === basename(path) || !name.endsWith('.md')) continue;
    const full = join(dir, name);
    if (!statSync(full).isFile()) continue;
    const topicSlug = name.replace(/\.md$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
    const fileSections = sectionsFromFreeformMarkdown(
      readFileSync(full, 'utf-8'), [...baseTags, `topic:${topicSlug}`]);
    sections.push(...fileSections);
    notes.push(`${name}: ${fileSections.length} section(s)`);
  }
  return { sections, notes };
}
