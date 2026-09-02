/**
 * Plan bridge handler — bridges Claude Code plan mode to Waykeep plans.
 * Pure business logic: no stdin/stdout/process.exit.
 */
import type { PostToolUseInput } from '../shared/hook-io.js';
import { recordRollup } from '../../db/telemetry-rollup.js';
import { ROLLUP_METRICS } from '../../constants/index.js';
import { estimateTokensFast } from '../../utils/tokens.js';
import type { HookDbClient, CachedHookContext } from '../shared/db-client.js';
import { loadTracker } from '../shared/edit-tracker.js';
import { projectId } from '../../utils/project-id.js';
import { parsePlanContent } from '../../utils/plan-parser.js';
import { readFileSync, existsSync } from 'node:fs';
import { LIMITS } from '../../constants/index.js';
import { TOOL } from '../../constants/mcp.js';

export interface PlanBridgeResult {
  /** Message to output, or null */
  output: string | null;
  action: 'skip' | 'created' | 'no-plan-found';
  steps?: number;
}

const SOURCE_EXTENSIONS = new Set([
  'py', 'ts', 'js', 'tsx', 'jsx', 'json', 'xml', 'html', 'css', 'sh', 'yaml', 'yml', 'toml', 'rs', 'go', 'java',
]);

export function handlePlanBridge(
  input: PostToolUseInput,
  client: HookDbClient | CachedHookContext,
): PlanBridgeResult {
  if (input.tool_name !== 'ExitPlanMode') {
    return { output: null, action: 'skip' };
  }

  // GAP J: prefer the in-memory cached tracker to the file path. Mid-session
  // Write events live in the cached tracker because success-tracker updates
  // it there; loading from file would miss those writes until the 60s flush.
  const cachedClient = client as CachedHookContext;
  const tracker = cachedClient.cache?.getTracker(input.session_id) ?? loadTracker(input.session_id);
  const recentWrites = tracker.toolChain
    .filter(t => t.tool === 'Write' && t.file && t.success)
    .reverse();

  if (recentWrites.length === 0) {
    // Fallback: parse from tool_response
    if (input.tool_response && typeof input.tool_response === 'string') {
      const parsed = parsePlanContent(input.tool_response);
      if (parsed && parsed.steps.length >= 2) {
        return createWaykeepPlan(input, parsed, client);
      }
    }
    return { output: null, action: 'no-plan-found' };
  }

  for (const writeEvent of recentWrites.slice(0, 3)) {
    const filePath = writeEvent.file!;
    const ext = filePath.split('.').pop()?.toLowerCase();
    if (ext && SOURCE_EXTENSIONS.has(ext)) continue;
    if (!existsSync(filePath)) continue;

    try {
      const content = readFileSync(filePath, 'utf-8');
      const parsed = parsePlanContent(content);
      if (parsed && parsed.steps.length >= 2) {
        return createWaykeepPlan(input, parsed, client);
      }
    } catch { continue; }
  }

  return { output: null, action: 'no-plan-found' };
}

function createWaykeepPlan(
  input: PostToolUseInput,
  planContent: { name: string; steps: string[] },
  client: HookDbClient,
): PlanBridgeResult {
  const project = projectId(input.cwd);
  const steps = planContent.steps
    .slice(0, LIMITS.MAX_STEPS_PER_PLAN)
    .map(desc => ({ description: desc }));

  client.planRepo.create({ project, name: planContent.name, steps });

  const msg = `[WAYKEEP] Plan auto-persisted: "${planContent.name}" (${steps.length} steps). Survives compaction. Use ${TOOL.PLAN}(step) to track progress.`;
  recordRollup(client.db, input.session_id, ROLLUP_METRICS.INJECTED, 'plan-bridge', estimateTokensFast(msg));
  return { output: msg, action: 'created', steps: steps.length };
}
