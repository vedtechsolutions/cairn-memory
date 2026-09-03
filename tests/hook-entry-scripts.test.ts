/**
 * The direct-node hook entry points, run as Claude Code runs them: a child
 * process fed JSON on stdin. The hermetic preload has already pointed the
 * state dir, state file and database at temporary locations, and children
 * inherit that environment, so nothing here touches a real store.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createHookDbClient } from '../src/hooks/shared/db-client.js';
import { loadTracker } from '../src/hooks/shared/edit-tracker.js';
import { readState } from '../src/hooks/shared/state-io.js';
import { ENV } from '../src/constants/env.js';
import { AUTOCOMPACT_BUFFER_TOKENS, LIMITS, PERCENT_TOTAL } from '../src/constants/index.js';
import { projectId } from '../src/utils/project-id.js';

const HOOKS = join(process.cwd(), 'dist', 'src', 'hooks');
const CWD = '/tmp/twins-entry-project';
const SPAWN_TIMEOUT_MS = 20_000;
const WINDOW = 1_000_000;
const USED_PCT = 10;

/** Self-guard: this file writes through the database override, so an unset
 *  or non-temporary override must fail the test, never reach a live store. */
function hermeticDbPath(): string {
  const path = process.env[ENV.DB_PATH];
  assert.ok(path, 'the hermetic preload must pin the database path');
  assert.ok(resolve(path).startsWith(resolve(tmpdir()) + sep), `database override must live under the OS temp dir: ${path}`);
  return path;
}

function runEntry(
  script: string, input: unknown, extraEnv: Record<string, string> = {},
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [join(HOOKS, script)], {
    input: JSON.stringify(input), encoding: 'utf-8', timeout: SPAWN_TIMEOUT_MS,
    // Debug-level logging so a swallowed failure shows up in the assertion's stderr.
    env: { ...process.env, [ENV.LOG_LEVEL]: 'debug', ...extraEnv },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function withDb<T>(fn: (client: ReturnType<typeof createHookDbClient>) => T): T {
  const client = createHookDbClient(hermeticDbPath());
  try { return fn(client); } finally { client.close(); }
}

describe('hook entry scripts (direct-node path)', () => {
  it('statusline writes the state file and prints the bar with counts', () => {
    const project = projectId(CWD);
    withDb(client => {
      client.memoryRepo.create({ content: 'Entry scripts are exercised as child processes fed JSON on stdin.', kind: 'fact', project });
    });
    const result = runEntry('statusline.js', {
      session_id: 'entry-status', cwd: CWD,
      context_window: { used_percentage: USED_PCT, remaining_percentage: PERCENT_TOTAL - USED_PCT, context_window_size: WINDOW, total_input_tokens: 0, total_output_tokens: 0 },
    });
    assert.equal(result.status, 0, result.stderr);
    const bufferPct = Math.round((AUTOCOMPACT_BUFFER_TOKENS * PERCENT_TOTAL) / WINDOW);
    assert.equal(result.stdout, `Waykeep: normal | ${PERCENT_TOTAL - USED_PCT - bufferPct}% free | 1 mem`);
    const state = readState();
    assert.equal(state.mode, 'normal');
    assert.equal(JSON.parse(readFileSync(process.env[ENV.STATE_PATH]!, 'utf-8')).mode, 'normal');
  });

  it('subagent-stop notes the outcome on the in-progress step through the shared handler', () => {
    const project = projectId(CWD);
    const planId = withDb(client => {
      const { plan } = client.planRepo.create({ project, name: 'entry plan', steps: [{ description: 'first step' }] });
      client.planRepo.updateStep(plan.id, { step_id: 1, status: 'in_progress' });
      return plan.id;
    });
    const message = 'Implemented the shared statusline core and pointed both entry points at it. '.repeat(2);
    const result = runEntry('subagent-stop.js', { session_id: 'entry-sub', cwd: CWD, agent_id: 'a1', agent_type: 'general-purpose', last_assistant_message: message });
    assert.equal(result.status, 0, result.stderr);
    const notes = withDb(client => client.planRepo.getActive(project)?.steps[0].notes ?? []);
    assert.equal(notes.length, 1);
    assert.match(notes[0].note, /^\[general-purpose\] Implemented the shared statusline core/);
    assert.ok(notes[0].note.length <= LIMITS.SUBAGENT_SUMMARY_MAX_CHARS + '[general-purpose] '.length);
    // A repeat with the same summary is deduplicated on this path too now.
    runEntry('subagent-stop.js', { session_id: 'entry-sub', cwd: CWD, agent_id: 'a1', agent_type: 'general-purpose', last_assistant_message: message });
    assert.equal(withDb(client => client.planRepo.getActive(project)?.steps[0].notes.length), 1);
    withDb(client => client.planRepo.updateStep(planId, { step_id: 1, status: 'done' }));
  });

  it('plan-bridge persists a plan from the tool response and prints the confirmation', () => {
    const cwd = `${CWD}-bridge`;
    const result = runEntry('plan-bridge.js', {
      session_id: 'entry-bridge', cwd, tool_name: 'ExitPlanMode', tool_input: {},
      tool_response: '# Plan\n\n1. Write the shared core module\n2. Point both entry points at it',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Plan auto-persisted: "Plan" \(2 steps\)/);
    assert.equal(withDb(client => client.planRepo.getActive(projectId(cwd))?.steps.length), 2);
    const skipped = runEntry('plan-bridge.js', { session_id: 'entry-bridge', cwd, tool_name: 'Read', tool_input: {} });
    assert.equal(skipped.status, 0);
    assert.equal(skipped.stdout, '');
  });

  it('success-tracker updates the locked tracker file for the session', () => {
    const sessionId = 'entry-success';
    const filePath = `${CWD}/edited.ts`;
    const result = runEntry('success-tracker.js', {
      session_id: sessionId, cwd: CWD, tool_name: 'Write', tool_input: { file_path: filePath, content: 'x' }, tool_response: '',
    });
    assert.equal(result.status, 0, result.stderr);
    const tracker = loadTracker(sessionId);
    assert.equal(tracker.lastEditPath, filePath);
    assert.equal(tracker.editCountsByFile[filePath], 1);
    assert.equal(tracker.lastEditCursor?.line, 1);
    const ignored = runEntry('success-tracker.js', { session_id: sessionId, cwd: CWD, tool_name: 'Read', tool_input: { file_path: filePath }, tool_response: '' });
    assert.equal(ignored.status, 0);
    assert.equal(loadTracker(sessionId).editCountsByFile[filePath], 1, 'untracked tools leave the tracker alone');
  });

  it('success-tracker still records the tracker when the database cannot open', () => {
    const sessionId = 'entry-success-nodb';
    const filePath = `${CWD}/nodb.ts`;
    // A directory where the database file should be: openDatabase throws.
    const result = runEntry('success-tracker.js', {
      session_id: sessionId, cwd: CWD, tool_name: 'Write', tool_input: { file_path: filePath, content: 'x' }, tool_response: '',
    }, { [ENV.DB_PATH]: process.env[ENV.DIR]! });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /database unavailable, tracking without it/);
    const tracker = loadTracker(sessionId);
    assert.equal(tracker.lastEditPath, filePath);
    assert.equal(tracker.editCountsByFile[filePath], 1);
  });
});
