/**
 * Shared learn-mode ingestion — the ONE path every importer and the MCP
 * cairn_ingest v1 branch ride. Untrusted markdown gets the same defenses
 * everywhere: neutralizeMemoryText (a forged "[CAIRN]" prefix in an
 * imported file must never impersonate the system voice), sanitize on
 * tags, and the repository gateway's dedup/merge. Extracted so the CLI
 * importer and the MCP tool cannot drift (the standalone-twin lesson,
 * three times over).
 */
import type { MemoryRepository } from '../db/memory-repository.js';
import { LIMITS, type LearnableKind } from '../constants/index.js';
import { neutralizeMemoryText, sanitize } from '../utils/validation.js';
import { scrubSecrets } from '../utils/secret-scanner.js';

export interface LearnSection {
  kind: LearnableKind;
  content: string;
  tags: string[];
  /** Optional per-section project override (importers map source scopes;
   *  null = global, undefined = use the batch default). */
  project?: string | null;
  context?: { why?: string; how_to_apply?: string };
  /** Provenance: which agent ecosystem authored this content (schema
   *  v29 origin_client) — 'codex' for codex-memories imports. */
  originClient?: string;
}

/** Preview/diagnostic text must NEVER show raw source content — an
 *  imported bullet can begin with a credential, and dry-run output or an
 *  error message would print it verbatim (review). Scrub + clip. */
export function safeExcerpt(content: string, length = 90): string {
  const scrubbed = scrubSecrets(sanitize(content)).text;
  return scrubbed.length > length ? `${scrubbed.slice(0, length)}…` : scrubbed;
}

export interface LearnResult {
  ingested: number;
  /** IDENTICAL content already stored — a true no-op (idempotent path). */
  exactDuplicates: number;
  /** Distinct source content ABSORBED into a similar existing row by the
   *  gateway's similarity merge. NOT a no-op: the source wording is gone
   *  (the survivor keeps the longer text). A bulk importer is the one
   *  caller that knows the sources were distinct, so it must say so —
   *  'lossy-visible, never silent' (review). */
  merged: Array<{ source: string; survivor: string }>;
  errors: string[];
}

/** Apply sections through the gateway. `defaultProject` scopes sections
 *  without their own; dryRun is decided by the CALLER (importers preview
 *  before calling; the MCP tool has its own dry-run rendering). */
export function learnSections(
  repo: MemoryRepository,
  sections: readonly LearnSection[],
  defaultProject: string | null,
): LearnResult {
  let ingested = 0;
  let exactDuplicates = 0;
  const merged: LearnResult['merged'] = [];
  const errors: string[] = [];
  for (const section of sections) {
    try {
      // Belt: the gateway clips too, but a source bullet exceeding the
      // public limit must not depend on that.
      const content = neutralizeMemoryText(section.content).slice(0, LIMITS.MAX_CONTENT_CHARS);
      const project = section.project !== undefined ? section.project : defaultProject;
      // Probe BEFORE create: after a merge the survivor may equal the
      // submitted text (longer wins), so post-hoc comparison cannot
      // distinguish exact from merged.
      const exactExisted = repo.hasExactContent(content, section.kind, project);
      const result = repo.create({
        content,
        kind: section.kind,
        // Tags get the SAME secret scrub as content, the count cap, and
        // the length cap — a credential or an essay can arrive as a
        // source keyword/concept (review).
        tags: section.tags.map((t) => scrubSecrets(sanitize(t)).text.slice(0, LIMITS.MAX_TAG_CHARS)).slice(0, LIMITS.MAX_TAGS),
        project,
        context: section.context,
        ...(section.originClient ? { originClient: section.originClient } : {}),
      });
      if (!result.deduplicated) ingested++;
      else if (exactExisted) exactDuplicates++;
      else {
        const survivor = result.id ? repo.findById(result.id)?.content ?? '' : '';
        merged.push({ source: safeExcerpt(section.content, 70), survivor: safeExcerpt(survivor, 70) });
      }
    } catch (err) {
      // Scrubbed excerpt only — never raw source content in diagnostics.
      errors.push(`"${safeExcerpt(section.content, 60)}": ${(err as Error).message}`);
    }
  }
  return { ingested, exactDuplicates, merged, errors };
}
