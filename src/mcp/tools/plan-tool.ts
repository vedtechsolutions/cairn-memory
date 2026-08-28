import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { canReadPrivate } from '../../config/cairn-config.js';
import { sessionProjectId } from '../../utils/session-project.js';
import * as z from 'zod/v4';
import type { PlanRepository, Plan, PlanStep } from '../../db/plan-repository.js';
import type { MemoryRepository } from '../../db/memory-repository.js';
import type { SessionCache } from '../../hooks/shared/session-cache.js';
import { STEP_STATUSES, CONFIDENCE, type ContextMode } from '../../constants/index.js';

type ContextModeFn = () => ContextMode;

export function registerPlanTool(
  server: McpServer,
  planRepo: PlanRepository,
  memoryRepo: MemoryRepository,
  getMode: ContextModeFn,
  sessionCache?: SessionCache,
): void {
  server.registerTool(
    'cairn_plan',
    {
      title: 'Plan Management',
      description: 'Create, track, and manage task plans with steps, decisions, and progress notes.',
      inputSchema: z.object({
        action: z.enum(['create', 'get', 'step', 'decide', 'note', 'complete', 'list']),

        // For "create"
        name: z.string().optional().describe('Plan name (for create)'),
        steps: z.array(z.object({
          description: z.string(),
          depends_on: z.array(z.number()).optional(),
        })).optional().describe('Steps with dependencies (for create)'),
        project: z.string().max(200).optional().describe('Project ID'),

        // For "get"
        filter: z.enum(['full', 'active', 'current', 'decisions']).optional().describe('Filter for get (default: adapts to context pressure)'),

        // For "step"
        step_id: z.number().int().positive().optional().describe('Step ID (for step/decide/note)'),
        status: z.enum(STEP_STATUSES).optional().describe('New step status (for step)'),
        outcome: z.string().optional().describe('Step outcome (for step)'),
        blockers: z.string().optional().describe('Blocker description (for step)'),

        // For "decide"
        chose: z.string().optional().describe('What was chosen (for decide)'),
        why: z.string().optional().describe('Why this choice (for decide)'),
        alternatives: z.array(z.string()).optional().describe('Alternatives considered (for decide)'),
        permanent: z.boolean().optional().describe('Graduate to memory on plan completion (for decide)'),

        // For "note"
        note: z.string().optional().describe('Progress note — max 300 chars (for note)'),
        replace: z.boolean().optional().describe('Replace all prior notes (for note)'),
      }),
    },
    async (params) => {
      const mode = getMode();
      // Resolve a bare name (e.g. "cairn") to its full id for get/list reads;
      // create keeps params.project (an explicit new scope is the user's call).
      const project = planRepo.resolveProject(params.project) ?? undefined;
      // Session-bound private projects: plans carry richer content than
      // most memory rows (step descriptions, decisions with rationale) —
      // neither readable nor modifiable from another session. One gate
      // covers every action; create's raw target is checked too.
      for (const target of new Set([project, params.project])) {
        if (target && !canReadPrivate(target, sessionProjectId())) {
          return text(`error: project "${target}" is marked private — its plans are accessible only from a session inside that project`, true);
        }
      }

      switch (params.action) {
        case 'create':
          return handleCreate(planRepo, memoryRepo, params, sessionCache);

        case 'get':
          return handleGet(planRepo, project, params.filter, mode);

        case 'step':
          return handleStep(planRepo, project, params, sessionCache);

        case 'decide':
          return handleDecide(planRepo, project, params, sessionCache);

        case 'note':
          return handleNote(planRepo, project, params, sessionCache);

        case 'complete':
          return handleComplete(planRepo, memoryRepo, project, sessionCache);

        case 'list':
          return handleList(planRepo, project);

        default:
          return text(`error: unknown action "${params.action}"`, true);
      }
    },
  );
}

// --- Action Handlers --------------------------------------------------------

function handleCreate(
  repo: PlanRepository,
  memoryRepo: MemoryRepository,
  params: { name?: string; project?: string; steps?: Array<{ description: string; depends_on?: number[] }> },
  sessionCache?: SessionCache,
) {
  if (!params.name) return text('error: name required for create', true);
  if (!params.steps || params.steps.length === 0) return text('error: steps required for create', true);
  if (!params.project) return text('error: project required for create', true);

  const { plan, warnings } = repo.create({
    project: params.project,
    name: params.name,
    steps: params.steps,
  });

  // Phase 4: store the plan name as a first-class goal memory so future
  // prompts can match against it via semantic recall. Dedup against prior
  // same-project goals with identical content — cheap best-effort check.
  try {
    const existing = memoryRepo.search(plan.name, {
      kind: 'goal',
      project: params.project,
      maxResults: 1,
      minConfidence: 0,
    });
    const duplicate = existing.length > 0
      && existing[0].memory.content.toLowerCase().trim() === plan.name.toLowerCase().trim();
    if (!duplicate) {
      memoryRepo.create({
        content: plan.name,
        kind: 'goal',
        project: params.project,
        source: 'user',
        confidence: CONFIDENCE.LEARNED,
        tags: ['plan-goal'],
      });
    }
  } catch { /* best-effort — never block plan creation on memory write */ }

  // New plan state affects briefings on the next inject — invalidate skip gates.
  sessionCache?.bumpMemoryVersion();

  const warn = warnings.length > 0 ? `\n${warnings.join('\n')}` : '';
  return text(`ok — plan "${plan.name}" created with ${plan.steps.length} steps${warn}`);
}

function handleGet(
  repo: PlanRepository,
  project: string | undefined,
  filter: string | undefined,
  mode: ContextMode,
) {
  if (!project) return text('error: project required for get', true);

  // Auto-adapt filter to context pressure
  const effectiveFilter = (filter ?? modeDefaultFilter(mode)) as 'full' | 'active' | 'current' | 'decisions';
  const plan = repo.getFiltered(project, effectiveFilter);

  if (!plan) return text('No active plan.');
  return text(formatPlan(plan, effectiveFilter));
}

function handleStep(
  repo: PlanRepository,
  project: string | undefined,
  params: { step_id?: number; status?: string; outcome?: string; blockers?: string },
  sessionCache?: SessionCache,
) {
  if (!project) return text('error: project required', true);
  if (params.step_id === undefined) return text('error: step_id required', true);

  const plan = repo.getActive(project);
  if (!plan) return text('error: no active plan', true);

  const { ok, warnings } = repo.updateStep(plan.id, {
    step_id: params.step_id,
    status: params.status as 'done' | 'in_progress' | 'pending' | 'blocked' | undefined,
    outcome: params.outcome,
    blockers: params.blockers,
  });

  if (!ok) return text('error: step not found or nothing to update', true);
  sessionCache?.bumpMemoryVersion();
  const warn = warnings.length > 0 ? ` (${warnings.join('; ')})` : '';
  return text(`ok${warn}`);
}

function handleDecide(
  repo: PlanRepository,
  project: string | undefined,
  params: { step_id?: number; chose?: string; why?: string; alternatives?: string[]; permanent?: boolean },
  sessionCache?: SessionCache,
) {
  if (!project) return text('error: project required', true);
  if (!params.chose) return text('error: chose required for decide', true);
  if (!params.why) return text('error: why required for decide', true);

  const plan = repo.getActive(project);
  if (!plan) return text('error: no active plan', true);

  repo.addDecision(plan.id, {
    step_id: params.step_id ?? null,
    chose: params.chose,
    why: params.why,
    alternatives: params.alternatives,
    permanent: params.permanent,
  });

  // New decision added to active plan — invalidate briefing skip gates.
  sessionCache?.bumpMemoryVersion();

  const altSummary = params.alternatives?.length
    ? ` (rejected: ${params.alternatives.join(', ')})`
    : '';
  return text(`ok — recorded: chose "${params.chose}"${altSummary}`);
}

function handleNote(
  repo: PlanRepository,
  project: string | undefined,
  params: { step_id?: number; note?: string; replace?: boolean },
  sessionCache?: SessionCache,
) {
  if (!project) return text('error: project required', true);
  if (params.step_id === undefined) return text('error: step_id required', true);
  if (!params.note) return text('error: note required', true);

  const plan = repo.getActive(project);
  if (!plan) return text('error: no active plan', true);

  const { ok, warnings } = repo.addNote(plan.id, {
    step_id: params.step_id,
    note: params.note,
    replace: params.replace,
  });

  if (!ok) return text(`error: ${warnings.join('; ')}`, true);
  sessionCache?.bumpMemoryVersion();
  return text('ok');
}

function handleComplete(
  repo: PlanRepository,
  memoryRepo: MemoryRepository,
  project: string | undefined,
  sessionCache?: SessionCache,
) {
  if (!project) return text('error: project required', true);

  const plan = repo.getActive(project);
  if (!plan) return text('error: no active plan', true);

  // Surface incomplete work at completion time — a plan marked completed with
  // open steps is a lifecycle inconsistency the agent should see, not create
  // silently. (We don't rewrite step status: completing early is legitimate;
  // it just must be visible.)
  const openSteps = plan.steps.filter(s => s.status !== 'done').length;
  const graduatedDecisions = repo.complete(plan.id);

  // Graduate permanent decisions to memories via unified gateway
  let graduated = 0;
  for (const decision of graduatedDecisions) {
    memoryRepo.storeDecision({
      content: `${decision.chose} — ${decision.why}`,
      project,
      source: 'learned',
      context: { why: decision.why },
    });
    graduated++;
  }

  // Plan completion + graduated memories both affect briefings — always invalidate.
  sessionCache?.bumpMemoryVersion();

  const base = graduated > 0
    ? `ok — plan completed, ${graduated} decision(s) graduated to memories`
    : 'ok — plan completed';
  const msg = openSteps > 0
    ? `${base} (warn: ${openSteps} of ${plan.steps.length} steps were not done)`
    : base;
  return text(msg);
}

function handleList(repo: PlanRepository, project: string | undefined) {
  if (!project) return text('error: project required', true);

  const plans = repo.listByProject(project);
  if (plans.length === 0) return text('No plans for this project.');

  const lines = plans.map(p => {
    const doneSteps = p.steps.filter(s => s.status === 'done').length;
    return `• [${p.status}] "${p.name}" — ${doneSteps}/${p.steps.length} steps done (${p.updated_at})`;
  });
  return text(lines.join('\n'));
}

// --- Formatting Helpers -----------------------------------------------------

function formatPlan(plan: Plan, filter: string): string {
  const lines: string[] = [];
  lines.push(`Plan: "${plan.name}" [${plan.status}]`);

  if (plan.steps.length > 0) {
    lines.push('Steps:');
    for (const step of plan.steps) {
      lines.push(formatStep(step));
    }
  }

  if (plan.decisions.length > 0) {
    lines.push('Decisions:');
    for (const d of plan.decisions) {
      const scope = d.step_id ? `step ${d.step_id}` : 'plan-level';
      const perm = d.permanent ? ' [permanent]' : '';
      let decisionLine = `  ${scope}: chose "${d.chose}" because ${d.why}${perm}`;
      if (d.alternatives.length > 0) {
        decisionLine += ` (rejected: ${d.alternatives.join(', ')})`;
      }
      lines.push(decisionLine);
    }
  }

  if (filter !== 'full') {
    lines.push(`(filtered: ${filter})`);
  }

  return lines.join('\n');
}

function formatStep(step: PlanStep): string {
  const statusIcon: Record<string, string> = {
    done: '[x]',
    in_progress: '[>]',
    pending: '[ ]',
    blocked: '[!]',
  };
  const icon = statusIcon[step.status] ?? '[ ]';
  let line = `  ${icon} ${step.step_id}. ${step.description}`;

  if (step.depends_on.length > 0) {
    line += ` (depends: ${step.depends_on.join(', ')})`;
  }
  if (step.outcome) {
    line += `\n      outcome: ${step.outcome}`;
  }
  if (step.blockers) {
    line += `\n      blocked: ${step.blockers}`;
  }
  if (step.notes.length > 0) {
    const latest = step.notes[step.notes.length - 1];
    line += `\n      note: ${latest.note}`;
  }
  return line;
}

function modeDefaultFilter(mode: ContextMode): string {
  switch (mode) {
    case 'normal': return 'full';
    case 'compact': return 'active';
    case 'minimal': return 'current';
    case 'critical': return 'current';
  }
}

function text(msg: string, isError = false) {
  return {
    content: [{ type: 'text' as const, text: msg }],
    ...(isError ? { isError: true } : {}),
  };
}
