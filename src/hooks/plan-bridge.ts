#!/usr/bin/env node
/**
 * PostToolUse hook for ExitPlanMode — bridges Claude Code plan mode to Cairn's
 * persistent plan system. When the assistant exits plan mode, auto-creates a
 * Cairn plan from the plan file written during plan mode.
 *
 * Plan file discovery: reads the EditTracker's toolChain to find the most
 * recent Write event (the plan file), then parses its markdown content.
 */
import { readStdinJson, type PostToolUseInput } from './shared/hook-io.js';
import { recordRollup } from '../db/telemetry-rollup.js';
import { ROLLUP_METRICS } from '../constants/index.js';
import { estimateTokensFast } from '../utils/tokens.js';
import { createHookDbClient } from './shared/db-client.js';
import { loadTracker } from './shared/edit-tracker.js';
import { projectId } from '../utils/project-id.js';
import { parsePlanContent } from '../utils/plan-parser.js';
import { readFileSync, existsSync } from 'node:fs';
import { LIMITS } from '../constants/index.js';
import { recordTelemetry } from './shared/hook-telemetry.js';

const _startTime = Date.now();

try {
  const input = readStdinJson<PostToolUseInput>();

  if (input.tool_name !== 'ExitPlanMode') process.exit(0);

  // Find the plan file from recent Write events in the toolChain
  const tracker = loadTracker(input.session_id);
  const recentWrites = tracker.toolChain
    .filter(t => t.tool === 'Write' && t.file && t.success)
    .reverse(); // most recent first

  if (recentWrites.length === 0) {
    // Fallback: try to parse plan from tool_response (some Claude Code versions inline it)
    if (input.tool_response && typeof input.tool_response === 'string') {
      const parsed = parsePlanContent(input.tool_response);
      if (parsed && parsed.steps.length >= 2) {
        createCairnPlan(input, parsed);
      }
    }
    process.exit(0);
  }

  // Try each recent Write (most recent first) to find a parseable plan
  const SOURCE_EXTENSIONS = new Set(['py', 'ts', 'js', 'tsx', 'jsx', 'json', 'xml', 'html', 'css', 'sh', 'yaml', 'yml', 'toml', 'rs', 'go', 'java']);
  for (const writeEvent of recentWrites.slice(0, 3)) {
    const filePath = writeEvent.file!;
    // Skip source code files — only parse markdown/text as potential plans
    const ext = filePath.split('.').pop()?.toLowerCase();
    if (ext && SOURCE_EXTENSIONS.has(ext)) continue;
    if (!existsSync(filePath)) continue;

    try {
      const content = readFileSync(filePath, 'utf-8');
      const parsed = parsePlanContent(content);
      if (parsed && parsed.steps.length >= 2) {
        createCairnPlan(input, parsed);
        break;
      }
    } catch { continue; }
  }
} catch (err) {
  recordTelemetry('plan-bridge', 'error', _startTime, false, String(err));
  console.error('[cairn] Plan bridge hook error:', err);
  process.exit(0);
}

/** Create a persistent Cairn plan and output confirmation context */
function createCairnPlan(
  input: PostToolUseInput,
  planContent: { name: string; steps: string[] },
): void {
  const project = projectId(input.cwd);
  const dbPath = process.env.CAIRN_DB_PATH ?? undefined;
  const client = createHookDbClient(dbPath);

  try {
    const steps = planContent.steps
      .slice(0, LIMITS.MAX_STEPS_PER_PLAN)
      .map(desc => ({ description: desc }));

    const result = client.planRepo.create({
      project,
      name: planContent.name,
      steps,
    });

    const msg = `[CAIRN] Plan auto-persisted: "${planContent.name}" (${steps.length} steps). Survives compaction. Use cairn_plan(step) to track progress.`;
    // Same cost row the shared handler records — plan-bridge is a SYNC
    // route, so this stdout IS delivered (standalone twin must not be the
    // one uncounted path; review round 2).
    recordRollup(client.db, input.session_id, ROLLUP_METRICS.INJECTED, 'plan-bridge', estimateTokensFast(msg));
    process.stdout.write(msg);

    recordTelemetry('plan-bridge', 'created', _startTime, true, undefined, {
      steps: steps.length,
      plan_id: result.plan.id,
    });
    client.close();
  } catch (err) {
    client.close();
    recordTelemetry('plan-bridge', 'create-error', _startTime, false, String(err));
  }
}
