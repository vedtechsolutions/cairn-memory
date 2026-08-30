import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// --- Transcript Parser: Bookend Read & Goal Extraction ---

// We import the public API and test via file-based integration
import { parseTranscript, isMetaGoal, isApproachNote, isLikelyErrorOutput } from '../src/hooks/shared/transcript-parser.js';

function makeTempTranscript(lines: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'cairn-test-'));
  const path = join(dir, 'transcript.jsonl');
  writeFileSync(path, lines.join('\n') + '\n');
  return path;
}

function userEntry(text: string) {
  return JSON.stringify({ type: 'user', message: { role: 'user', content: text } });
}

function assistantEntry(text: string) {
  return JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  });
}

describe('Goal Extraction', () => {
  it('should extract first substantive non-meta user message as goal', () => {
    const path = makeTempTranscript([
      userEntry('implement the new authentication system for the API'),
      assistantEntry('I will implement the auth system.'),
      userEntry('proceed'),
    ]);
    const snap = parseTranscript(path);
    // distillGoal capitalizes first letter
    assert.equal(snap.initialGoal, 'Implement the new authentication system for the API');
    unlinkSync(path);
  });

  it('should skip meta-goals and pick the first real goal', () => {
    const path = makeTempTranscript([
      userEntry('compact was completed please do the analysis'),
      userEntry('implement all 8 improvement ideas for cairn memory'),
      assistantEntry('Starting implementation.'),
    ]);
    const snap = parseTranscript(path);
    assert.equal(snap.initialGoal, 'Implement all 8 improvement ideas for cairn memory');
    unlinkSync(path);
  });

  it('should return null when all user messages are meta', () => {
    const path = makeTempTranscript([
      userEntry('proceed with the changes'),
      userEntry('go ahead and continue'),
      assistantEntry('Done.'),
    ]);
    const snap = parseTranscript(path);
    assert.equal(snap.initialGoal, null);
    unlinkSync(path);
  });

  it('should skip short messages (<= 20 chars)', () => {
    const path = makeTempTranscript([
      userEntry('yes'),
      userEntry('ok do it'),
      userEntry('refactor the database connection pooling module for better performance'),
      assistantEntry('Working on it.'),
    ]);
    const snap = parseTranscript(path);
    assert.equal(snap.initialGoal, 'Refactor the database connection pooling module for better performance');
    unlinkSync(path);
  });

  it('should filter continuation summaries from goal extraction', () => {
    const path = makeTempTranscript([
      userEntry('This session is being continued from a previous conversation that ran out of context.'),
      userEntry('add error handling to the payment processing module'),
      assistantEntry('Adding error handling.'),
    ]);
    const snap = parseTranscript(path);
    assert.equal(snap.initialGoal, 'Add error handling to the payment processing module');
    unlinkSync(path);
  });

  it('should filter skill expansion content from goal extraction', () => {
    // Simulates: user invokes /plugin-dev:plugin-structure → two user entries
    const commandEntry = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: '<command-message>plugin-dev:plugin-structure</command-message>\n<command-name>/plugin-dev:plugin-structure</command-name>' },
    });
    const skillExpansion = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'Base directory for this skill: /root/.claude/plugins/cache/plugin-dev/skills/plugin-structure\n\n# Plugin Structure for Claude Code\n\nClaude Code plugins follow a standardized directory structure...' }] },
    });
    const path = makeTempTranscript([
      commandEntry,
      skillExpansion,
      userEntry('i want you to review cairn and fix the goal extraction bug'),
      assistantEntry('Starting review.'),
    ]);
    const snap = parseTranscript(path);
    // distillGoal strips "i want you to" prefix and capitalizes
    assert.ok(snap.initialGoal?.toLowerCase().includes('review cairn'), `goal should contain "review cairn": ${snap.initialGoal}`);
    unlinkSync(path);
  });
});

describe('isMetaGoal', () => {
  it('should detect compact-related messages', () => {
    assert.ok(isMetaGoal('compact was completed please do the analysis'));
  });

  it('should detect proceed messages', () => {
    assert.ok(isMetaGoal('proceed with the recommended implementation'));
  });

  it('should detect continue messages', () => {
    assert.ok(isMetaGoal('continue where we left off please'));
  });

  it('should detect short messages as meta', () => {
    assert.ok(isMetaGoal('yes'));
    assert.ok(isMetaGoal('ok'));
    assert.ok(isMetaGoal('do it'));
  });

  it('should NOT flag real task descriptions', () => {
    assert.ok(!isMetaGoal('implement all 8 improvement ideas for cairn memory'));
    assert.ok(!isMetaGoal('refactor the database connection pooling module'));
    assert.ok(!isMetaGoal('add error handling to the payment processing module'));
  });

  it('should NOT flag long messages with incidental meta keywords', () => {
    // "proceed with t4 and do not commit..." is a real task instruction
    assert.ok(!isMetaGoal('proceed with t4 and do not commit until i tell you to also you need to validate your implementation'));
    assert.ok(!isMetaGoal('continue with the database migration and ensure all foreign keys are properly indexed and tested'));
    assert.ok(!isMetaGoal('go ahead and implement the full authentication flow with OAuth2 support and refresh token rotation'));
  });

  it('should still flag short messages with meta keywords', () => {
    assert.ok(isMetaGoal('proceed with the recommended approach'));
    assert.ok(isMetaGoal('continue where we left off'));
    assert.ok(isMetaGoal('go ahead and do it'));
    assert.ok(isMetaGoal('yes please do it'));
  });

  it('should reject synthetic stop/interrupt notices injected as user messages', () => {
    // Real case observed in post-compaction briefing: Claude Code injects a
    // plain-text system notice as a user-role message when the user stops a
    // run. It passes isHumanMessage (no XML tag) so only isMetaGoal can filter.
    assert.ok(isMetaGoal('The user stopped the ultraplan session above. Do not respond to the stop notification — wait for the next message'));
    assert.ok(isMetaGoal('the user interrupted the previous run — wait for further instruction'));
    assert.ok(isMetaGoal('The user cancelled the session above. Do not respond until prompted.'));
    assert.ok(isMetaGoal('[Request interrupted by user — wait for next instruction]'));
  });

  it('should reject self-directed "do not respond" / "wait for user" patterns', () => {
    assert.ok(isMetaGoal('Do not respond to this message and wait for the user prompt to continue'));
    assert.ok(isMetaGoal('please wait for the user next message before responding to anything'));
  });

  it('should NOT flag a real task that happens to mention "stopped"', () => {
    // False-positive guard — real task description with "stopped" as content.
    assert.ok(!isMetaGoal('investigate why the worker stopped processing queue messages after deploy'));
    assert.ok(!isMetaGoal('fix the crash that occurred after the user pressed the stop button in the UI'));
  });
});

// --- Approach Note Filter (imported from transcript-parser.ts) ---

describe('Approach Note Filter', () => {
  it('should accept text with both approach + reasoning signals', () => {
    const text = 'The approach for this module uses a factory pattern because it provides better testability and separation of concerns across the application layers.';
    assert.ok(isApproachNote(text));
  });

  it('should reject short texts with only approach signal (no reasoning)', () => {
    const text = 'The approach uses a factory pattern to create instances and then processes each one sequentially through the pipeline.';
    assert.ok(!isApproachNote(text)); // Has approach but no reasoning, <200 chars
  });

  it('should accept longer texts (>=200 chars) with only approach signal', () => {
    const text = 'The approach uses a factory pattern to create instances. First we initialize the config, then we build the service graph, next we wire up event handlers, and finally we start the main processing loop for all incoming requests through the pipeline system.';
    assert.ok(text.length >= 200);
    assert.ok(isApproachNote(text));
  });

  it('should accept longer texts (>=200 chars) with only reasoning signal', () => {
    const text = 'We need to change the data flow in this module because the current implementation creates a circular dependency between the notification service and the event bus. The trade-off is that we lose some immediate consistency but gain much better fault tolerance and system reliability overall.';
    assert.ok(text.length >= 200);
    assert.ok(isApproachNote(text));
  });

  it('should reject conversational starters', () => {
    const text = "Here's the implementation of the factory pattern approach because it provides better testability and uses dependency injection for all service components.";
    assert.ok(!isApproachNote(text));
  });

  it('should reject status updates with test counts', () => {
    const text = 'All 366 tests pass after the refactoring. The approach was to use the factory pattern because it provides better testability. The build is clean and ready.';
    assert.ok(!isApproachNote(text));
  });

  it('should reject texts shorter than 80 chars', () => {
    const text = 'The approach uses factories because of testability concerns.';
    assert.ok(!isApproachNote(text));
  });
});

// --- Git Working State ---

import { getGitWorkingState } from '../src/utils/project-scanner.js';
import { gitSpawnSkipReason } from './spawn-probe.js';

describe('Git Working State', () => {
  it('should return branch, uncommitted, and unpushed counts for a real repo', (t) => {
    const skip = gitSpawnSkipReason();
    if (skip) return t.skip(skip);
    const state = getGitWorkingState(process.cwd());
    assert.ok(state !== null, 'should return state for a git repo');
    assert.ok(typeof state.branch === 'string');
    assert.ok(state.branch.length > 0);
    assert.ok(typeof state.uncommittedCount === 'number');
    assert.ok(state.uncommittedCount >= 0);
    assert.ok(typeof state.unpushedCount === 'number');
    assert.ok(state.unpushedCount >= 0);
  });

  it('should return null for a non-git directory', () => {
    const state = getGitWorkingState('/tmp');
    assert.equal(state, null);
  });
});

// --- Briefing Compiler: Git State Rendering ---

import { compileBriefing, computeEffectiveness, recoverDroppedPitfalls, type BriefingContext } from '../src/hooks/shared/briefing-compiler.js';
import { openDatabase } from '../src/db/connection.js';
import { MemoryRepository } from '../src/db/memory-repository.js';
import { PlanRepository } from '../src/db/plan-repository.js';
import type { Memory } from '../src/db/memory-repository.js';

describe('Briefing Git State Rendering', () => {
  it('should include git state line when gitState is provided', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    const memRepo = new MemoryRepository(db);
    const planRepo = new PlanRepository(db);
    const ctx: BriefingContext = {
      project: 'test-project',
      sessionType: 'compact',
      interrupted: false,
      gitState: { branch: 'feat/my-branch', uncommittedCount: 5, unpushedCount: 2 },
    };
    const result = compileBriefing(memRepo, planRepo, ctx);
    assert.ok(result.text.includes('Git: branch: feat/my-branch, 5 uncommitted files, 2 unpushed commits'));
    db.close();
  });

  it('should omit git line when gitState is null', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    const memRepo = new MemoryRepository(db);
    const planRepo = new PlanRepository(db);
    const ctx: BriefingContext = {
      project: 'test-project',
      sessionType: 'compact',
      interrupted: false,
      gitState: null,
    };
    const result = compileBriefing(memRepo, planRepo, ctx);
    assert.ok(!result.text.includes('Git:'));
    db.close();
  });

  it('should omit counts that are zero', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    const memRepo = new MemoryRepository(db);
    const planRepo = new PlanRepository(db);
    const ctx: BriefingContext = {
      project: 'test-project',
      sessionType: 'startup',
      interrupted: false,
      gitState: { branch: 'main', uncommittedCount: 0, unpushedCount: 0 },
    };
    const result = compileBriefing(memRepo, planRepo, ctx);
    assert.ok(result.text.includes('Git: branch: main'));
    assert.ok(!result.text.includes('uncommitted'));
    assert.ok(!result.text.includes('unpushed'));
    db.close();
  });
});

// --- Impact-Proportional Token Allocation (TurboQuant Feature #3) ---

function makeMemory(overrides: Partial<Memory>): Memory {
  return {
    id: 'test-id',
    revision: 1,
    author: null,
    content: 'test pitfall content',
    kind: 'pitfall',
    project: 'test-project',
    tags: [],
    confidence: 0.65,
    source: 'learned',
    created_at: new Date().toISOString(),
    last_recalled: null,
    recall_count: 0,
    invalidated: 0,
    surface_count: 0,
    impact_count: 0,
    fingerprint: null,
    context: null,
    anchor: null,
    ...overrides,
  };
}

describe('computeEffectiveness', () => {
  it('should use graduated fallback for never-surfaced memories', () => {
    // High confidence (>=0.55): uses 0.5 multiplier (benefit of the doubt)
    const highConf = makeMemory({ confidence: 0.8, surface_count: 0, impact_count: 0 });
    const highEff = computeEffectiveness(highConf);
    assert.ok(Math.abs(highEff - 0.40) < 0.001, `expected ~0.40, got ${highEff}`);

    // Low confidence (<0.55): uses 0.3 multiplier (conservative)
    const lowConf = makeMemory({ confidence: 0.4, surface_count: 0, impact_count: 0 });
    const lowEff = computeEffectiveness(lowConf);
    assert.ok(Math.abs(lowEff - 0.12) < 0.001, `expected ~0.12, got ${lowEff}`);
  });

  it('should return high score for high conversion rate', () => {
    const mem = makeMemory({ confidence: 0.7, surface_count: 5, impact_count: 4 });
    const eff = computeEffectiveness(mem);
    // conversionRate = 4/5 = 0.8; eff = 0.8*0.7 + 0.7*0.3 = 0.56 + 0.21 = 0.77
    assert.ok(eff > 0.7, `expected > 0.7, got ${eff}`);
  });

  it('should return low score for zero impact despite high surfaces', () => {
    const mem = makeMemory({ confidence: 0.3, surface_count: 10, impact_count: 0 });
    const eff = computeEffectiveness(mem);
    // conversionRate = 0; eff = 0*0.7 + 0.3*0.3 = 0.09
    assert.ok(eff < 0.1, `expected < 0.1, got ${eff}`);
  });

  it('should cap conversion rate at 1.0', () => {
    const mem = makeMemory({ confidence: 0.65, surface_count: 2, impact_count: 5 });
    const eff = computeEffectiveness(mem);
    // conversionRate = min(1.0, 5/2) = 1.0; eff = 1.0*0.7 + 0.65*0.3 = 0.895
    assert.ok(eff > 0.85, `expected > 0.85, got ${eff}`);
  });

  it('should produce medium score for moderate conversion', () => {
    const mem = makeMemory({ confidence: 0.5, surface_count: 10, impact_count: 2 });
    const eff = computeEffectiveness(mem);
    // conversionRate = 0.2; eff = 0.2*0.7 + 0.5*0.3 = 0.14 + 0.15 = 0.29
    assert.ok(eff >= 0.1 && eff < 0.5, `expected medium range, got ${eff}`);
  });
});

describe('Impact-Proportional Pitfall Rendering', () => {
  it('should render high-effectiveness pitfalls with how_to_apply', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    const memRepo = new MemoryRepository(db);
    const planRepo = new PlanRepository(db);

    // Create a high-impact pitfall
    memRepo.create({
      content: 'Always check schema before ALTER TABLE',
      kind: 'pitfall',
      project: 'test-proj',
      context: { why: 'Migrations fail silently', how_to_apply: 'Run .schema first' },
    });
    // Simulate high surface + impact (high effectiveness)
    const rows = db.prepare("SELECT id FROM memories WHERE kind = 'pitfall'").all() as Array<{ id: string }>;
    db.prepare('UPDATE memories SET surface_count = 10, impact_count = 8 WHERE id = ?').run(rows[0].id);

    const ctx: BriefingContext = { project: 'test-proj', sessionType: 'startup', interrupted: false };
    const result = compileBriefing(memRepo, planRepo, ctx);
    assert.ok(result.text.includes('→ Run .schema first'), 'high-effectiveness pitfall should include how_to_apply');
    assert.ok(result.text.includes('Why: Migrations fail silently'), 'should include why');
    db.close();
  });

  it('should exclude low-effectiveness pitfalls from briefing entirely', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    const memRepo = new MemoryRepository(db);
    const planRepo = new PlanRepository(db);

    // Create a low-impact pitfall (surfaced many times, never helped)
    memRepo.create({
      content: 'This is a very long pitfall that has been surfaced many times but never had any real measurable impact on outcomes',
      kind: 'pitfall',
      project: 'test-proj',
      confidence: 0.3,
      context: { why: 'Some reason that should be omitted' },
    });
    const rows = db.prepare("SELECT id FROM memories WHERE kind = 'pitfall'").all() as Array<{ id: string }>;
    db.prepare('UPDATE memories SET surface_count = 15, impact_count = 0 WHERE id = ?').run(rows[0].id);

    const ctx: BriefingContext = { project: 'test-proj', sessionType: 'startup', interrupted: false };
    const result = compileBriefing(memRepo, planRepo, ctx);
    assert.ok(!result.text.includes('Some reason that should be omitted'), 'low-effectiveness should not appear');
    assert.ok(!result.text.includes('very long pitfall'), 'low-effectiveness pitfall should be excluded entirely');
    assert.ok(!result.text.includes('Pitfalls:'), 'pitfalls header should not appear when all are excluded');
    db.close();
  });

  it('should return includedPitfallIds in output', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    const memRepo = new MemoryRepository(db);
    const planRepo = new PlanRepository(db);

    memRepo.create({ content: 'Never use raw SQL in production database models', kind: 'pitfall', project: 'test-proj' });
    memRepo.create({ content: 'Always validate OAuth tokens before granting access', kind: 'pitfall', project: 'test-proj' });

    const ctx: BriefingContext = { project: 'test-proj', sessionType: 'startup', interrupted: false };
    const result = compileBriefing(memRepo, planRepo, ctx);
    assert.equal(result.includedPitfallIds.length, 2);
    assert.ok(result.includedPitfallIds.every(id => typeof id === 'string' && id.length > 0));
    db.close();
  });
});

// --- Two-Stage Briefing Correction Pass (TurboQuant Feature #2) ---

describe('Correction Pass (recoverDroppedPitfalls)', () => {
  it('should recover high-impact pitfalls not in included set', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    const memRepo = new MemoryRepository(db);

    // Create two pitfalls: one included, one dropped but high-impact
    const included = memRepo.create({ content: 'Included pitfall', kind: 'pitfall', project: 'test-proj' });
    const dropped = memRepo.create({ content: 'Critical dropped pitfall', kind: 'pitfall', project: 'test-proj' });
    db.prepare('UPDATE memories SET impact_count = 5, surface_count = 8 WHERE id = ?').run(dropped.id);

    const recovered = recoverDroppedPitfalls(memRepo, 'test-proj', [included.id], 200);
    assert.ok(recovered !== null, 'should recover dropped high-impact pitfall');
    assert.ok(recovered!.includes('[!]'), 'should use [!] marker');
    assert.ok(recovered!.includes('Critical dropped pitfall'), 'should contain dropped pitfall content');
    db.close();
  });

  it('should return null when no high-impact pitfalls were dropped', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    const memRepo = new MemoryRepository(db);

    memRepo.create({ content: 'Low impact pitfall', kind: 'pitfall', project: 'test-proj' });
    // impact_count = 0 (default), below threshold of 2

    const recovered = recoverDroppedPitfalls(memRepo, 'test-proj', [], 200);
    assert.equal(recovered, null);
    db.close();
  });

  it('should return null when budget is too small', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    const memRepo = new MemoryRepository(db);

    const dropped = memRepo.create({ content: 'High impact', kind: 'pitfall', project: 'test-proj' });
    db.prepare('UPDATE memories SET impact_count = 5 WHERE id = ?').run(dropped.id);

    const recovered = recoverDroppedPitfalls(memRepo, 'test-proj', [], 5); // too small
    assert.equal(recovered, null);
    db.close();
  });

  it('should not recover pitfalls already in included set', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    const memRepo = new MemoryRepository(db);

    const p1 = memRepo.create({ content: 'Already included', kind: 'pitfall', project: 'test-proj' });
    db.prepare('UPDATE memories SET impact_count = 10 WHERE id = ?').run(p1.id);

    const recovered = recoverDroppedPitfalls(memRepo, 'test-proj', [p1.id], 200);
    assert.equal(recovered, null, 'should not recover already-included pitfall');
    db.close();
  });

  it('should truncate recovered pitfall content', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    const memRepo = new MemoryRepository(db);

    const longContent = 'A'.repeat(200); // way longer than CORRECTION_PASS_MAX_CHARS (60)
    const dropped = memRepo.create({ content: longContent, kind: 'pitfall', project: 'test-proj' });
    db.prepare('UPDATE memories SET impact_count = 3 WHERE id = ?').run(dropped.id);

    const recovered = recoverDroppedPitfalls(memRepo, 'test-proj', [], 200);
    assert.ok(recovered !== null);
    assert.ok(recovered!.includes('…'), 'should truncate long content');
    assert.ok(recovered!.length < 100, 'recovered line should be compact');
    db.close();
  });

  it('should limit to CORRECTION_PASS_MAX_ITEMS (2)', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    const memRepo = new MemoryRepository(db);

    // Create 4 high-impact pitfalls
    for (let i = 0; i < 4; i++) {
      const p = memRepo.create({ content: `High impact pitfall ${i}`, kind: 'pitfall', project: 'test-proj' });
      db.prepare('UPDATE memories SET impact_count = ? WHERE id = ?').run(10 - i, p.id);
    }

    const recovered = recoverDroppedPitfalls(memRepo, 'test-proj', [], 500);
    assert.ok(recovered !== null);
    const lines = recovered!.split('\n').filter(l => l.includes('[!]'));
    assert.ok(lines.length <= 2, `should recover at most 2 items, got ${lines.length}`);
    db.close();
  });

  // --- Phase 6a.3: cross-project guard in the correction pass ---

  it('blocks null-project globals with mismatched fingerprint when queryFp provided', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    const memRepo = new MemoryRepository(db);

    const odooPitfall = memRepo.create({
      content: 'Odoo 19 kanban templates do not have kanban_image() function',
      kind: 'pitfall',
      project: null,
      fingerprint: { lang: ['xml', 'python'], framework: ['odoo'], module: ['kanban', 'views'] },
    });
    db.prepare('UPDATE memories SET impact_count = 14 WHERE id = ?').run(odooPitfall.id);

    const tsCairnQueryFp = { lang: ['typescript'], framework: ['node', 'better-sqlite3'], module: [] };
    const recovered = recoverDroppedPitfalls(memRepo, 'cairn-test', [], 500, tsCairnQueryFp);
    assert.equal(recovered, null, 'Odoo global should not leak into cairn briefing via correction pass');
    db.close();
  });

  it('still recovers same-project high-impact pitfalls when queryFp provided', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    const memRepo = new MemoryRepository(db);

    const localPitfall = memRepo.create({
      content: 'Cairn-specific high-impact pitfall',
      kind: 'pitfall',
      project: 'cairn-test',
    });
    db.prepare('UPDATE memories SET impact_count = 5 WHERE id = ?').run(localPitfall.id);

    const tsCairnQueryFp = { lang: ['typescript'], framework: ['node'], module: [] };
    const recovered = recoverDroppedPitfalls(memRepo, 'cairn-test', [], 500, tsCairnQueryFp);
    assert.ok(recovered !== null, 'same-project pitfall should still be recovered');
    assert.ok(recovered!.includes('Cairn-specific high-impact pitfall'));
    db.close();
  });

  it('allows cross-project globals with matching fingerprint', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    const memRepo = new MemoryRepository(db);

    const tsGlobal = memRepo.create({
      content: 'Always check null before dereferencing in TypeScript',
      kind: 'pitfall',
      project: null,
      fingerprint: { lang: ['typescript'], framework: ['node'], module: [] },
    });
    db.prepare('UPDATE memories SET impact_count = 8 WHERE id = ?').run(tsGlobal.id);

    const tsCairnQueryFp = { lang: ['typescript'], framework: ['node'], module: [] };
    const recovered = recoverDroppedPitfalls(memRepo, 'cairn-test', [], 500, tsCairnQueryFp);
    assert.ok(recovered !== null, 'lang-matching global should pass cross-project guard');
    assert.ok(recovered!.includes('null before dereferencing'));
    db.close();
  });

  it('preserves legacy behavior when queryFp omitted (backwards compat)', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    const memRepo = new MemoryRepository(db);

    const dropped = memRepo.create({ content: 'Legacy', kind: 'pitfall', project: 'test-proj' });
    db.prepare('UPDATE memories SET impact_count = 5 WHERE id = ?').run(dropped.id);

    const recovered = recoverDroppedPitfalls(memRepo, 'test-proj', [], 500);
    assert.ok(recovered !== null);
    assert.ok(recovered!.includes('Legacy'));
    db.close();
  });

  // --- SNR v3 Commit 5 audit: quality-floor parity with main pass ---

  it('does NOT re-admit pitfalls below LOW_EFFECTIVENESS_THRESHOLD (0.25)', () => {
    // A pitfall with impact=10, surface=100, conf=0.5 has:
    //   conversionRate = 10/100 = 0.1
    //   effectiveness  = 0.1 * 0.7 + 0.5 * 0.3 = 0.07 + 0.15 = 0.22  → below 0.25
    // Pre-Commit-5 recovery would have surfaced it anyway (sorted by
    // impact_count DESC). Post-audit, effectiveness gate drops it so
    // recovery can't undo main's effectiveness filtering.
    const db = openDatabase({ dbPath: ':memory:' });
    const memRepo = new MemoryRepository(db);

    const lowEff = memRepo.create({
      content: 'Low-effectiveness but high-impact-count pitfall',
      kind: 'pitfall',
      project: 'test-proj',
      confidence: 0.5,
    });
    db.prepare('UPDATE memories SET impact_count = 10, surface_count = 100 WHERE id = ?')
      .run(lowEff.id);

    const recovered = recoverDroppedPitfalls(memRepo, 'test-proj', [], 500);
    assert.equal(
      recovered,
      null,
      'pitfall with effectiveness 0.22 must be blocked by the audit gate',
    );
    db.close();
  });

  it('does NOT re-admit pitfalls below CORRECTION_PASS_MIN_CONFIDENCE (0.5)', () => {
    // A pitfall with impact=5, surface=5, conf=0.3 has strong conversion
    // but low confidence. The audit enforces CORRECTION_PASS_MIN_CONFIDENCE
    // which was previously a dead constant.
    const db = openDatabase({ dbPath: ':memory:' });
    const memRepo = new MemoryRepository(db);

    const lowConf = memRepo.create({
      content: 'High-conversion but low-confidence pitfall',
      kind: 'pitfall',
      project: 'test-proj',
      confidence: 0.3,
    });
    db.prepare('UPDATE memories SET impact_count = 5, surface_count = 5 WHERE id = ?')
      .run(lowConf.id);

    const recovered = recoverDroppedPitfalls(memRepo, 'test-proj', [], 500);
    assert.equal(
      recovered,
      null,
      'pitfall with confidence 0.3 must be blocked by the CORRECTION_PASS_MIN_CONFIDENCE gate',
    );
    db.close();
  });

  it('DOES recover pitfalls that clear both gates', () => {
    // Sanity: a pitfall with high effectiveness AND high confidence should
    // still surface — the audit doesn't over-tighten.
    const db = openDatabase({ dbPath: ':memory:' });
    const memRepo = new MemoryRepository(db);

    const healthy = memRepo.create({
      content: 'High-quality pitfall worth recovering',
      kind: 'pitfall',
      project: 'test-proj',
      confidence: 0.7,
    });
    db.prepare('UPDATE memories SET impact_count = 5, surface_count = 6 WHERE id = ?')
      .run(healthy.id);

    const recovered = recoverDroppedPitfalls(memRepo, 'test-proj', [], 500);
    assert.ok(recovered !== null, 'healthy pitfall must still be recovered');
    assert.ok(recovered!.includes('High-quality pitfall worth recovering'));
    db.close();
  });
});

// --- highImpactPitfalls Repository Method ---

describe('MemoryRepository.highImpactPitfalls', () => {
  it('should exclude specified IDs', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    const memRepo = new MemoryRepository(db);

    const p1 = memRepo.create({ content: 'Never use raw SQL queries in production models', kind: 'pitfall', project: 'tp' });
    const p2 = memRepo.create({ content: 'Always validate OAuth tokens before granting access', kind: 'pitfall', project: 'tp' });
    db.prepare('UPDATE memories SET impact_count = 5 WHERE id = ?').run(p1.id);
    db.prepare('UPDATE memories SET impact_count = 5 WHERE id = ?').run(p2.id);

    const results = memRepo.highImpactPitfalls('tp', [p1.id], 2, 10);
    assert.equal(results.length, 1);
    assert.equal(results[0].id, p2.id);
    db.close();
  });

  it('should order by impact_count descending', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    const memRepo = new MemoryRepository(db);

    const p1 = memRepo.create({ content: 'Never use raw SQL queries in production models', kind: 'pitfall', project: 'tp' });
    const p2 = memRepo.create({ content: 'Always validate OAuth tokens before granting access', kind: 'pitfall', project: 'tp' });
    db.prepare('UPDATE memories SET impact_count = 2 WHERE id = ?').run(p1.id);
    db.prepare('UPDATE memories SET impact_count = 10 WHERE id = ?').run(p2.id);

    const results = memRepo.highImpactPitfalls('tp', [], 2, 10);
    assert.equal(results[0].id, p2.id, 'highest impact should come first');
    db.close();
  });

  it('should filter by minImpact threshold', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    const memRepo = new MemoryRepository(db);

    const p1 = memRepo.create({ content: 'Check database schema before running migrations', kind: 'pitfall', project: 'tp' });
    const p2 = memRepo.create({ content: 'Always validate OAuth tokens before granting access', kind: 'pitfall', project: 'tp' });
    db.prepare('UPDATE memories SET impact_count = 1 WHERE id = ?').run(p1.id);
    db.prepare('UPDATE memories SET impact_count = 5 WHERE id = ?').run(p2.id);

    const results = memRepo.highImpactPitfalls('tp', [], 3, 10);
    assert.equal(results.length, 1);
    assert.equal(results[0].id, p2.id);
    db.close();
  });
});

// --- Approach Quality Gate ---

describe('Approach Quality Gate', () => {
  it('should exclude conversational approach notes from compact briefing', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    const memRepo = new MemoryRepository(db);
    const planRepo = new PlanRepository(db);
    const ctx: BriefingContext = {
      project: 'test-proj',
      sessionType: 'compact',
      interrupted: false,
      compactionSnapshot: {
        recentFiles: [],
        recentReadFiles: [],
        recentCommands: [],
        userContext: ['implement the auth system'],
        approachNotes: ['Good point on that — the current approach is correct. Let me keep going with the implementation as planned and fix the edge cases one by one.'],
        initialGoal: 'implement auth',
        recentDecisions: [],
      },
    };
    const result = compileBriefing(memRepo, planRepo, ctx);
    assert.ok(!result.text.includes('Approach:'), 'conversational approach should be excluded');
    db.close();
  });

  it('should include strategic approach notes in compact briefing', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    const memRepo = new MemoryRepository(db);
    const planRepo = new PlanRepository(db);
    const ctx: BriefingContext = {
      project: 'test-proj',
      sessionType: 'compact',
      interrupted: false,
      compactionSnapshot: {
        recentFiles: [],
        recentReadFiles: [],
        recentCommands: [],
        userContext: ['implement the auth system'],
        approachNotes: ['Using JWT tokens with refresh rotation for the auth layer, combined with Redis-backed session store for revocation support.'],
        initialGoal: 'implement auth',
        recentDecisions: [],
      },
    };
    const result = compileBriefing(memRepo, planRepo, ctx);
    assert.ok(result.text.includes('Approach:'), 'strategic approach should be included');
    assert.ok(result.text.includes('JWT tokens'), 'approach content should be present');
    db.close();
  });

  it('should not render approach for startup sessions', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    const memRepo = new MemoryRepository(db);
    const planRepo = new PlanRepository(db);
    const ctx: BriefingContext = {
      project: 'test-proj',
      sessionType: 'startup',
      interrupted: false,
    };
    const result = compileBriefing(memRepo, planRepo, ctx);
    assert.ok(!result.text.includes('Approach:'), 'startup sessions should not have approach');
    db.close();
  });
});

// --- Approach Note Filter: New Patterns ---

describe('Approach Note Filter — Conversational Rejection', () => {
  it('should reject "Good point" starters', () => {
    const text = 'Good point on the architecture — the current design handles that edge case correctly through the middleware chain and validation layer.';
    assert.ok(!isApproachNote(text));
  });

  it('should reject "Here are" starters', () => {
    const text = 'Here are the real-world results from the production database analysis showing the query performance improvements across all endpoints.';
    assert.ok(!isApproachNote(text));
  });

  it('should reject benchmark status updates', () => {
    const text = 'All 6 benchmarks pass. The approach was to use impact-proportional allocation because it provides better signal-to-noise in the briefing output.';
    assert.ok(!isApproachNote(text));
  });

  it('should reject "Agreed" starters', () => {
    const text = 'Agreed — the factory pattern approach makes more sense here because it provides better testability and separation of concerns across all modules.';
    assert.ok(!isApproachNote(text));
  });
});

// --- Approach Note Filter: Summary & Documentation Rejection ---

describe('Approach Note Filter — Summary & Documentation Rejection', () => {
  it('should reject "All changes verified" summary starters', () => {
    const text = 'All changes verified and working correctly. The approach was to use the factory pattern because it provides better testability and separation of concerns.';
    assert.ok(!isApproachNote(text));
  });

  it('should reject "All fixes applied" summary starters', () => {
    const text = 'All fixes applied to the codebase. First we updated the parser, then the compiler, and finally the renderer to ensure consistency across modules.';
    assert.ok(!isApproachNote(text));
  });

  it('should reject "In summary" recap starters', () => {
    const text = 'In summary, the approach uses semantic search because it provides better recall than keyword-only matching for diverse query patterns across the system.';
    assert.ok(!isApproachNote(text));
  });

  it('should reject text containing markdown headers', () => {
    const text = 'All work is done. Here is the breakdown:\n## Fixes Applied\n### 1. Parser update\nRoot cause was the regex pattern matching too broadly because it tested the entire output.';
    assert.ok(!isApproachNote(text));
  });

  it('should reject text with "summary of" phrasing', () => {
    const text = 'Here is the summary of what each fix addresses and why it was necessary. The first change updated the parser since the regex was matching too broadly.';
    // Caught by both ^here and "summary of what"
    assert.ok(!isApproachNote(text));
  });

  it('should still accept genuine forward-looking approach text', () => {
    const text = 'The approach for the migration uses a staged rollout pattern because it lets us validate each step before committing. First we migrate the schema, then backfill data.';
    assert.ok(isApproachNote(text));
  });
});

// --- Error Rendering: False Positive Filtering ---

describe('Error Rendering — False Positive Filtering', () => {
  it('should filter out vitest info symbols from error display', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    const memRepo = new MemoryRepository(db);
    const planRepo = new PlanRepository(db);
    const ctx: BriefingContext = {
      project: 'test-proj',
      sessionType: 'compact',
      interrupted: false,
      compactionSnapshot: {
        recentFiles: ['src/app.ts'],
        recentReadFiles: [],
        recentCommands: [],
        userContext: ['fix the bug'],
        approachNotes: [],
        initialGoal: 'fix the bug',
        recentDecisions: [],
        errorContext: [
          { errorKey: 'info', errorText: 'ℹ tests 21', count: 2, lastFile: null },
          { errorKey: 'bar', errorText: '⎯⎯⎯⎯⎯⎯⎯⎯[68/76]⎯', count: 1, lastFile: null },
          { errorKey: 'success', errorText: 'Task #8 created successfully: Fix error', count: 1, lastFile: null },
        ],
      },
    };
    const result = compileBriefing(memRepo, planRepo, ctx);
    assert.ok(!result.text.includes('Errors:'), 'all false positive errors should be filtered out');
    assert.ok(!result.text.includes('ℹ tests'), 'vitest info symbol should be filtered');
    assert.ok(!result.text.includes('successfully'), 'success message should be filtered');
    db.close();
  });

  it('should keep genuine errors while filtering false positives', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    const memRepo = new MemoryRepository(db);
    const planRepo = new PlanRepository(db);
    const ctx: BriefingContext = {
      project: 'test-proj',
      sessionType: 'compact',
      interrupted: false,
      compactionSnapshot: {
        recentFiles: ['src/app.ts'],
        recentReadFiles: [],
        recentCommands: [],
        userContext: ['fix the bug'],
        approachNotes: [],
        initialGoal: 'fix the bug',
        recentDecisions: [],
        errorContext: [
          { errorKey: 'real', errorText: 'TypeError: Cannot read property of undefined', count: 1, lastFile: 'src/app.ts' },
          { errorKey: 'fake', errorText: 'ℹ tests 21', count: 2, lastFile: null },
        ],
      },
    };
    const result = compileBriefing(memRepo, planRepo, ctx);
    assert.ok(result.text.includes('Errors:'), 'real errors should appear');
    assert.ok(result.text.includes('TypeError'), 'genuine error should be kept');
    assert.ok(!result.text.includes('ℹ tests'), 'false positive should be filtered');
    db.close();
  });
  it('should filter out vitest summary lines from error display', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    const memRepo = new MemoryRepository(db);
    const planRepo = new PlanRepository(db);
    const ctx: BriefingContext = {
      project: 'test-proj',
      sessionType: 'compact',
      interrupted: false,
      compactionSnapshot: {
        recentFiles: ['src/app.ts'],
        recentReadFiles: [],
        recentCommands: [],
        userContext: ['fix the bug'],
        approachNotes: [],
        initialGoal: 'fix the bug',
        recentDecisions: [],
        errorContext: [
          { errorKey: 'vitest-files', errorText: 'Test Files  2 failed (2)', count: 1, lastFile: null },
          { errorKey: 'vitest-tests', errorText: 'Tests  5 passed (5)', count: 1, lastFile: null },
          { errorKey: 'jest-suites', errorText: 'Test Suites: 1 failed, 2 passed', count: 1, lastFile: null },
        ],
      },
    };
    const result = compileBriefing(memRepo, planRepo, ctx);
    assert.ok(!result.text.includes('Errors:'), 'vitest summary lines should be filtered out');
    assert.ok(!result.text.includes('Test Files'), 'Test Files summary should be filtered');
    assert.ok(!result.text.includes('Test Suites'), 'Test Suites summary should be filtered');
    db.close();
  });

  it('should keep real errors alongside vitest summary lines', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    const memRepo = new MemoryRepository(db);
    const planRepo = new PlanRepository(db);
    const ctx: BriefingContext = {
      project: 'test-proj',
      sessionType: 'compact',
      interrupted: false,
      compactionSnapshot: {
        recentFiles: ['src/app.ts'],
        recentReadFiles: [],
        recentCommands: [],
        userContext: ['fix the bug'],
        approachNotes: [],
        initialGoal: 'fix the bug',
        recentDecisions: [],
        errorContext: [
          { errorKey: 'real', errorText: 'Error: SQLITE_ERROR: no such column: foo', count: 1, lastFile: 'src/db.ts' },
          { errorKey: 'vitest', errorText: 'Test Files  2 failed (2)', count: 1, lastFile: null },
        ],
      },
    };
    const result = compileBriefing(memRepo, planRepo, ctx);
    assert.ok(result.text.includes('Errors:'), 'real error should appear');
    assert.ok(result.text.includes('SQLITE_ERROR'), 'genuine error should be kept');
    assert.ok(!result.text.includes('Test Files'), 'vitest summary should be filtered');
    db.close();
  });
});

// --- Reject-by-Default Error Capture ---

describe('isLikelyErrorOutput — Reject-by-Default', () => {
  it('should reject generic text containing "error" that matches no known pattern', () => {
    assert.ok(!isLikelyErrorOutput('There was an error processing your request'));
    assert.ok(!isLikelyErrorOutput('Something failed during the operation'));
  });

  it('should accept TypeScript errors (known pattern)', () => {
    assert.ok(isLikelyErrorOutput('error TS2345: Argument of type string is not assignable'));
    assert.ok(isLikelyErrorOutput('Cannot find module ./missing-file'));
  });

  it('should accept Python errors (known pattern)', () => {
    assert.ok(isLikelyErrorOutput('TypeError: expected str, got int'));
    assert.ok(isLikelyErrorOutput('FileNotFoundError: No such file /tmp/missing'));
  });

  it('should accept Node errors (known pattern)', () => {
    assert.ok(isLikelyErrorOutput('ERR_MODULE_NOT_FOUND: Cannot find package express'));
    assert.ok(isLikelyErrorOutput('ENOENT: no such file or directory'));
  });

  it('should accept npm/build/process errors (new patterns)', () => {
    assert.ok(isLikelyErrorOutput('npm ERR! code ELIFECYCLE'));
    assert.ok(isLikelyErrorOutput('Failed to compile: Module not found'));
    assert.ok(isLikelyErrorOutput('Process exited with code 1'));
  });

  it('should reject noise patterns (ConnectionError, PermissionError)', () => {
    assert.ok(!isLikelyErrorOutput('ConnectionError: connection refused'));
    assert.ok(!isLikelyErrorOutput('PermissionError: access denied'));
    assert.ok(!isLikelyErrorOutput('ECONNREFUSED 127.0.0.1:5432'));
  });

  it('should reject source code containing error identifiers', () => {
    assert.ok(!isLikelyErrorOutput('42\tconst errorContext = extractErrors(data);'));
    assert.ok(!isLikelyErrorOutput('import { errorHandler } from "./utils";'));
  });

  it('should accept SQLite errors (known pattern)', () => {
    assert.ok(isLikelyErrorOutput('SQLITE_ERROR: no such table: users'));
    assert.ok(isLikelyErrorOutput('SQLITE_CONSTRAINT: UNIQUE constraint failed'));
  });
});

// --- Cross-Tier Decision Dedup ---

// --- Dynamic Briefing Budget ---

describe('Dynamic Briefing Budget — budgetOverride', () => {
  it('should respect budgetOverride in BriefingContext', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    const memRepo = new MemoryRepository(db);
    const planRepo = new PlanRepository(db);

    // Store several pitfalls to generate content
    for (let i = 0; i < 10; i++) {
      memRepo.create({
        content: `Pitfall number ${i}: always check for null before accessing property ${i} on objects returned from API calls`,
        kind: 'pitfall',
        project: 'test-proj',
        confidence: 0.8,
      });
    }

    const ctx: BriefingContext = {
      project: 'test-proj',
      sessionType: 'startup',
      interrupted: false,
    };

    const normal = compileBriefing(memRepo, planRepo, ctx);
    const small = compileBriefing(memRepo, planRepo, { ...ctx, budgetOverride: 600 });

    assert.ok(small.tokenEstimate <= 600, `small budget should produce <= 600 tokens, got ${small.tokenEstimate}`);
    assert.ok(normal.tokenEstimate <= 2000, `default budget should produce <= 2000 tokens, got ${normal.tokenEstimate}`);
    db.close();
  });

  it('should allow larger briefing with higher budget', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    const memRepo = new MemoryRepository(db);
    const planRepo = new PlanRepository(db);

    const ctx: BriefingContext = {
      project: 'test-proj',
      sessionType: 'startup',
      interrupted: false,
      budgetOverride: 3000,
    };

    const result = compileBriefing(memRepo, planRepo, ctx);
    // With 3000 budget, the compiler should not over-constrain
    assert.ok(result.tokenEstimate <= 3000, `should stay within 3000-token budget, got ${result.tokenEstimate}`);
    db.close();
  });
});

// --- Stale Error Filtering ---

describe('Stale Error Filtering in Briefing', () => {
  it('should filter TypeScript unused-variable warnings (TS6133)', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    const memRepo = new MemoryRepository(db);
    const planRepo = new PlanRepository(db);

    const ctx: BriefingContext = {
      project: 'test-proj',
      sessionType: 'compact',
      interrupted: false,
      compactionSnapshot: {
        recentFiles: ['src/session-start.ts'],
        recentReadFiles: [],
        recentCommands: [],
        userContext: [],
        approachNotes: [],
        initialGoal: 'fix build',
        errorContext: [
          { errorKey: 'TS6133', errorText: "src/hooks/session-start.ts(14,18): error TS6133: 'TOKEN_BUDGET' is declared but its value is never read.", count: 1, lastFile: 'src/hooks/session-start.ts' },
        ],
      },
    };
    const result = compileBriefing(memRepo, planRepo, ctx);
    assert.ok(!result.text.includes('TS6133'), 'TS6133 unused warning should be filtered');
    assert.ok(!result.text.includes('TOKEN_BUDGET'), 'transient unused import should not appear');
    db.close();
  });

  it('should filter TS6196 unused declarations', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    const memRepo = new MemoryRepository(db);
    const planRepo = new PlanRepository(db);

    const ctx: BriefingContext = {
      project: 'test-proj',
      sessionType: 'compact',
      interrupted: false,
      compactionSnapshot: {
        recentFiles: [],
        recentReadFiles: [],
        recentCommands: [],
        userContext: [],
        approachNotes: [],
        initialGoal: null,
        errorContext: [
          { errorKey: 'TS6196', errorText: "error TS6196: 'MyType' is declared but its value is never read.", count: 1, lastFile: null },
        ],
      },
    };
    const result = compileBriefing(memRepo, planRepo, ctx);
    assert.ok(!result.text.includes('TS6196'), 'TS6196 should be filtered');
    db.close();
  });

  it('should keep real errors (not unused warnings)', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    const memRepo = new MemoryRepository(db);
    const planRepo = new PlanRepository(db);

    const ctx: BriefingContext = {
      project: 'test-proj',
      sessionType: 'compact',
      interrupted: false,
      compactionSnapshot: {
        recentFiles: [],
        recentReadFiles: [],
        recentCommands: [],
        userContext: [],
        approachNotes: [],
        initialGoal: null,
        errorContext: [
          { errorKey: 'TS2345', errorText: "error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.", count: 1, lastFile: 'src/utils.ts' },
        ],
      },
    };
    const result = compileBriefing(memRepo, planRepo, ctx);
    assert.ok(result.text.includes('TS2345'), 'real type errors should be preserved');
    db.close();
  });
});

// --- Completed Decision Filtering ---

describe('Completed Decision Filtering', () => {
  it('should filter decisions with "all implemented and verified"', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    const memRepo = new MemoryRepository(db);
    const planRepo = new PlanRepository(db);

    const completed = memRepo.create({
      content: 'NSR improvements: PostCompact hook, MCP resources — all implemented and verified in v2.8.0',
      kind: 'decision', project: 'tp',
    });
    db.prepare('UPDATE memories SET surface_count = 5, impact_count = 4 WHERE id = ?').run(completed.id);

    const ctx: BriefingContext = { project: 'tp', sessionType: 'startup', interrupted: false };
    const result = compileBriefing(memRepo, planRepo, ctx);
    assert.ok(!result.text.includes('all implemented and verified'), 'completed decision should be filtered');
    db.close();
  });

  it('should filter decisions with "completed and verified in vX.Y"', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    const memRepo = new MemoryRepository(db);
    const planRepo = new PlanRepository(db);

    const completed = memRepo.create({
      content: 'Auth module completed and verified in v1.5',
      kind: 'decision', project: 'tp',
    });
    db.prepare('UPDATE memories SET surface_count = 5, impact_count = 4 WHERE id = ?').run(completed.id);

    const ctx: BriefingContext = { project: 'tp', sessionType: 'startup', interrupted: false };
    const result = compileBriefing(memRepo, planRepo, ctx);
    assert.ok(!result.text.includes('completed and verified'), 'version-pinned completed decision should be filtered');
    db.close();
  });

  it('should keep active decisions without completion language', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    const memRepo = new MemoryRepository(db);
    const planRepo = new PlanRepository(db);

    const active = memRepo.create({
      content: 'Use sqlite-vec for vector search — single-file deployment',
      kind: 'decision', project: 'tp',
    });
    db.prepare('UPDATE memories SET surface_count = 5, impact_count = 4 WHERE id = ?').run(active.id);

    const ctx: BriefingContext = { project: 'tp', sessionType: 'startup', interrupted: false };
    const result = compileBriefing(memRepo, planRepo, ctx);
    assert.ok(result.text.includes('sqlite-vec'), 'active decision should be preserved');
    db.close();
  });
});

// --- Cross-Tier Decision Dedup ---

describe('Cross-Tier Decision Dedup', () => {
  it('should not render T2 decision that duplicates T1 snapshot decision', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    const memRepo = new MemoryRepository(db);
    const planRepo = new PlanRepository(db);

    // Store same decision in memory DB (will be picked up by T2)
    const decisionText = 'Use JWT tokens with refresh rotation for auth layer — better security than session cookies';
    memRepo.create({ content: decisionText, kind: 'decision', project: 'test-proj' });

    const ctx: BriefingContext = {
      project: 'test-proj',
      sessionType: 'compact',
      interrupted: false,
      compactionSnapshot: {
        recentFiles: ['src/auth.ts'],
        recentReadFiles: [],
        recentCommands: [],
        userContext: ['implement auth'],
        approachNotes: [],
        initialGoal: 'implement auth',
        // Same decision in snapshot (T1 source) — chose field matches content prefix
        recentDecisions: [{ chose: 'Use JWT tokens with refresh rotation for auth layer', why: 'better security than session cookies' }],
      },
    };
    const result = compileBriefing(memRepo, planRepo, ctx);
    // T1 renders under "Decisions:", T2 should NOT re-render under "Prior decisions:"
    assert.ok(result.text.includes('Decisions:'), 'T1 decisions section should exist');
    assert.ok(!result.text.includes('Prior decisions:'), 'T2 should not duplicate T1 decision');
    db.close();
  });

  it('should still render T2 decisions that differ from T1', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    const memRepo = new MemoryRepository(db);
    const planRepo = new PlanRepository(db);

    // Store a DIFFERENT decision in memory DB — fingerprinted to match the
    // task's 'auth' module so it passes the same-project relevance gate.
    const differentDecision = memRepo.create({
      content: 'Use Redis for session store because it supports TTL-based expiry natively',
      kind: 'decision', project: 'test-proj',
      fingerprint: { lang: ['typescript'], framework: ['node'], module: ['auth'] },
    });
    // Boost effectiveness so it passes the threshold
    db.prepare('UPDATE memories SET surface_count = 5, impact_count = 4 WHERE id = ?').run(differentDecision.id);

    const ctx: BriefingContext = {
      project: 'test-proj',
      sessionType: 'compact',
      interrupted: false,
      compactionSnapshot: {
        recentFiles: ['src/auth.ts'],
        recentReadFiles: [],
        recentCommands: [],
        userContext: ['implement auth'],
        approachNotes: [],
        initialGoal: 'implement auth',
        recentDecisions: [{ chose: 'Use JWT tokens with refresh rotation', why: 'better security' }],
      },
    };
    const result = compileBriefing(memRepo, planRepo, ctx);
    assert.ok(result.text.includes('Decisions:'), 'T1 decisions should exist');
    assert.ok(result.text.includes('Prior decisions:'), 'T2 should render non-duplicate decisions');
    assert.ok(result.text.includes('Redis'), 'different T2 decision should appear');
    db.close();
  });

  it('should collapse near-duplicate snapshot decisions in T1', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    const memRepo = new MemoryRepository(db);
    const planRepo = new PlanRepository(db);

    const ctx: BriefingContext = {
      project: 'test-proj',
      sessionType: 'compact',
      interrupted: false,
      compactionSnapshot: {
        recentFiles: ['src/utils/fingerprint.ts'],
        recentReadFiles: [],
        recentCommands: [],
        userContext: ['fix fingerprint leakage'],
        approachNotes: [],
        initialGoal: 'fix fingerprint leakage',
        recentDecisions: [
          {
            chose: 'Mirror system-root path segments in both GENERIC_PATH_SEGMENTS (fingerprint.ts) and BRIEFING_GEN',
            why: '(via cairn_learn)',
          },
          {
            chose: 'Mirror system-root path segments in both GENERIC_PATH_SEGMENTS and BRIEFING_GENERIC_SEGMENTS rat',
            why: '(via cairn_learn)',
          },
        ],
      },
    };
    const result = compileBriefing(memRepo, planRepo, ctx);
    const mirrorMatches = result.text.match(/Mirror system-root path segments/g) ?? [];
    assert.equal(mirrorMatches.length, 1, 'near-duplicate snapshot decisions should collapse to one entry');
    db.close();
  });

  it('should preserve genuinely distinct snapshot decisions in T1', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    const memRepo = new MemoryRepository(db);
    const planRepo = new PlanRepository(db);

    const ctx: BriefingContext = {
      project: 'test-proj',
      sessionType: 'compact',
      interrupted: false,
      compactionSnapshot: {
        recentFiles: ['src/auth.ts'],
        recentReadFiles: [],
        recentCommands: [],
        userContext: ['auth work'],
        approachNotes: [],
        initialGoal: 'auth work',
        recentDecisions: [
          { chose: 'Use JWT tokens with refresh rotation for session auth', why: 'stateless scaling' },
          { chose: 'Store refresh secrets in KMS-managed envelope encryption', why: 'rotation hygiene' },
        ],
      },
    };
    const result = compileBriefing(memRepo, planRepo, ctx);
    assert.ok(result.text.includes('JWT tokens'), 'first distinct decision should render');
    assert.ok(result.text.includes('KMS-managed'), 'second distinct decision should render');
    db.close();
  });
});

// --- Tier-Based Briefing Allocation ---

import { TOKEN_BUDGET } from '../src/constants/index.js';

describe('Tier-Based Briefing: Budget Allocation', () => {
  it('should stay within total token budget', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    const memRepo = new MemoryRepository(db);
    const planRepo = new PlanRepository(db);

    // Create many decisions and pitfalls to stress the budget
    for (let i = 0; i < 10; i++) {
      memRepo.create({ content: `Decision about architecture choice number ${i} with detailed rationale`, kind: 'decision', project: 'tp' });
      memRepo.create({ content: `Pitfall warning about common mistake number ${i} in the codebase`, kind: 'pitfall', project: 'tp' });
    }
    memRepo.create({ content: 'Always use const for immutable bindings in TypeScript', kind: 'correction', project: 'tp' });

    const ctx: BriefingContext = { project: 'tp', sessionType: 'startup', interrupted: false };
    const result = compileBriefing(memRepo, planRepo, ctx);
    assert.ok(result.tokenEstimate <= TOKEN_BUDGET.BRIEFING_MAX,
      `briefing ${result.tokenEstimate} tokens exceeds budget ${TOKEN_BUDGET.BRIEFING_MAX}`);
    db.close();
  });

  it('should render decisions with effectiveness-based tiering', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    const memRepo = new MemoryRepository(db);
    const planRepo = new PlanRepository(db);

    // High-effectiveness decision (high impact/surface ratio)
    const d1 = memRepo.create({
      content: 'Use sqlite-vec over pgvector for single-file deployment',
      kind: 'decision', project: 'tp',
      context: { why: 'No external dependencies needed' },
    });
    db.prepare('UPDATE memories SET surface_count = 10, impact_count = 8 WHERE id = ?').run(d1.id);

    // Low-effectiveness decision (never impactful)
    const d2 = memRepo.create({
      content: 'Low value decision that never helped anyone',
      kind: 'decision', project: 'tp', confidence: 0.3,
    });
    db.prepare('UPDATE memories SET surface_count = 15, impact_count = 0 WHERE id = ?').run(d2.id);

    const ctx: BriefingContext = { project: 'tp', sessionType: 'startup', interrupted: false };
    const result = compileBriefing(memRepo, planRepo, ctx);

    assert.ok(result.text.includes('sqlite-vec'), 'high-effectiveness decision should be included');
    assert.ok(result.text.includes('No external dependencies'), 'high-eff decision should include why');
    assert.ok(!result.text.includes('Low value decision'), 'low-effectiveness decision should be excluded');
    db.close();
  });

  it('should render both decisions and pitfalls in the same briefing', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    const memRepo = new MemoryRepository(db);
    const planRepo = new PlanRepository(db);

    memRepo.create({ content: 'Chose RRF over linear combination for search fusion', kind: 'decision', project: 'tp' });
    memRepo.create({ content: 'Transcript JSONL uses nested format not flat', kind: 'pitfall', project: 'tp' });

    const ctx: BriefingContext = { project: 'tp', sessionType: 'startup', interrupted: false };
    const result = compileBriefing(memRepo, planRepo, ctx);

    assert.ok(result.text.includes('Decisions:') || result.text.includes('Prior decisions:'),
      'should have a decisions section');
    assert.ok(result.text.includes('Pitfalls:'), 'should have a pitfalls section');
    assert.ok(result.text.includes('RRF'), 'decision content present');
    assert.ok(result.text.includes('nested format'), 'pitfall content present');
    db.close();
  });

  it('should skip project context on compact sessions', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    const memRepo = new MemoryRepository(db);
    const planRepo = new PlanRepository(db);

    const ctx: BriefingContext = {
      project: 'tp',
      sessionType: 'compact',
      interrupted: false,
      projectContext: {
        techStack: 'TypeScript, Node.js',
        structure: ['src/', 'tests/'],
        entryPoints: ['dist/server.js'],
        keyConfigs: ['package.json'],
        gitHash: 'abc123',
        projectName: 'test',
        scannedAt: new Date().toISOString(),
      },
      compactionSnapshot: {
        recentFiles: [], recentReadFiles: [], recentCommands: [],
        userContext: ['implement the feature'], approachNotes: [],
        initialGoal: 'implement the feature', recentDecisions: [],
      },
    };
    const result = compileBriefing(memRepo, planRepo, ctx);
    assert.ok(!result.text.includes('Tech:'), 'compact should skip project context');
    assert.ok(!result.text.includes('Structure:'), 'compact should skip structure');
    db.close();
  });

  it('should include project context on startup sessions', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    const memRepo = new MemoryRepository(db);
    const planRepo = new PlanRepository(db);

    const ctx: BriefingContext = {
      project: 'tp',
      sessionType: 'startup',
      interrupted: false,
      projectContext: {
        techStack: 'TypeScript, Node.js',
        structure: ['src/', 'tests/'],
        entryPoints: ['dist/server.js'],
        keyConfigs: ['package.json'],
        gitHash: 'abc123',
        projectName: 'test',
        scannedAt: new Date().toISOString(),
      },
    };
    const result = compileBriefing(memRepo, planRepo, ctx);
    assert.ok(result.text.includes('Stack:'), 'startup should include compact project context');
    db.close();
  });

  it('should handle briefing with no decisions or pitfalls gracefully', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    const memRepo = new MemoryRepository(db);
    const planRepo = new PlanRepository(db);

    const ctx: BriefingContext = { project: 'tp', sessionType: 'startup', interrupted: false };
    const result = compileBriefing(memRepo, planRepo, ctx);

    assert.ok(result.text.includes('[Waykeep Memory Briefing]'), 'should have header');
    assert.ok(!result.text.includes('Decisions:'), 'no decisions section when empty');
    assert.ok(!result.text.includes('Pitfalls:'), 'no pitfalls section when empty');
    assert.ok(result.includedPitfallIds.length === 0);
    db.close();
  });

  it('should use "Prior decisions" header when plan decisions exist in T1', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    const memRepo = new MemoryRepository(db);
    const planRepo = new PlanRepository(db);

    // Create a plan with decisions
    planRepo.create({ project: 'tp', name: 'Test plan', steps: [{ description: 'Step 1' }] });
    const plan = planRepo.getActive('tp')!;
    planRepo.addDecision(plan.id, { chose: 'Option A', why: 'Better perf' });

    // Also create a DB decision — fingerprinted to match the task module
    // ('caching') so it passes the same-project relevance gate.
    memRepo.create({
      content: 'Prior cross-session decision about caching',
      kind: 'decision', project: 'tp',
      fingerprint: { lang: ['typescript'], framework: ['node'], module: ['caching'] },
    });

    const ctx: BriefingContext = {
      project: 'tp',
      sessionType: 'compact',
      interrupted: false,
      compactionSnapshot: {
        recentFiles: [], recentReadFiles: [], recentCommands: [],
        userContext: ['configure caching layer'], approachNotes: [],
        initialGoal: 'configure caching layer', recentDecisions: [],
      },
    };
    const result = compileBriefing(memRepo, planRepo, ctx);
    assert.ok(result.text.includes('Decided: Option A'), 'plan decision in T1');
    assert.ok(result.text.includes('Prior decisions:'), 'DB decisions use "Prior" header');
    db.close();
  });

  it('should respect tier budgets and not let one tier starve another', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    const memRepo = new MemoryRepository(db);
    const planRepo = new PlanRepository(db);

    // Create many high-effectiveness decisions
    for (let i = 0; i < 15; i++) {
      const d = memRepo.create({
        content: `Important architecture decision number ${i} about system design patterns and conventions`,
        kind: 'decision', project: 'tp',
      });
      db.prepare('UPDATE memories SET surface_count = 5, impact_count = 4 WHERE id = ?').run(d.id);
    }

    // Create pitfalls — should still have room
    for (let i = 0; i < 5; i++) {
      memRepo.create({
        content: `Critical pitfall about common mistake ${i} in the system`,
        kind: 'pitfall', project: 'tp',
      });
    }

    const ctx: BriefingContext = { project: 'tp', sessionType: 'startup', interrupted: false };
    const result = compileBriefing(memRepo, planRepo, ctx);

    assert.ok(result.text.includes('Pitfalls:'), 'pitfalls should still render even with many decisions');
    assert.ok(result.text.includes('Decisions:'), 'decisions should render');
    assert.ok(result.tokenEstimate <= TOKEN_BUDGET.BRIEFING_MAX,
      `total ${result.tokenEstimate} should stay within budget`);
    db.close();
  });
});

// --- Goal Staleness Detection ---

describe('Goal Staleness Detection', () => {
  // SNR v3 Commit 4: Now tier replaces the old "Goal:" / "Previous goal:"
  // labels. The staleness gates (carry count, branch mismatch, meta)
  // still live in evaluateCarriedGoal — only the label changed.
  it('renders fresh goal (carry=0) as "Now:"', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    const memRepo = new MemoryRepository(db);
    const planRepo = new PlanRepository(db);
    const ctx: BriefingContext = {
      project: 'test-proj',
      sessionType: 'compact',
      interrupted: false,
      gitState: { branch: 'feat/auth', uncommittedCount: 0, unpushedCount: 0 },
      compactionSnapshot: {
        recentFiles: [],
        recentReadFiles: [],
        recentCommands: [],
        userContext: ['build the auth system'],
        approachNotes: [],
        initialGoal: 'Build the authentication system',
        goalBranch: 'feat/auth',
        goalCarryCount: 0,
        recentDecisions: [],
      },
    };
    const result = compileBriefing(memRepo, planRepo, ctx);
    assert.ok(result.text.includes('Now: Build the authentication system'), 'fresh goal should render as Now:');
    assert.ok(!result.text.includes('Previous goal'), 'Previous goal label is removed in Commit 4');
    db.close();
  });

  it('renders carried goal (carry=1) as "Now:" (no longer Previous goal)', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    const memRepo = new MemoryRepository(db);
    const planRepo = new PlanRepository(db);
    const ctx: BriefingContext = {
      project: 'test-proj',
      sessionType: 'compact',
      interrupted: false,
      gitState: { branch: 'feat/auth', uncommittedCount: 0, unpushedCount: 0 },
      compactionSnapshot: {
        recentFiles: [],
        recentReadFiles: [],
        recentCommands: [],
        userContext: ['continue'],
        approachNotes: [],
        initialGoal: 'Build the authentication system',
        goalBranch: 'feat/auth',
        goalCarryCount: 1,
        recentDecisions: [],
      },
    };
    const result = compileBriefing(memRepo, planRepo, ctx);
    assert.ok(result.text.includes('Now: Build the authentication system'), 'carried-once goal still renders in Now tier');
    assert.ok(!result.text.includes('Previous goal'), 'Previous goal label is removed in Commit 4');
    db.close();
  });

  it('omits stale goal when carry count exceeds threshold', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    const memRepo = new MemoryRepository(db);
    const planRepo = new PlanRepository(db);
    const ctx: BriefingContext = {
      project: 'test-proj',
      sessionType: 'compact',
      interrupted: false,
      gitState: { branch: 'feat/auth', uncommittedCount: 0, unpushedCount: 0 },
      compactionSnapshot: {
        recentFiles: [],
        recentReadFiles: [],
        recentCommands: [],
        userContext: ['continue'],
        approachNotes: [],
        initialGoal: 'Build the authentication system',
        goalBranch: 'feat/auth',
        goalCarryCount: 2,
        recentDecisions: [],
      },
    };
    const result = compileBriefing(memRepo, planRepo, ctx);
    assert.ok(!result.text.includes('Build the authentication system'), 'stale goal (carry>=2) should be omitted');
    db.close();
  });

  it('omits goal when branch has changed (strong stale signal)', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    const memRepo = new MemoryRepository(db);
    const planRepo = new PlanRepository(db);
    const ctx: BriefingContext = {
      project: 'test-proj',
      sessionType: 'compact',
      interrupted: false,
      gitState: { branch: 'feat/payments', uncommittedCount: 0, unpushedCount: 0 },
      compactionSnapshot: {
        recentFiles: [],
        recentReadFiles: [],
        recentCommands: [],
        userContext: ['review the payments module'],
        approachNotes: [],
        initialGoal: 'Build the authentication system',
        goalBranch: 'feat/auth',
        goalCarryCount: 0,
        recentDecisions: [],
      },
    };
    const result = compileBriefing(memRepo, planRepo, ctx);
    assert.ok(!result.text.includes('Build the authentication system'), 'goal from different branch should be omitted');
    db.close();
  });

  it('renders goal normally when goalBranch is not set (pre-v19 snapshots)', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    const memRepo = new MemoryRepository(db);
    const planRepo = new PlanRepository(db);
    const ctx: BriefingContext = {
      project: 'test-proj',
      sessionType: 'compact',
      interrupted: false,
      gitState: { branch: 'main', uncommittedCount: 0, unpushedCount: 0 },
      compactionSnapshot: {
        recentFiles: [],
        recentReadFiles: [],
        recentCommands: [],
        userContext: ['fix the bug'],
        approachNotes: [],
        initialGoal: 'Fix the rendering bug in the dashboard',
        // goalBranch and goalCarryCount omitted — simulates pre-v19 snapshot
        recentDecisions: [],
      },
    };
    const result = compileBriefing(memRepo, planRepo, ctx);
    assert.ok(result.text.includes('Now: Fix the rendering bug in the dashboard'), 'pre-v19 snapshot should render goal in Now tier');
    db.close();
  });
});
