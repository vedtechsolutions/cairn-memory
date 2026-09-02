import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { formatMemoryContent, formatAuxText } from '../../utils/memory-injection.js';
import * as z from 'zod/v4';
import type { MemoryRepository } from '../../db/memory-repository.js';
import type { SessionCache } from '../../hooks/shared/session-cache.js';
import { LIMITS, PROMOTION, type ContextMode, type LearnableKind, type MemoryKind, LEARNABLE_KINDS, CONFIDENCE } from '../../constants/index.js';
import { isPrivateProject, canReadPrivate } from '../../config/waykeep-config.js';
import { PrivateScopeChangeError } from '../../db/memory-repository/portability.js';
import { learnSections, safeExcerpt } from '../../importers/learn-pipeline.js';
import { sessionProjectId } from '../../utils/session-project.js';
import { isCritical , registerToolCompat } from './helpers.js';
import { buildFileSection, buildRecordSection, parseExportDocument } from '../../memory-tool/round-trip.js';
import { parseMarkdown } from '../../utils/markdown-parser.js';
import { sanitize, neutralizeMemoryText } from '../../utils/validation.js';
import { TOOL } from '../../constants/mcp.js';

type ContextModeFn = () => ContextMode;

export function registerPortabilityTools(
  server: McpServer,
  repo: MemoryRepository,
  getMode: ContextModeFn,
  sessionCache?: SessionCache,
): void {
  // --- waykeep_ingest -----------------------------------------------------------

  registerToolCompat(server, 
    TOOL.INGEST,
    {
      title: 'Ingest Markdown',
      description: 'Parse structured markdown into memories. v2 sections (data: canonical-JSON payloads) restore losslessly; v1 sections (## Kind: heading + tags: lines) still parse. mode=learn (default) applies gateway semantics (dedup/merge/conflict detection); mode=restore is a strict id-preserving upsert.',
      inputSchema: z.object({
        content: z.string().describe('Structured markdown content with ## sections'),
        project: z.string().max(LIMITS.MAX_STRING_PARAM).nullable().optional().describe('Project scope for v1 sections and v2 records without a project field (null for global)'),
        mode: z.enum(['learn', 'restore']).optional().describe('learn (default): gateway semantics. restore: strict upsert-by-id, no merge/boost/conflict detection'),
        dry_run: z.boolean().optional().describe('Preview parsed sections without writing to DB'),
        from_private: z.boolean().optional().describe(`Explicit acknowledgment when a restore record changes the project scope of an existing PRIVATE-project memory (same acknowledgment ${TOOL.PROMOTE} requires)`),
      }),
    },
    async ({ content, project, mode, dry_run: dryRun, from_private: fromPrivate }) => {
      const critical = isCritical(getMode());
      if (critical) return critical;
      const restoreMode = mode === 'restore';

      const parsed = parseExportDocument(content);
      // A document with no v2 sections at all is a pure-v1 document — feed
      // it to the legacy parser whole so its diagnostics stay unchanged.
      const v1Source = parsed.v1Markdown
        ?? (parsed.records.length + parsed.files.length + parsed.errors.length === 0 ? content : null);
      const v1 = v1Source !== null ? parseMarkdown(v1Source) : { sections: [], errors: [] };
      const total = parsed.records.length + parsed.files.length + v1.sections.length;

      if (total === 0 && parsed.errors.length === 0 && v1.errors.length === 0) {
        return { content: [{ type: 'text' as const, text: 'error: no sections found in markdown' }], isError: true };
      }
      if (restoreMode && v1.sections.length + v1.errors.length > 0) {
        return { content: [{ type: 'text' as const, text: 'error: restore mode requires v2 sections (data: payloads) — v1 sections carry no ids' }], isError: true };
      }
      if (restoreMode) {
        // EVERYTHING validates before ANY mutation: strict restore is
        // whole-document-or-nothing.
        if (parsed.errors.length > 0) {
          const details = parsed.errors.map(e => `  ⚠ section ${e.section} "${e.heading}": ${e.error}`);
          return { content: [{ type: 'text' as const, text: ['error: restore aborted, nothing was written — malformed v2 sections:', ...details].join('\n') }], isError: true };
        }
        const missingId = parsed.records.findIndex(r => r.id === undefined);
        if (missingId !== -1) {
          return { content: [{ type: 'text' as const, text: `error: restore mode requires an id on every record (record ${missingId + 1} has none)` }], isError: true };
        }
        const seenIds = new Set<string>();
        for (const record of parsed.records) {
          if (seenIds.has(record.id as string)) {
            return { content: [{ type: 'text' as const, text: `error: duplicate record id ${record.id} — restore is upsert-by-id and each id may appear at most once` }], isError: true };
          }
          seenIds.add(record.id as string);
        }
        const seenPaths = new Set<string>();
        for (const file of parsed.files) {
          if (seenPaths.has(file.path)) {
            return { content: [{ type: 'text' as const, text: `error: duplicate file path ${file.path} — each file may appear at most once` }], isError: true };
          }
          seenPaths.add(file.path);
        }
      }

      if (dryRun) {
        const lines = [
          `Dry run (${restoreMode ? 'restore' : 'learn'}): ${parsed.records.length} v2 records, ${parsed.files.length} files, ${v1.sections.length} v1 sections, ${parsed.errors.length + v1.errors.length} errors`,
          // Scrubbed excerpts: dry-run input is untrusted markdown and a
          // record can BEGIN with a credential (same rule as the CLI).
          ...parsed.records.map((r, i) => `${i + 1}. [${r.kind}] ${safeExcerpt(r.content, 100)}`),
          ...parsed.files.map(f => `file: ${f.path}`),
          ...v1.sections.map((s, i) => `v1 ${i + 1}. [${s.kind}] ${safeExcerpt(s.content, 100)}`),
          ...[...parsed.errors, ...v1.errors].map(e => `⚠ section ${e.section} "${e.heading}": ${e.error}`),
        ];
        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      }

      if (restoreMode) {
        // ONE immediate transaction: any constraint, path, or cap failure
        // rolls the whole document back; the cache bumps only on commit.
        let counts;
        try {
          try {
            counts = repo.restoreAll(
              parsed.records as Array<(typeof parsed.records)[number] & { id: string }>,
              parsed.files,
              { allowPrivateScopeChange: fromPrivate === true, sessionProjectId: sessionProjectId() });
          } catch (err) {
            if (err instanceof PrivateScopeChangeError) {
              // The transaction rolled back — the all-or-nothing contract
              // holds, and the message says so before anything else.
              return { content: [{ type: 'text' as const, text: `error: restore aborted, NOTHING was written — ${err.message}. Changing a private memory's scope requires running from a session inside that project with from_private: true.` }], isError: true };
            }
            throw err;
          }
        } catch (err) {
          return { content: [{ type: 'text' as const, text: `error: restore aborted, nothing was written — ${(err as Error).message}` }], isError: true };
        }
        sessionCache?.bumpMemoryVersion();
        return {
          content: [{
            type: 'text' as const,
            text: [`restored: ${counts.restored}`, `overwritten: ${counts.overwritten}`, `files: ${counts.files}`].join('\n'),
          }],
        };
      }

      let ingested = 0;
      let deduplicated = 0;
      let files = 0;
      const writeErrors: string[] = [];

      // learn mode ingests untrusted markdown (shared "memory packs", repo
      // files). Neutralize content so an imported memory can't carry a forged
      // [WAYKEEP] prefix that would later impersonate Waykeep's system voice (M5).
      // restore mode is a faithful id-preserving round-trip of the user's own
      // export and is deliberately left byte-exact above.
      for (const record of parsed.records) {
        try {
          const result = repo.create({
            content: neutralizeMemoryText(record.content),
            kind: record.kind as LearnableKind,
            tags: record.tags.map(t => sanitize(t)),
            project: record.project ?? project ?? null,
            context: record.context ?? undefined,
            // Step 6 carry-in (F4 class): learn-mode ingest drops untrusted
            // record confidence; pitfalls must not then default to LEARNED
            // 0.65 — exactly the injection gate. Untrusted imports start
            // below it, like auto-mined pitfalls.
            ...(record.kind === 'pitfall' ? { confidence: CONFIDENCE.AUTO_DETECTED } : {}),
          });
          if (result.deduplicated) deduplicated++;
          else ingested++;
        } catch (err) {
          writeErrors.push(`⚠ record "${formatAuxText(record.content.slice(0, 60))}": ${(err as Error).message}`);
        }
      }
      for (const file of parsed.files) {
        try {
          repo.restoreFile(file);
          files++;
        } catch (err) {
          writeErrors.push(`⚠ file ${file.path}: ${(err as Error).message}`);
        }
      }
      // v1 sections ride the SAME shared pipeline the CLI importers use —
      // one neutralize/sanitize/dedup path, no tool-vs-CLI drift.
      {
        const learned = learnSections(repo, v1.sections, project ?? null, { reinforceExact: true });
        ingested += learned.ingested;
        // The tool's output contract predates merge-visibility: its
        // 'deduplicated' count covers both identical skips and merges
        // (unchanged tool strings); the CLI importer reports them apart.
        deduplicated += learned.exactDuplicates + learned.merged.length;
        writeErrors.push(...learned.errors.map(e => `⚠ record ${e}`));
      }

      // Bulk ingest touched memory content — invalidate hot-path skip gates.
      if (ingested + deduplicated + files > 0) sessionCache?.bumpMemoryVersion();

      const parts = [`ingested: ${ingested}`, `deduplicated: ${deduplicated}`, `files: ${files}`];
      const allErrors = [...parsed.errors, ...v1.errors];
      if (allErrors.length + writeErrors.length > 0) {
        parts.push(`skipped: ${allErrors.length + writeErrors.length}`);
        for (const e of allErrors) parts.push(`  ⚠ section ${e.section} "${e.heading}": ${e.error}`);
        for (const w of writeErrors) parts.push(`  ${w}`);
      }

      return { content: [{ type: 'text' as const, text: parts.join('\n') }] };
    },
  );

  // --- waykeep_export -----------------------------------------------------------

  registerToolCompat(server, 
    TOOL.EXPORT,
    {
      title: 'Export Memories',
      description: `Export memories as structured markdown. Output can be re-ingested with ${TOOL.INGEST} for round-trip fidelity.`,
      inputSchema: z.object({
        project: z.string().max(LIMITS.MAX_STRING_PARAM).nullable().optional().describe('Filter by project (null for global only, omit for all)'),
        kind: z.enum(LEARNABLE_KINDS).optional().describe('Filter by memory kind'),
        min_confidence: z.number().min(0).max(1).optional().describe('Minimum confidence threshold (default: 0)'),
      }),
    },
    async ({ project, kind, min_confidence: minConfidence }) => {
      const critical = isCritical(getMode());
      if (critical) return critical;

      // Resolve a bare project name to its full id; preserves undefined so the
      // unfiltered check below (free-form files ride along) still holds.
      const resolvedProject = repo.resolveProject(project);
      const allRecords = repo.exportPortable({
        project: resolvedProject,
        kind: kind as MemoryKind | undefined,
        // Pass through UNDEFINED when unfiltered: the SQL confidence
        // predicate must not silently swallow corrupt active rows.
        minConfidence,
      });
      // Session-bound private reads: an export running OUTSIDE a private
      // project must not carry that project's content (the unfiltered
      // maintenance export would otherwise dump every private row). The
      // exclusion is reported, never silent — a backup taken elsewhere
      // must not look complete when it is not.
      const sessionPid = sessionProjectId();
      const records = allRecords.filter((r) => canReadPrivate(r.project ?? null, sessionPid));
      const excludedPrivate = allRecords.length - records.length;
      // Free-form files ride along on UNFILTERED exports only — any
      // project, kind, or confidence filter asks for records, not files.
      const unfiltered = resolvedProject === undefined && kind === undefined && minConfidence === undefined;
      const files = unfiltered ? repo.exportPortableFiles() : [];

      if (records.length === 0 && files.length === 0) {
        // The exclusion note must survive this path too: a DB whose only
        // matches are private must not read as "nothing exists".
        const note = excludedPrivate > 0
          ? ` (${excludedPrivate} record(s) from private project(s) excluded — export from within the project to include them)`
          : '';
        return { content: [{ type: 'text' as const, text: `No memories match the filter criteria.${note}` }] };
      }

      const lines: string[] = [
        `# Waykeep Export v2`,
        `# Exported: ${new Date().toISOString()}`,
        `# Memories: ${records.length}`,
        `# Files: ${files.length}`,
        ...(excludedPrivate > 0
          ? [`# NOTE: ${excludedPrivate} record(s) from private project(s) excluded — export from within the project to include them`]
          : []),
        '',
      ];
      for (const record of records) {
        lines.push(...buildRecordSection(record), '');
      }
      for (const file of files) {
        lines.push(...buildFileSection(file), '');
      }

      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    },
  );

  // --- waykeep_promote ----------------------------------------------------------

  registerToolCompat(server, 
    TOOL.PROMOTE,
    {
      title: 'Promote to Global',
      description: `Promote a project-scoped memory to global scope so it surfaces in all projects. Requires confidence >= ${PROMOTION.MIN_CONFIDENCE} and kind must be ${PROMOTION.ALLOWED_KINDS.join(' or ')}. Promoting from a project marked private in the scope config requires from_private: true.`,
      inputSchema: z.object({
        id: z.string().describe('Memory ID to promote to global scope'),
        from_private: z.boolean().optional().describe('Explicit acknowledgment when promoting a memory OUT of a private project (its content becomes visible in every project)'),
      }),
    },
    async ({ id, from_private: fromPrivate }) => {
      const critical = isCritical(getMode());
      if (critical) return critical;

      const memory = repo.findById(id);
      if (!memory) {
        return { content: [{ type: 'text' as const, text: 'not found' }] };
      }

      // Standing FIRST — before EVERY row-metadata check (invalidation
      // status included): an outside caller must hit this refusal before
      // learning anything about the row. Globals pass through (a null
      // project is never private).
      if (isPrivateProject(memory.project) && memory.project !== sessionProjectId()) {
        return { content: [{ type: 'text' as const, text: `error: project "${memory.project}" is marked private — its memories can be promoted only from a session inside that project.` }], isError: true };
      }

      if (memory.invalidated) {
        return { content: [{ type: 'text' as const, text: 'error: memory is invalidated' }], isError: true };
      }

      if (memory.project === null) {
        return { content: [{ type: 'text' as const, text: 'already global' }] };
      }

      if (!(PROMOTION.ALLOWED_KINDS as readonly string[]).includes(memory.kind)) {
        return { content: [{ type: 'text' as const, text: `error: only ${PROMOTION.ALLOWED_KINDS.join('/')} can be promoted (got ${memory.kind})` }], isError: true };
      }

      if (memory.confidence < PROMOTION.MIN_CONFIDENCE) {
        return { content: [{ type: 'text' as const, text: `error: confidence too low (${memory.confidence.toFixed(2)} < ${PROMOTION.MIN_CONFIDENCE.toFixed(2)})` }], isError: true };
      }

      // Scope policy: promotion is a door out of a private project — a
      // global memory surfaces everywhere, which is exactly what private
      // prevents. It requires STANDING (the session runs inside the
      // project — same binding as every private read) and then the
      // explicit acknowledgment. The outside-refusal deliberately does
      // NOT name the flag: for an autonomous agent, an error that says
      // "re-run with the flag" is the path of least resistance, and the
      // flag alone would not work anyway.
      if (isPrivateProject(memory.project) && fromPrivate !== true) {
        return { content: [{ type: 'text' as const, text: `error: project "${memory.project}" is marked private — promoting makes this memory visible in ALL projects. Re-run with from_private: true to acknowledge.` }], isError: true };
      }

      const ok = repo.promote(id);
      if (!ok) {
        return { content: [{ type: 'text' as const, text: 'error: promotion failed' }], isError: true };
      }

      // Scope change can affect which briefing a future inject sees — invalidate.
      sessionCache?.bumpMemoryVersion();

      return { content: [{ type: 'text' as const, text: `promoted to global: "${formatMemoryContent({ ...memory, content: memory.content.slice(0, 80) })}"` }] };
    },
  );
}
