/**
 * Phase 3b: each direct-node hook entry point runs the same implementation
 * as its daemon handler. These pin the shared pieces the entry points call —
 * the statusline core, the subagent summary gate, the plan-bridge result the
 * entry reports, and success tracking on a caller-owned tracker.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHookDbClient } from '../src/hooks/shared/db-client.js';
import {
  computeContextState,
  contextModeFor,
  formatStatusLine,
  readStatusCounts,
  statusCountsFor,
  type StatusLineInput,
} from '../src/hooks/shared/statusline-core.js';
import { hasSubagentSummary } from '../src/hooks/handlers/subagent-stop-handler.js';
import { handlePlanBridge } from '../src/hooks/handlers/plan-bridge-handler.js';
import {
  isGovernanceObservedTool,
  isSuccessTrackedTool,
  trackSuccess,
} from '../src/hooks/handlers/success-tracker-handler.js';
import { loadTracker } from '../src/hooks/shared/edit-tracker.js';
import type { PostToolUseInput, SubagentStopInput } from '../src/hooks/shared/hook-io.js';
import { projectId } from '../src/utils/project-id.js';
import {
  AUTOCOMPACT_BUFFER_TOKENS,
  CONTEXT_THRESHOLDS,
  LIMITS,
  PERCENT_TOTAL,
  isEditToolName,
} from '../src/constants/index.js';

const CWD = '/tmp/twins-project';
const WINDOW = 1_000_000;

function statusInput(usedPercentage: number, cwd?: string): StatusLineInput {
  return {
    session_id: 'twins', cwd,
    context_window: {
      used_percentage: usedPercentage, remaining_percentage: PERCENT_TOTAL - usedPercentage,
      context_window_size: WINDOW, total_input_tokens: 0, total_output_tokens: 0,
    },
  };
}

function postToolInput(overrides: Partial<PostToolUseInput>): PostToolUseInput {
  return {
    session_id: 'twins-session', cwd: CWD, tool_name: 'Write',
    tool_input: { file_path: `${CWD}/a.ts`, content: 'x' }, tool_response: '',
    ...overrides,
  } as PostToolUseInput;
}

describe('statusline core', () => {
  it('maps free space to the mode thresholds', () => {
    assert.equal(contextModeFor(CONTEXT_THRESHOLDS.NORMAL + 1), 'normal');
    assert.equal(contextModeFor(CONTEXT_THRESHOLDS.NORMAL), 'compact');
    assert.equal(contextModeFor(CONTEXT_THRESHOLDS.COMPACT), 'minimal');
    assert.equal(contextModeFor(CONTEXT_THRESHOLDS.MINIMAL), 'critical');
  });

  it('subtracts the autocompact buffer from the free percentage and floors at zero', () => {
    const bufferPct = Math.round((AUTOCOMPACT_BUFFER_TOKENS * PERCENT_TOTAL) / WINDOW);
    assert.deepEqual(computeContextState(statusInput(10)), { mode: 'normal', freeUntilCompact: PERCENT_TOTAL - 10 - bufferPct });
    assert.deepEqual(computeContextState(statusInput(PERCENT_TOTAL)), { mode: 'critical', freeUntilCompact: 0 });
  });

  it('renders the bar with and without counts, showing reminders only when present', () => {
    const state = { mode: 'normal' as const, freeUntilCompact: 80 };
    assert.equal(formatStatusLine(state, null), 'Waykeep: normal | 80% free');
    assert.equal(formatStatusLine(state, { memories: 3, reminders: 0, planStep: null }), 'Waykeep: normal | 80% free | 3 mem');
    assert.equal(
      formatStatusLine(state, { memories: 3, reminders: 2, planStep: { done: 1, total: 4 } }),
      'Waykeep: normal | 80% free | step 1/4 | 3 mem 2 rem',
    );
  });

  it('counts project plus global memories, the active plan step progress and active reminders', () => {
    const client = createHookDbClient(':memory:');
    const project = projectId(CWD);
    try {
      client.memoryRepo.create({ content: 'The deploy script must run from the repository root, never from a subdirectory.', kind: 'fact', project });
      client.memoryRepo.create({ content: 'Prefer exact dependency versions in every project manifest, never ranges.', kind: 'fact', project: null });
      client.memoryRepo.create({ content: 'A memory of another project that must never be counted in this status bar.', kind: 'fact', project: 'other-project' });
      const { plan } = client.planRepo.create({ project, name: 'twins', steps: [{ description: 'one' }, { description: 'two' }] });
      client.planRepo.updateStep(plan.id, { step_id: 1, status: 'done' });
      client.reminderRepo.create({ trigger: 'when tests fail', action: 'check the fixture', project });

      assert.deepEqual(readStatusCounts(client.db, project), { memories: 2, reminders: 1, planStep: { done: 1, total: 2 } });
      assert.deepEqual(statusCountsFor(client.db, CWD)?.planStep, { done: 1, total: 2 });
      assert.equal(statusCountsFor(null, CWD), null, 'no connection → no counts');
      assert.equal(statusCountsFor(client.db, undefined), null, 'no cwd → no counts');
    } finally {
      client.close();
    }
  });
});

function subagentInput(lastAssistantMessage?: string): SubagentStopInput {
  return {
    session_id: 'twins-session', cwd: CWD, agent_id: 'agent-1', agent_type: 'general-purpose',
    last_assistant_message: lastAssistantMessage,
  } as SubagentStopInput;
}

describe('subagent-stop summary gate', () => {
  it('needs a last message at least the minimum length', () => {
    const at = 'x'.repeat(LIMITS.SUBAGENT_MESSAGE_MIN_CHARS);
    assert.equal(hasSubagentSummary(subagentInput(at)), true);
    assert.equal(hasSubagentSummary(subagentInput(at.slice(1))), false);
    assert.equal(hasSubagentSummary(subagentInput()), false);
  });
});

describe('plan-bridge result for the entry point', () => {
  it('reports the created plan id and step count', () => {
    const client = createHookDbClient(':memory:');
    try {
      const result = handlePlanBridge(postToolInput({
        tool_name: 'ExitPlanMode', tool_input: {},
        tool_response: '# Plan\n\n1. Write the shared core module\n2. Point both entry points at it\n3. Add the pinning tests',
      }), client);
      assert.equal(result.action, 'created');
      assert.equal(result.steps, 3);
      assert.ok(result.planId, 'the entry point records the plan id in telemetry');
      assert.equal(client.planRepo.getActive(projectId(CWD))?.id, result.planId);
    } finally {
      client.close();
    }
  });
});

describe('success tracking on a caller-owned tracker', () => {
  it('mutates the tracker it is given and leaves persistence to the caller', () => {
    const client = createHookDbClient(':memory:');
    try {
      const sessionId = 'twins-track';
      const before = JSON.stringify(loadTracker(sessionId));
      const tracker = loadTracker(sessionId);
      const result = trackSuccess(postToolInput({ session_id: sessionId }), client, tracker);
      assert.equal(result.tracked, true);
      assert.equal(tracker.lastEditPath, `${CWD}/a.ts`);
      assert.equal(tracker.editCountsByFile[`${CWD}/a.ts`], 1);
      assert.equal(tracker.lastEditCursor?.line, 1, 'a Write lands at line 1');
      assert.equal(JSON.stringify(loadTracker(sessionId)), before, 'nothing was written: the caller owns the lock and the save');
      assert.equal(trackSuccess(postToolInput({ session_id: sessionId, tool_name: 'Read' }), client, tracker).tracked, false);
    } finally {
      client.close();
    }
  });

  it('governance observes the four Claude tools; tracking also covers every edit tool', () => {
    for (const tool of ['Write', 'Edit', 'MultiEdit', 'Bash']) {
      assert.equal(isGovernanceObservedTool(tool), true, tool);
      assert.equal(isSuccessTrackedTool(tool), true, tool);
    }
    assert.equal(isGovernanceObservedTool('apply_patch'), false);
    assert.equal(isSuccessTrackedTool('apply_patch'), isEditToolName('apply_patch'));
    assert.equal(isSuccessTrackedTool('Read'), false);
  });
});
