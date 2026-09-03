/**
 * Session-end goal_branch + goal_carry_count regression test.
 *
 * Observed bug: session-end.ts INSERT into compaction_snapshots was missing
 * the goal_branch and goal_carry_count columns, causing SessionEnd-sourced
 * snapshots to have NULL branch and 0 carry count. The briefing's
 * branchMismatch + carryCount staleness gates require those fields, so stale
 * goals written at SessionEnd would survive across branch switches forever.
 *
 * This test guards the exact regression class: the INSERT must carry the
 * four-part shape `goal_branch, goal_carry_count` AND the surrounding code
 * must compute currentBranch + inherit carry count on goal continuation.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('session-end.ts goal_branch + goal_carry_count regression', () => {
  // The snapshot stage of the SessionEnd hook (phase 4 split) holds the INSERT
  // and the goal resolution the hook used to carry inline.
  const source = readFileSync(resolve('src/hooks/shared/session-end/final-snapshot.ts'), 'utf-8');
  // Goal-continuity resolution was extracted into the shared goal-resolver
  // (audit refactor) — the inheritance invariants now live there, and
  // session-end must delegate to it.
  const resolverSource = readFileSync(resolve('src/hooks/shared/goal-resolver.ts'), 'utf-8');

  it('includes goal_branch and goal_carry_count columns in the INSERT', () => {
    const insertRegex = /INSERT INTO compaction_snapshots \([^)]+\)/;
    const match = source.match(insertRegex);
    assert.ok(match, 'session-end.ts must contain an INSERT INTO compaction_snapshots');
    assert.match(match![0], /goal_branch/, 'INSERT must include goal_branch column');
    assert.match(match![0], /goal_carry_count/, 'INSERT must include goal_carry_count column');
  });

  it('computes currentBranch from getGitWorkingState for the snapshot', () => {
    assert.match(source, /getGitWorkingState\(input\.cwd\)/,
      'session-end must call getGitWorkingState to capture the goal origin branch');
  });

  it('delegates goal continuity to the shared resolver', () => {
    assert.match(source, /resolveInitialGoal\(/,
      'session-end must resolve the initial goal through the shared goal-resolver');
  });

  it('increments goal_carry_count when inheriting a goal (shared resolver)', () => {
    assert.match(resolverSource, /goal_carry_count \?\? 0\) \+ 1/,
      'goal-resolver must increment goal_carry_count on inheritance');
  });

  it('selects goal_branch + goal_carry_count when scanning prior snapshots (shared resolver)', () => {
    assert.match(resolverSource, /SELECT initial_goal, goal_branch, goal_carry_count/,
      'goal-resolver must read goal_branch + goal_carry_count from prior snapshots');
  });

  it('has 20 placeholder parameters in the INSERT VALUES clause (v23 three-tier goal)', () => {
    // SNR v3 Commit 4 (schema v23): added goal_captured_at +
    // project_goal_captured_at, bringing the column count from 18 → 20.
    // id, session_id, project, captured_at, recent_files, recent_read_files,
    // recent_commands, user_context, approach_notes, initial_goal,
    // goal_captured_at, goal_branch, goal_carry_count, recent_decisions,
    // reasoning_state, error_context, project_goal, project_goal_source,
    // project_goal_captured_at, last_edit_cursor = 20
    const valuesMatch = source.match(/INSERT INTO compaction_snapshots[\s\S]+?VALUES \(([^)]+)\)/);
    assert.ok(valuesMatch, 'must find VALUES clause after INSERT');
    const placeholderCount = (valuesMatch![1].match(/\?/g) ?? []).length;
    assert.equal(placeholderCount, 20, `expected 20 placeholders, got ${placeholderCount}`);
  });

  it('INSERT column list includes last_edit_cursor (Phase 2 v21)', () => {
    const match = source.match(/INSERT INTO compaction_snapshots[^)]+\)/);
    assert.ok(match, 'must find INSERT INTO compaction_snapshots');
    assert.match(match![0], /last_edit_cursor/,
      'INSERT must include last_edit_cursor column');
  });

  it('INSERT column list includes project_goal + project_goal_source (Phase 1)', () => {
    const match = source.match(/INSERT INTO compaction_snapshots[^)]+\)/);
    assert.ok(match, 'must find INSERT INTO compaction_snapshots');
    assert.match(match![0], /project_goal[^_]/,
      'INSERT must include project_goal column');
    assert.match(match![0], /project_goal_source/,
      'INSERT must include project_goal_source column');
  });
});
