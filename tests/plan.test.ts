import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type Database from 'better-sqlite3';
import { openDatabase } from '../src/db/connection.js';
import { PlanRepository } from '../src/db/plan-repository.js';
import { MemoryRepository } from '../src/db/memory-repository.js';
import { TOKEN_BUDGET } from '../src/constants/index.js';

let db: Database.Database;
let planRepo: PlanRepository;
let memoryRepo: MemoryRepository;

beforeEach(() => {
  db = openDatabase({ dbPath: ':memory:' });
  planRepo = new PlanRepository(db);
  memoryRepo = new MemoryRepository(db);
});

afterEach(() => {
  db.close();
});

describe('PlanRepository — Create', () => {
  it('should create a plan with steps', () => {
    const { plan, warnings } = planRepo.create({
      project: 'proj-a',
      name: 'Refactor payment module',
      steps: [
        { description: 'Extract constants' },
        { description: 'Create service layer', depends_on: [1] },
        { description: 'Write tests', depends_on: [2] },
      ],
    });

    assert.ok(plan.id);
    assert.equal(plan.name, 'Refactor payment module');
    assert.equal(plan.status, 'active');
    assert.equal(plan.steps.length, 3);
    assert.equal(plan.steps[0].status, 'pending');
    assert.deepEqual(plan.steps[1].depends_on, [1]);
    assert.equal(warnings.length, 0);
  });

  it('should auto-archive existing active plan for same project', () => {
    planRepo.create({
      project: 'proj-a',
      name: 'Old plan',
      steps: [{ description: 'Step 1' }],
    });

    planRepo.create({
      project: 'proj-a',
      name: 'New plan',
      steps: [{ description: 'Step 1' }],
    });

    const plans = planRepo.listByProject('proj-a');
    const statuses = plans.map(p => p.status);
    assert.equal(statuses.filter(s => s === 'active').length, 1);
    assert.equal(statuses.filter(s => s === 'abandoned').length, 1);
  });

  it('should not affect plans in different projects', () => {
    planRepo.create({
      project: 'proj-a',
      name: 'Plan A',
      steps: [{ description: 'Step 1' }],
    });

    planRepo.create({
      project: 'proj-b',
      name: 'Plan B',
      steps: [{ description: 'Step 1' }],
    });

    const planA = planRepo.getActive('proj-a');
    const planB = planRepo.getActive('proj-b');
    assert.ok(planA);
    assert.ok(planB);
    assert.equal(planA.status, 'active');
    assert.equal(planB.status, 'active');
  });

  it('should error on empty steps', () => {
    assert.throws(() => {
      planRepo.create({
        project: 'proj-a',
        name: 'Empty plan',
        steps: [],
      });
    }, /at least one step/);
  });

  it('should warn when exceeding 15 steps', () => {
    const manySteps = Array.from({ length: 16 }, (_, i) => ({ description: `Step ${i + 1}` }));
    const { warnings } = planRepo.create({
      project: 'proj-a',
      name: 'Big plan',
      steps: manySteps,
    });
    assert.ok(warnings.some(w => w.includes('max recommended')));
  });
});

describe('PlanRepository — Step Updates', () => {
  let planId: string;

  beforeEach(() => {
    const { plan } = planRepo.create({
      project: 'proj-a',
      name: 'Test plan',
      steps: [
        { description: 'Step 1' },
        { description: 'Step 2', depends_on: [1] },
        { description: 'Step 3', depends_on: [2] },
      ],
    });
    planId = plan.id;
  });

  it('should update step status', () => {
    const { ok } = planRepo.updateStep(planId, { step_id: 1, status: 'in_progress' });
    assert.equal(ok, true);

    const plan = planRepo.getById(planId)!;
    assert.equal(plan.steps[0].status, 'in_progress');
  });

  it('should record step outcome', () => {
    planRepo.updateStep(planId, { step_id: 1, status: 'done', outcome: 'Extracted 47 constants' });

    const plan = planRepo.getById(planId)!;
    assert.equal(plan.steps[0].outcome, 'Extracted 47 constants');
  });

  it('should warn on dependency violations', () => {
    // Step 2 depends on Step 1, but Step 1 is still pending
    const { ok, warnings } = planRepo.updateStep(planId, { step_id: 2, status: 'in_progress' });
    assert.equal(ok, true); // Warning, not block
    assert.ok(warnings.some(w => w.includes('depends on incomplete')));
  });

  it('should not warn when dependencies are met', () => {
    planRepo.updateStep(planId, { step_id: 1, status: 'done' });
    const { warnings } = planRepo.updateStep(planId, { step_id: 2, status: 'in_progress' });
    assert.equal(warnings.filter(w => w.includes('depends on')).length, 0);
  });

  it('should return false for non-existent step', () => {
    const { ok } = planRepo.updateStep(planId, { step_id: 99, status: 'done' });
    assert.equal(ok, false);
  });
});

describe('PlanRepository — Decisions', () => {
  let planId: string;

  beforeEach(() => {
    const { plan } = planRepo.create({
      project: 'proj-a',
      name: 'Test plan',
      steps: [{ description: 'Step 1' }],
    });
    planId = plan.id;
  });

  it('should add a decision with alternatives', () => {
    const decision = planRepo.addDecision(planId, {
      step_id: 1,
      chose: 'Service layer',
      why: 'Better testability',
      alternatives: ['Fat models', 'Inline logic'],
      permanent: true,
    });

    assert.ok(decision.id);
    assert.equal(decision.chose, 'Service layer');
    assert.equal(decision.permanent, true);

    const plan = planRepo.getById(planId)!;
    assert.equal(plan.decisions.length, 1);
    assert.deepEqual(plan.decisions[0].alternatives, ['Fat models', 'Inline logic']);
  });

  it('should add plan-level decisions (null step_id)', () => {
    const decision = planRepo.addDecision(planId, {
      step_id: null,
      chose: 'SQLite',
      why: 'Single-user embedded',
    });
    assert.equal(decision.step_id, null);
  });

  it('should be append-only', () => {
    planRepo.addDecision(planId, { chose: 'A', why: 'Reason A' });
    planRepo.addDecision(planId, { chose: 'B', why: 'Reason B' });

    const plan = planRepo.getById(planId)!;
    assert.equal(plan.decisions.length, 2);
  });
});

describe('PlanRepository — Notes', () => {
  let planId: string;

  beforeEach(() => {
    const { plan } = planRepo.create({
      project: 'proj-a',
      name: 'Test plan',
      steps: [{ description: 'Extract handlers' }],
    });
    planId = plan.id;
  });

  it('should append notes to a step', () => {
    planRepo.addNote(planId, { step_id: 1, note: '2/5 handlers done' });
    planRepo.addNote(planId, { step_id: 1, note: '4/5 handlers done' });

    const plan = planRepo.getById(planId)!;
    assert.equal(plan.steps[0].notes.length, 2);
    assert.equal(plan.steps[0].notes[1].note, '4/5 handlers done');
  });

  it('should replace notes when replace=true', () => {
    planRepo.addNote(planId, { step_id: 1, note: 'Old note' });
    planRepo.addNote(planId, { step_id: 1, note: 'New note only', replace: true });

    const plan = planRepo.getById(planId)!;
    assert.equal(plan.steps[0].notes.length, 1);
    assert.equal(plan.steps[0].notes[0].note, 'New note only');
  });

  it('should reject notes exceeding NOTE_MAX_CHARS', () => {
    const longNote = 'x'.repeat(TOKEN_BUDGET.NOTE_MAX_CHARS + 1);
    const { ok, warnings } = planRepo.addNote(planId, { step_id: 1, note: longNote });
    assert.equal(ok, false);
    assert.ok(warnings.some(w => w.includes('max')));
  });

  it('should accept notes exactly at NOTE_MAX_CHARS', () => {
    const edgeNote = 'x'.repeat(TOKEN_BUDGET.NOTE_MAX_CHARS);
    const { ok } = planRepo.addNote(planId, { step_id: 1, note: edgeNote });
    assert.equal(ok, true);
  });

  it('should reject empty notes', () => {
    const { ok } = planRepo.addNote(planId, { step_id: 1, note: '' });
    assert.equal(ok, false);
  });
});

describe('PlanRepository — Complete & Decision Graduation', () => {
  it('should complete plan and return permanent decisions', () => {
    const { plan } = planRepo.create({
      project: 'proj-a',
      name: 'Graduation test',
      steps: [{ description: 'Step 1' }],
    });

    planRepo.addDecision(plan.id, {
      chose: 'Service layer',
      why: 'Testability',
      permanent: true,
    });
    planRepo.addDecision(plan.id, {
      chose: 'Process order: A then B',
      why: 'Fewer deps',
      permanent: false,
    });

    const graduated = planRepo.complete(plan.id);
    assert.equal(graduated.length, 1);
    assert.equal(graduated[0].chose, 'Service layer');

    const completed = planRepo.getById(plan.id)!;
    assert.equal(completed.status, 'completed');
  });

  it('graduation should create memories from permanent decisions', () => {
    const { plan } = planRepo.create({
      project: 'proj-a',
      name: 'Graduation test',
      steps: [{ description: 'Step 1' }],
    });

    planRepo.addDecision(plan.id, {
      chose: 'Service layer pattern',
      why: 'Better testability and separation',
      permanent: true,
    });

    const graduated = planRepo.complete(plan.id);
    for (const d of graduated) {
      memoryRepo.create({
        content: `${d.chose} — ${d.why}`,
        kind: 'decision',
        project: 'proj-a',
      });
    }

    const count = memoryRepo.countByProject('proj-a');
    assert.ok(count >= 1);
  });
});

describe('PlanRepository — Filtered Retrieval', () => {
  beforeEach(() => {
    const { plan } = planRepo.create({
      project: 'proj-a',
      name: 'Filter test',
      steps: [
        { description: 'Step 1' },
        { description: 'Step 2', depends_on: [1] },
        { description: 'Step 3', depends_on: [2] },
      ],
    });
    planRepo.updateStep(plan.id, { step_id: 1, status: 'done', outcome: 'Done' });
    planRepo.updateStep(plan.id, { step_id: 2, status: 'in_progress' });
    planRepo.addDecision(plan.id, { chose: 'X', why: 'Y' });
  });

  it('should return full plan with filter=full', () => {
    const plan = planRepo.getFiltered('proj-a', 'full')!;
    assert.equal(plan.steps.length, 3);
    assert.equal(plan.decisions.length, 1);
  });

  it('should return only active steps with filter=active', () => {
    const plan = planRepo.getFiltered('proj-a', 'active')!;
    // Step 1 is done, should be filtered out
    assert.ok(plan.steps.every(s => s.status !== 'done'));
    assert.ok(plan.steps.length < 3);
  });

  it('should return current + next with filter=current', () => {
    const plan = planRepo.getFiltered('proj-a', 'current')!;
    assert.ok(plan.steps.length <= 2);
    assert.ok(plan.steps.some(s => s.status === 'in_progress'));
  });

  it('should return only decisions with filter=decisions', () => {
    const plan = planRepo.getFiltered('proj-a', 'decisions')!;
    assert.equal(plan.steps.length, 0);
    assert.ok(plan.decisions.length > 0);
  });
});

describe('PlanRepository — List & Block', () => {
  it('should list plans with active first', () => {
    planRepo.create({ project: 'proj-a', name: 'Old', steps: [{ description: 'S' }] });
    planRepo.create({ project: 'proj-a', name: 'New', steps: [{ description: 'S' }] });

    const plans = planRepo.listByProject('proj-a');
    assert.equal(plans[0].status, 'active');
    assert.equal(plans[0].name, 'New');
  });

  it('should block in-progress steps on session end', () => {
    const { plan } = planRepo.create({
      project: 'proj-a',
      name: 'Block test',
      steps: [{ description: 'Working on it' }],
    });
    planRepo.updateStep(plan.id, { step_id: 1, status: 'in_progress' });

    const count = planRepo.blockInProgressSteps('proj-a', 'Session ended');
    assert.equal(count, 1);

    const updated = planRepo.getById(plan.id)!;
    assert.equal(updated.steps[0].status, 'blocked');
    assert.equal(updated.steps[0].blockers, 'Session ended');
  });

  it('should return 0 when no in-progress steps', () => {
    planRepo.create({
      project: 'proj-a',
      name: 'No IP',
      steps: [{ description: 'Pending step' }],
    });
    const count = planRepo.blockInProgressSteps('proj-a', 'Session ended');
    assert.equal(count, 0);
  });
});

describe('PlanRepository — Add Step Mid-Plan', () => {
  it('should add a step with next sequential ID', () => {
    const { plan } = planRepo.create({
      project: 'proj-a',
      name: 'Extend test',
      steps: [{ description: 'Original step' }],
    });

    const { step, warnings } = planRepo.addStep(plan.id, 'New step', [1]);
    assert.equal(step.step_id, 2);
    assert.deepEqual(step.depends_on, [1]);
    assert.equal(warnings.length, 0);

    const updated = planRepo.getById(plan.id)!;
    assert.equal(updated.steps.length, 2);
  });
});
