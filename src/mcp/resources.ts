/**
 * MCP Resource registrations for Waykeep.
 * Exposes read-only views of plan state and briefings without token budget constraints.
 */
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { formatMemoryContent , formatAuxText } from '../utils/memory-injection.js';
import { canReadPrivate } from '../config/waykeep-config.js';
import { sessionProjectId } from '../utils/session-project.js';
import { legacyCompatActive } from '../constants/paths.js';
import { LEGACY_NAMESPACES } from 'waykeep-contract';
import type { McpServer, ReadResourceTemplateCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { PlanRepository, Plan } from '../db/plan-repository.js';
import type { MemoryRepository } from '../db/memory-repository.js';
import type { ContextMode } from '../constants/index.js';
import { RESOURCE_URI, MCP_URI_SCHEME } from '../constants/mcp.js';

/**
 * Register a resource under its current URI, plus a legacy-scheme alias
 * (e.g. `cairn://…`) that reuses the SAME handler while legacy compat is
 * active. Existing legacy consumers of `cairn://plan/…` / `cairn://briefing/…` must
 * not get "resource not found" on an un-migrated store — tool-name compat is
 * not enough (codex B1 review). Aliases retire automatically once migrated.
 */
function registerResourceCompat(
  server: McpServer,
  name: string,
  uriTemplate: string,
  description: string,
  handler: ReadResourceTemplateCallback,
): void {
  server.resource(name, new ResourceTemplate(uriTemplate, { list: undefined }), { description }, handler);
  const schemePrefix = `${MCP_URI_SCHEME}://`;
  if (!legacyCompatActive() || !uriTemplate.startsWith(schemePrefix)) return;
  const rest = uriTemplate.slice(schemePrefix.length);
  for (const ns of LEGACY_NAMESPACES) {
    server.resource(
      `${ns}-${name}`,
      new ResourceTemplate(`${ns}://${rest}`, { list: undefined }),
      { description: `[deprecated alias — migration pending] ${description}` },
      handler,
    );
  }
}

type ContextModeFn = () => ContextMode;

export function registerResources(
  server: McpServer,
  planRepo: PlanRepository,
  memoryRepo: MemoryRepository,
  _getMode: ContextModeFn,
): void {
  // --- ACTIVE_PLAN resource -------------------------------------------------
  // Full active plan with all steps, decisions, and notes.
  // No token budget constraint — intended for post-compaction recovery reads.

  registerResourceCompat(
    server,
    'active-plan',
    RESOURCE_URI.ACTIVE_PLAN,
    'Full active plan with all steps, decisions, and notes',
    async (uri, variables) => {
      const project = variables.project as string;
      // Session-bound like the briefing resource below — plan content
      // (step descriptions, decision rationale) is richer than most
      // memory rows and gets the same protection.
      if (!canReadPrivate(project, sessionProjectId())) {
        return { contents: [{ uri: uri.href, mimeType: 'text/plain', text: `[Waykeep] ${project} is marked private — its plan is available only from a session inside that project.` }] };
      }
      const plan = planRepo.getActive(project);
      if (!plan) {
        return { contents: [{ uri: uri.href, mimeType: 'text/plain', text: 'No active plan for this project.' }] };
      }
      return { contents: [{ uri: uri.href, mimeType: 'text/plain', text: formatPlanResource(plan) }] };
    },
  );

  // --- FULL_BRIEFING resource -----------------------------------------------
  // Full briefing without the 500-token budget constraint.
  // Includes pitfalls, corrections, decisions, and plan state.

  registerResourceCompat(
    server,
    'full-briefing',
    RESOURCE_URI.FULL_BRIEFING,
    'Full project briefing without token budget constraints',
    async (uri, variables) => {
      const project = variables.project as string;
      // Session-bound private reads: the URI selects a project, but a
      // private project's briefing is readable only from inside it.
      if (!canReadPrivate(project, sessionProjectId())) {
        return {
          contents: [{
            uri: uri.href,
            text: `[Waykeep] ${project} is marked private — its briefing is available only from a session inside that project.`,
          }],
        };
      }
      const lines: string[] = [];
      lines.push(`[Waykeep Full Briefing — ${project}]`);

      // Plan state
      const plan = planRepo.getActive(project);
      if (plan) {
        lines.push('', formatPlanResource(plan));
      }

      // Pitfalls (up to 10 — no budget)
      const pitfalls = memoryRepo.topPitfalls(project, 10);
      if (pitfalls.length > 0) {
        lines.push('', 'Pitfalls:');
        for (const p of pitfalls) {
          const why = p.context?.why ? ` (Why: ${formatAuxText(p.context.why)})` : '';
          lines.push(`  - ${formatMemoryContent(p)}${why}`);
        }
      }

      // Corrections (up to 5)
      const corrections = memoryRepo.activeCorrections(project, 5);
      if (corrections.length > 0) {
        lines.push('', 'Corrections:');
        for (const c of corrections) {
          lines.push(`  - ${formatMemoryContent(c)}`);
        }
      }

      // Recent decisions from memory (up to 5)
      const decisions = memoryRepo.topDecisions(project, 5);
      if (decisions.length > 0) {
        lines.push('', 'Recent Decisions:');
        for (const d of decisions) {
          lines.push(`  - ${formatMemoryContent(d)}`);
        }
      }

      return { contents: [{ uri: uri.href, mimeType: 'text/plain', text: lines.join('\n') }] };
    },
  );
}

/** Format a full plan as structured text for resource reads. */
function formatPlanResource(plan: Plan): string {
  const lines: string[] = [];
  const done = plan.steps.filter(s => s.status === 'done').length;
  lines.push(`Plan: "${plan.name}" (${plan.status}, ${done}/${plan.steps.length} steps done)`);

  // Steps with full detail
  lines.push('Steps:');
  for (const step of plan.steps) {
    const statusIcon = stepIcon(step.status);
    lines.push(`  ${step.step_id}. ${statusIcon} ${step.description}`);
    if (step.outcome) lines.push(`     Outcome: ${step.outcome}`);
    if (step.blockers) lines.push(`     Blocked: ${step.blockers}`);
    if (step.notes.length > 0) {
      const latest = step.notes[step.notes.length - 1];
      lines.push(`     Note: ${latest.note} (${latest.at})`);
    }
  }

  // Decisions with alternatives
  if (plan.decisions.length > 0) {
    lines.push('Decisions:');
    for (const d of plan.decisions) {
      const alt = d.alternatives.length > 0 ? ` (not: ${d.alternatives.join(', ')})` : '';
      const perm = d.permanent ? ' [permanent]' : '';
      lines.push(`  - Chose: ${d.chose} — ${d.why}${alt}${perm}`);
    }
  }

  return lines.join('\n');
}

function stepIcon(status: string): string {
  switch (status) {
    case 'done': return '[done]';
    case 'in_progress': return '[IN PROGRESS]';
    case 'blocked': return '[BLOCKED]';
    default: return '[pending]';
  }
}
