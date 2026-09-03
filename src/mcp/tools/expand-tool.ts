/**
 * waykeep_expand — progressive disclosure for the index briefing's
 * type-coded short IDs, with the same SNR and privacy gates as recall.
 */
import * as z from 'zod/v4';
import { formatMemoryContent, formatAuxText } from '../../utils/memory-injection.js';
import { BRIEFING_MODE } from '../../constants/index.js';
import { canReadPrivate } from '../../config/waykeep-config.js';
import { sessionProjectId } from '../../utils/session-project.js';
import { isCritical, registerToolCompat } from './helpers.js';
import { TOOL } from '../../constants/mcp.js';
import type { MemoryToolDeps } from './memory-tool-deps.js';

export function registerExpandTool(deps: MemoryToolDeps): void {
  const { server, repo, getMode } = deps;
  // --- waykeep_expand ----------------------------------------------------------
  // Progressive-disclosure companion to the index briefing. The index emits
  // short lines prefixed with stable type-coded IDs (dec:xxxxxxxx,
  // pit:xxxxxxxx, cor:xxxxxxxx); Claude passes a subset of those IDs here
  // to pull full content, why, how_to_apply, confidence, and effectiveness
  // when it actually needs the detail. SNR gates match waykeep_recall:
  // invalidated memories are skipped, low-confidence probation items are
  // suppressed.

  registerToolCompat(server,
    TOOL.EXPAND,
    {
      title: 'Expand Memory IDs',
      description: 'Fetch full content, why, how_to_apply, and confidence for a list of memory IDs from the index briefing. Pass IDs like "dec:a1b2c3d4" or "pit:f5e6d7c8" (type prefix + first 8 chars of UUID).',
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      inputSchema: z.object({
        ids: z.array(z.string().max(32)).min(1).max(BRIEFING_MODE.EXPAND_MAX_IDS)
          .describe(`Memory IDs from the index briefing (max ${BRIEFING_MODE.EXPAND_MAX_IDS})`),
      }),
    },
    async ({ ids }) => {
      const mode = getMode();
      const critical = isCritical(mode);
      if (critical) return critical;

      const expandPid = sessionProjectId();
      const lines: string[] = [];
      for (const rawId of ids) {
        // Parse the type prefix: "pit:xxxxxxxx" → kind=pitfall, shortId=xxxxxxxx
        const match = /^(dec|pit|cor|fact|inv):([a-z0-9-]+)$/.exec(rawId.trim());
        if (!match) {
          lines.push(`[skip] "${rawId}": expected format <kind>:<short-id>`);
          continue;
        }
        const [, , shortId] = match;

        // Find memory whose id starts with shortId (the briefing uses first 8 chars)
        const memory = repo.findByShortId(shortId);
        if (!memory || memory.invalidated) {
          lines.push(`[not found] ${rawId}`);
          continue;
        }
        // Session-bound private reads: expand is the progressive-disclosure
        // continuation of the briefing, and findByShortId accepts any
        // unique prefix — without this check a 4-char prefix walk reads
        // every private row's content from anywhere.
        if (!canReadPrivate(memory.project, expandPid)) {
          lines.push(`[private] ${rawId}: belongs to a private project — open it from within that project`);
          continue;
        }

        const tags = memory.tags.length > 0 ? ` [${memory.tags.map(formatAuxText).join(', ')}]` : '';
        const scope = memory.project ? `project=${memory.project}` : 'global';
        lines.push(`[${memory.kind}:${memory.id.slice(0, 8)}] ${formatMemoryContent(memory)}`);
        if (memory.context?.why) lines.push(`  why: ${formatAuxText(memory.context.why)}`);
        if (memory.context?.how_to_apply) lines.push(`  how: ${formatAuxText(memory.context.how_to_apply)}`);
        lines.push(`  conf=${memory.confidence.toFixed(2)} surface=${memory.surface_count} impact=${memory.impact_count} ${scope}${tags}`);
      }

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );
}
