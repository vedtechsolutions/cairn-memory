/**
 * MCP Resource registrations for Cairn.
 * Exposes read-only views of plan state and briefings without token budget constraints.
 */
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { canReadPrivate } from '../config/cairn-config.js';
import { sessionProjectId } from '../utils/session-project.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { PlanRepository, Plan } from '../db/plan-repository.js';
import type { MemoryRepository } from '../db/memory-repository.js';
import type { ContextMode } from '../constants/index.js';

type ContextModeFn = () => ContextMode;

export function registerResources(
  server: McpServer,
  planRepo: PlanRepository,
  memoryRepo: MemoryRepository,
  _getMode: ContextModeFn,
): void {
  // --- cairn://plan/{project}/active ----------------------------------------
  // Full active plan with all steps, decisions, and notes.
  // No token budget constraint — intended for post-compaction recovery reads.

  server.resource(
    'active-plan',
    new ResourceTemplate('cairn://plan/{project}/active', { list: undefined }),
    { description: 'Full active plan with all steps, decisions, and notes' },
    async (uri, variables) => {
      const project = variables.project as string;
      const plan = planRepo.getActive(project);
      if (!plan) {
        return { contents: [{ uri: uri.href, mimeType: 'text/plain', text: 'No active plan for this project.' }] };
      }
      return { contents: [{ uri: uri.href, mimeType: 'text/plain', text: formatPlanResource(plan) }] };
    },
  );

  // --- cairn://briefing/{project} -------------------------------------------
  // Full briefing without the 500-token budget constraint.
  // Includes pitfalls, corrections, decisions, and plan state.

  server.resource(
    'full-briefing',
    new ResourceTemplate('cairn://briefing/{project}', { list: undefined }),
    { description: 'Full project briefing without token budget constraints' },
    async (uri, variables) => {
      const project = variables.project as string;
      // Session-bound private reads: the URI selects a project, but a
      // private project's briefing is readable only from inside it.
      if (!canReadPrivate(project, sessionProjectId())) {
        return {
          contents: [{
            uri: uri.href,
            text: `[Cairn] ${project} is marked private — its briefing is available only from a session inside that project.`,
          }],
        };
      }
      const lines: string[] = [];
      lines.push(`[Cairn Full Briefing — ${project}]`);

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
          const why = p.context?.why ? ` (Why: ${p.context.why})` : '';
          lines.push(`  - ${p.content}${why}`);
        }
      }

      // Corrections (up to 5)
      const corrections = memoryRepo.activeCorrections(project, 5);
      if (corrections.length > 0) {
        lines.push('', 'Corrections:');
        for (const c of corrections) {
          lines.push(`  - ${c.content}`);
        }
      }

      // Recent decisions from memory (up to 5)
      const decisions = memoryRepo.topDecisions(project, 5);
      if (decisions.length > 0) {
        lines.push('', 'Recent Decisions:');
        for (const d of decisions) {
          lines.push(`  - ${d.content}`);
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
