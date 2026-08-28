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
import type { LearnableKind } from '../constants/index.js';
import { neutralizeMemoryText, sanitize } from '../utils/validation.js';

export interface LearnSection {
  kind: LearnableKind;
  content: string;
  tags: string[];
  /** Optional per-section project override (importers map source scopes;
   *  null = global, undefined = use the batch default). */
  project?: string | null;
  context?: { why?: string; how_to_apply?: string };
}

export interface LearnResult {
  ingested: number;
  deduplicated: number;
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
  let deduplicated = 0;
  const errors: string[] = [];
  for (const section of sections) {
    try {
      const result = repo.create({
        content: neutralizeMemoryText(section.content),
        kind: section.kind,
        tags: section.tags.map((t) => sanitize(t)),
        project: section.project !== undefined ? section.project : defaultProject,
        context: section.context,
      });
      if (result.deduplicated) deduplicated++;
      else ingested++;
    } catch (err) {
      errors.push(`"${section.content.slice(0, 60)}": ${(err as Error).message}`);
    }
  }
  return { ingested, deduplicated, errors };
}
