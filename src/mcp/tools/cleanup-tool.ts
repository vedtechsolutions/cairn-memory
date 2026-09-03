/**
 * waykeep_cleanup — bulk deletion by filter: preview, elicited confirmation,
 * and the one-statement delete that skips private rows.
 */
import * as z from 'zod/v4';
import { formatMemoryContent } from '../../utils/memory-injection.js';
import { LEARNABLE_KINDS, LIMITS, CLEANUP_ACTIONS } from '../../constants/index.js';
import { canReadPrivate } from '../../config/waykeep-config.js';
import { sessionProjectId } from '../../utils/session-project.js';
import { isCritical, registerToolCompat } from './helpers.js';
import { TOOL } from '../../constants/mcp.js';
import { bumpCache, type MemoryToolDeps } from './memory-tool-deps.js';

export function registerCleanupTool(deps: MemoryToolDeps): void {
  const { server, repo, getMode, innerServer, sessionCache } = deps;
  // --- waykeep_cleanup ---------------------------------------------------------

  registerToolCompat(server,
    TOOL.CLEANUP,
    {
      title: 'Cleanup Memories',
      description: 'Bulk delete memories by filter. Use "preview" first to see what would be deleted, then "execute" to delete.',
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: z.object({
        action: z.enum(CLEANUP_ACTIONS).describe('"preview" to see matches, "execute" to delete'),
        filter: z.object({
          project: z.string().optional().describe('Filter by project ID'),
          kind: z.enum(LEARNABLE_KINDS).optional().describe('Filter by memory kind'),
          max_confidence: z.number().optional().describe('Delete below this confidence threshold'),
          older_than_days: z.number().int().positive().optional().describe('Delete older than N days'),
          never_recalled: z.boolean().optional().describe('Only delete memories with 0 recalls'),
        }).describe('Filter criteria for cleanup'),
      }),
    },
    async ({ action, filter }) => {
      const critical = isCritical(getMode());
      if (critical) return critical;

      const cleanupFilter = {
        // Destructive op: an explicit empty/unknown project must match NOTHING,
        // never fall through to "all" — keep the raw value when it doesn't resolve.
        project: filter.project === undefined ? undefined : (repo.resolveProject(filter.project) ?? filter.project),
        kind: filter.kind,
        maxConfidence: filter.max_confidence,
        olderThanDays: filter.older_than_days,
        neverRecalled: filter.never_recalled,
      };

      if (action === 'preview') {
        const matches = repo.findByFilter(cleanupFilter, LIMITS.CLEANUP_MAX_DELETE);
        if (matches.length === 0) {
          return { content: [{ type: 'text', text: 'No memories match this filter.' }] };
        }
        const previewPid = sessionProjectId();
        const sample = matches.slice(0, 5).map(m =>
          canReadPrivate(m.project, previewPid)
            ? `  • [${m.kind}] "${formatMemoryContent({ ...m, content: m.content.slice(0, 80) })}" (conf: ${m.confidence.toFixed(2)})`
            : `  • [${m.kind}] [private project — content hidden] (conf: ${m.confidence.toFixed(2)})`
        );
        const lines = [
          `Would delete ${matches.length} memories (max ${LIMITS.CLEANUP_MAX_DELETE}).`,
          'Sample:',
          ...sample,
        ];
        if (matches.length > 5) lines.push(`  ... and ${matches.length - 5} more`);
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }

      // Attempt user confirmation via MCP elicitation before bulk delete
      if (innerServer) {
        try {
          const preview = repo.findByFilter(cleanupFilter, LIMITS.CLEANUP_MAX_DELETE);
          if (preview.length === 0) {
            return { content: [{ type: 'text', text: 'No memories match this filter.' }] };
          }
          const result = await innerServer.elicitInput({
            message: `Delete ${preview.length} memories? This cannot be undone.`,
            requestedSchema: {
              type: 'object' as const,
              properties: {
                confirm: {
                  type: 'boolean' as const,
                  title: 'Confirm deletion',
                  description: `Delete ${preview.length} memories matching the filter`,
                },
              },
              required: ['confirm'],
            },
          });
          if (result.action !== 'accept' || !(result.content as Record<string, unknown>)?.confirm) {
            return { content: [{ type: 'text', text: 'Cleanup cancelled by user.' }] };
          }
        } catch {
          // Client doesn't support elicitation — proceed without confirmation
        }
      }

      // N5: destruction follows readability — an agent that cannot read a
      // private project's rows must not be able to delete them either
      // (the preview redacts their content; deleting them anyway would
      // protect confidentiality while surrendering integrity).
      const candidates = repo.findByFilter(cleanupFilter, LIMITS.CLEANUP_MAX_DELETE);
      const executePid = sessionProjectId();
      const deletable = candidates.filter(m => canReadPrivate(m.project, executePid));
      const skippedPrivate = candidates.length - deletable.length;
      // One statement — a per-row loop an interruption leaves half-applied
      // would trade cleanup's atomicity for the private-row exclusion.
      const deleted = repo.deleteByIds(deletable.map(m => m.id));
      if (deleted > 0) bumpCache(sessionCache);
      const note = skippedPrivate > 0
        ? ` (${skippedPrivate} in private project(s) skipped — run from a session inside the project)` : '';
      return { content: [{ type: 'text', text: `deleted ${deleted}${note}` }] };
    },
  )
}
