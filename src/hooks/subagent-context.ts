#!/usr/bin/env node
/**
 * SubagentStart hook — inject Cairn context into subagent prompts.
 * Subagents start with no Cairn context (no SessionStart briefing).
 * This hook provides a concise summary: plan state + top pitfalls + corrections.
 * async: false — context must be injected before subagent processes.
 */
import { readStdinJson, outputAdditionalContext, type SubagentStartInput } from './shared/hook-io.js';
import { createHookDbClient } from './shared/db-client.js';
import { projectId } from '../utils/project-id.js';
import { neutralizeMemoryText } from '../utils/validation.js';
import { recordTelemetry } from './shared/hook-telemetry.js';

const _startTime = Date.now();
try {
  const input = readStdinJson<SubagentStartInput>();

  const dbPath = process.env.CAIRN_DB_PATH ?? undefined;
  const client = createHookDbClient(dbPath);
  const project = projectId(input.cwd);

  const lines: string[] = [];
  lines.push('[Cairn Context for Subagent]');

  // Active plan summary (name + current step)
  const plan = client.planRepo.getActive(project);
  if (plan) {
    const done = plan.steps.filter(s => s.status === 'done').length;
    const total = plan.steps.length;
    const current = plan.steps.find(s => s.status === 'in_progress');
    let planLine = `Plan: "${plan.name}" — ${done}/${total} steps`;
    if (current) {
      planLine += `, current: ${current.description}`;
    }
    lines.push(planLine);
  }

  // Top pitfalls (2 max — subagents have limited context)
  const pitfalls = client.memoryRepo.topPitfalls(project, 2);
  if (pitfalls.length > 0) {
    lines.push('Pitfalls:');
    for (const p of pitfalls) {
      lines.push(`  - ${neutralizeMemoryText(p.content)}`);
    }
  }

  // Active corrections (2 max — global rules)
  const corrections = client.memoryRepo.activeCorrections(project, 2);
  if (corrections.length > 0) {
    lines.push('Corrections:');
    for (const c of corrections) {
      lines.push(`  - ${neutralizeMemoryText(c.content)}`);
    }
  }

  // Only inject if we have meaningful context beyond the header
  if (lines.length > 1) {
    outputAdditionalContext('SubagentStart', lines.join('\n'));
  }

  client.close();
  recordTelemetry('subagent-context', input.agent_type ?? 'unknown', _startTime, true, undefined, {
    hasPlan: !!plan,
    pitfalls: pitfalls.length,
    corrections: corrections.length,
  });
} catch (err) {
  recordTelemetry('subagent-context', 'error', _startTime, false, String(err));
  console.error('[cairn] SubagentStart hook error:', err);
  process.exit(0);
}
