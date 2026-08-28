/**
 * SubagentStart handler — inject Cairn context into subagent prompts.
 * Pure business logic: no stdin/stdout/process.exit.
 */
import type { SubagentStartInput } from '../shared/hook-io.js';
import type { HookDbClient } from '../shared/db-client.js';
import { projectId } from '../../utils/project-id.js';
import { isCodexClient } from '../shared/client-adapter.js';
import { CROSS_AGENT_CONTEXT_FRAMING } from '../../constants/index.js';
import { neutralizeMemoryText } from '../../utils/validation.js';

export interface SubagentContextResult {
  /** Context to inject, or null */
  output: string | null;
  hasPlan: boolean;
  pitfalls: number;
  corrections: number;
}

export function handleSubagentContext(input: SubagentStartInput, client: HookDbClient): SubagentContextResult {
  const project = projectId(input.cwd);
  const lines: string[] = [];
  lines.push('[Cairn Context for Subagent]');

  const plan = client.planRepo.getActive(project);
  if (plan) {
    const done = plan.steps.filter(s => s.status === 'done').length;
    const total = plan.steps.length;
    const current = plan.steps.find(s => s.status === 'in_progress');
    // Plan names/steps are user-authored input too — same system-voice
    // impersonation surface as memory content, same render-time defense.
    let planLine = `Plan: "${neutralizeMemoryText(plan.name)}" — ${done}/${total} steps`;
    if (current) {
      planLine += `, current: ${neutralizeMemoryText(current.description)}`;
    }
    lines.push(planLine);
  }

  // Render-time neutralization is the actual defense against stored
  // content impersonating the system voice (a forged "[CAIRN] …" prefix
  // would sit directly under the genuine framing line above).
  const pitfalls = client.memoryRepo.topPitfalls(project, 2);
  if (pitfalls.length > 0) {
    lines.push('Pitfalls:');
    for (const p of pitfalls) {
      lines.push(`  - ${neutralizeMemoryText(p.content)}`);
    }
  }

  const corrections = client.memoryRepo.activeCorrections(project, 2);
  if (corrections.length > 0) {
    lines.push('Corrections:');
    for (const c of corrections) {
      lines.push(`  - ${neutralizeMemoryText(c.content)}`);
    }
  }

  let output: string | null = null;
  if (lines.length > 1) {
    // Same framing as session-start: the plan line above is exactly the
    // shape that made a live Codex session adopt the plan as its own
    // tasking. Prepended only when there is real content to frame.
    const text = isCodexClient(input)
      ? `${CROSS_AGENT_CONTEXT_FRAMING}\n${lines.join('\n')}`
      : lines.join('\n');
    output = JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SubagentStart',
        additionalContext: text,
      },
    });
  }

  return {
    output,
    hasPlan: !!plan,
    pitfalls: pitfalls.length,
    corrections: corrections.length,
  };
}
