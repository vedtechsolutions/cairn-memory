/**
 * GAP I — subagent-stop + success-tracker must dedup plan notes against
 * the last note on the in-progress step. Without this, long sessions
 * accumulate dozens of identical `Verified: foo.ts (tests pass)` entries.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type Database from 'better-sqlite3';
import { openDatabase } from '../src/db/connection.js';
import { PlanRepository } from '../src/db/plan-repository.js';
import { MemoryRepository } from '../src/db/memory-repository.js';
import { ReminderRepository } from '../src/db/reminder-repository.js';
import { ContextRepository } from '../src/db/context-repository.js';
import { InvestigationRepository } from '../src/db/investigation-repository.js';
import { handleSubagentStop } from '../src/hooks/handlers/subagent-stop-handler.js';
import { projectId } from '../src/utils/project-id.js';
import type { HookDbClient } from '../src/hooks/shared/db-client.js';
import type { SubagentStopInput } from '../src/hooks/shared/hook-io.js';

let db: Database.Database;
let client: HookDbClient;

beforeEach(() => {
  db = openDatabase({ dbPath: ':memory:' });
  client = {
    db,
    memoryRepo: new MemoryRepository(db),
    planRepo: new PlanRepository(db),
    reminderRepo: new ReminderRepository(db),
    contextRepo: new ContextRepository(db),
    investigationRepo: new InvestigationRepository(db),
    close: () => db.close(),
  };
});

afterEach(() => db.close());

describe('GAP I — subagent-stop dedup against last note', () => {
  it('does not add duplicate notes when fired twice with same summary', () => {
    // The handler calls projectId(cwd) internally, so create the plan in
    // that computed project so getActive() inside the handler finds it.
    const realProject = projectId('/tmp');
    const { plan } = client.planRepo.create({
      project: realProject,
      name: 'Real test plan',
      steps: [{ description: 'Do the work' }],
    });
    client.planRepo.updateStep(plan.id, {
      step_id: plan.steps[0].step_id,
      status: 'in_progress',
    });

    const makeInput = (): SubagentStopInput => ({
      session_id: 's1',
      transcript_path: '/tmp/t',
      cwd: '/tmp',
      agent_type: 'Explore',
      last_assistant_message: 'Found the root cause of the bug in the connection handler and fixed it by adding a retry loop.',
    } as unknown as SubagentStopInput);

    const r1 = handleSubagentStop(makeInput(), client);
    const r2 = handleSubagentStop(makeInput(), client);

    assert.equal(r1.noted, true);
    assert.equal(r2.noted, false, 'second fire with identical summary is deduped');

    // Verify exactly one note on the step.
    const realProject2 = projectId('/tmp');
    const reloaded = client.planRepo.getActive(realProject2)!;
    const inProgress = reloaded.steps.find(s => s.status === 'in_progress')!;
    assert.equal(inProgress.notes.length, 1);
  });
});
