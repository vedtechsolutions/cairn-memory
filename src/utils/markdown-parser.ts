import type { LearnableKind } from '../constants/index.js';
import { LIMITS } from '../constants/index.js';
import { sanitize, validateMemoryContent, validateTags } from './validation.js';

// --- Types ------------------------------------------------------------------

export interface ParsedSection {
  kind: LearnableKind;
  content: string;
  tags: string[];
  heading: string;
}

export interface ParseError {
  section: number;
  heading: string;
  error: string;
}

export interface ParseResult {
  sections: ParsedSection[];
  errors: ParseError[];
}

// --- Kind prefix map --------------------------------------------------------

const KIND_PREFIXES: ReadonlyArray<{ prefix: RegExp; kind: LearnableKind }> = [
  { prefix: /^pitfall:\s*/i, kind: 'pitfall' },
  { prefix: /^decision:\s*/i, kind: 'decision' },
  { prefix: /^correction:\s*/i, kind: 'correction' },
  { prefix: /^fact:\s*/i, kind: 'fact' },
];

// --- Parser -----------------------------------------------------------------

/**
 * Parse structured markdown into discrete memory sections.
 *
 * Expected format:
 * ```markdown
 * ## Pitfall: heading text
 * tags: tag1, tag2
 * Body content here.
 * ```
 *
 * - Headings at level 2 (`##`) delimit sections
 * - Kind is inferred from heading prefix (Pitfall:/Decision:/Correction:/Fact:)
 * - Default kind is `fact` if no prefix
 * - Optional `tags:` line (first line after heading, if present)
 * - Body is everything else in the section
 */
export function parseMarkdown(markdown: string): ParseResult {
  const sections: ParsedSection[] = [];
  const errors: ParseError[] = [];

  // Split into sections by ## headings
  const lines = markdown.split('\n');
  const sectionStarts: number[] = [];

  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) {
      sectionStarts.push(i);
    }
  }

  if (sectionStarts.length === 0) {
    return { sections: [], errors: [{ section: 0, heading: '(none)', error: 'No ## headings found — expected structured markdown with ## sections' }] };
  }

  for (let idx = 0; idx < sectionStarts.length; idx++) {
    const start = sectionStarts[idx];
    const end = idx + 1 < sectionStarts.length ? sectionStarts[idx + 1] : lines.length;

    const headingLine = lines[start].replace(/^##\s+/, '').trim();
    const bodyLines = lines.slice(start + 1, end);

    // Infer kind from heading prefix
    let kind: LearnableKind = 'fact';
    let cleanHeading = headingLine;

    for (const { prefix, kind: k } of KIND_PREFIXES) {
      if (prefix.test(headingLine)) {
        kind = k;
        cleanHeading = headingLine.replace(prefix, '').trim();
        break;
      }
    }

    // Strip confidence marker if present (from export round-trip)
    cleanHeading = cleanHeading.replace(/\s*\[confidence:\s*[\d.]+\]$/, '').trim();

    // Parse optional tags line
    let tags: string[] = [];
    let bodyStartIdx = 0;

    // Skip empty lines after heading
    while (bodyStartIdx < bodyLines.length && bodyLines[bodyStartIdx].trim() === '') {
      bodyStartIdx++;
    }

    // Check for tags line
    if (bodyStartIdx < bodyLines.length) {
      const tagsMatch = bodyLines[bodyStartIdx].match(/^tags:\s*(.+)$/i);
      if (tagsMatch) {
        tags = tagsMatch[1]
          .split(',')
          .map(t => t.trim())
          .filter(t => t.length > 0)
          .slice(0, LIMITS.MAX_TAGS);
        bodyStartIdx++;
      }
    }

    // Remaining body lines become content
    const body = bodyLines
      .slice(bodyStartIdx)
      .join('\n')
      .trim();

    // Build content: heading + body (if body exists)
    const content = body ? `${cleanHeading}: ${body}` : cleanHeading;

    if (!content || content.trim().length === 0) {
      errors.push({ section: idx + 1, heading: headingLine, error: 'Empty section — no content after heading' });
      continue;
    }

    // Validate content length
    const contentCheck = validateMemoryContent(content);
    if (!contentCheck.valid) {
      errors.push({ section: idx + 1, heading: headingLine, error: contentCheck.errors.join('; ') });
      continue;
    }

    // Validate tags
    if (tags.length > 0) {
      const tagCheck = validateTags(tags);
      if (!tagCheck.valid) {
        errors.push({ section: idx + 1, heading: headingLine, error: tagCheck.errors.join('; ') });
        continue;
      }
    }

    sections.push({
      kind,
      content: sanitize(content),
      tags,
      heading: headingLine,
    });
  }

  return { sections, errors };
}
