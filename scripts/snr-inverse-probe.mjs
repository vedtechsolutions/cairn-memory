#!/usr/bin/env node
/**
 * Inverse SNR probe: measures RECALL, not precision. Seeds an in-memory DB
 * with known-relevant memories for a synthetic task, runs the briefing
 * compiler, and reports which of the seeds actually surfaced.
 *
 * The regular probe (snr-probe.mjs) measures whether the briefing contains
 * noise. The inverse probe measures whether the briefing is quiet because
 * the guards are working OR because the guards are over-aggressive and
 * swallowing relevant memories. Both are required for trust — a 100%-signal
 * briefing that drops everything is worse than a noisy one.
 *
 * CLI:
 *   node scripts/snr-inverse-probe.mjs     # run all scenarios, report recall
 *   node scripts/snr-inverse-probe.mjs --verbose  # show the full briefings
 */
import { openDatabase } from '../dist/src/db/connection.js';
import { MemoryRepository } from '../dist/src/db/memory-repository.js';
import { PlanRepository } from '../dist/src/db/plan-repository.js';
import { compileBriefing } from '../dist/src/hooks/shared/briefing-compiler.js';

const verbose = process.argv.includes('--verbose');

/**
 * Each scenario defines:
 *   - name: human label
 *   - seeds: memories to create (with optional effectiveness boosts)
 *   - ctx: the BriefingContext to pass to compileBriefing
 *   - expectedNeedles: strings that MUST appear in the briefing text
 *   - forbiddenNeedles: strings that must NOT appear (cross-project leaks)
 */
const scenarios = [
  {
    name: 'warm compact — task-matched pitfall should surface',
    seeds: [
      {
        content: 'INVERSE_NEEDLE_A: when editing briefing-compiler.ts, always update the DECISION_DEDUP_JACCARD constant in sync with tests',
        kind: 'pitfall',
        confidence: 0.9,
        fingerprint: { lang: ['typescript'], framework: ['node'], module: ['hooks', 'shared', 'briefing', 'compiler'] },
        boost: { surface_count: 8, impact_count: 6 },
      },
      {
        content: 'INVERSE_NEEDLE_B: passesSameProjectRelevance gate is the correct place to filter task-irrelevant memories',
        kind: 'decision',
        confidence: 0.9,
        fingerprint: { lang: ['typescript'], framework: ['node'], module: ['hooks', 'shared', 'briefing', 'compiler'] },
        boost: { surface_count: 10, impact_count: 8 },
      },
    ],
    ctx: {
      project: 'inverse-test-project',
      sessionType: 'compact',
      interrupted: false,
      compactionSnapshot: {
        recentFiles: ['src/hooks/shared/briefing-compiler.ts'],
        recentReadFiles: ['src/hooks/shared/briefing-compiler.ts'],
        recentCommands: [],
        userContext: ['fix briefing compiler relevance gate'],
        approachNotes: [],
        initialGoal: 'fix briefing compiler relevance gate',
      },
    },
    expectedNeedles: ['INVERSE_NEEDLE_A', 'INVERSE_NEEDLE_B'],
    forbiddenNeedles: [],
  },
  {
    name: 'warm compact with distractor — task pitfall surfaces, distractor drops',
    seeds: [
      {
        content: 'INVERSE_NEEDLE_C: briefing-compiler pitfall that must surface',
        kind: 'pitfall',
        confidence: 0.9,
        fingerprint: { lang: ['typescript'], framework: ['node'], module: ['hooks', 'shared', 'briefing', 'compiler'] },
        boost: { surface_count: 10, impact_count: 8 },
      },
      {
        content: 'INVERSE_DISTRACTOR: unrelated pitfall about db/connection.ts migrations',
        kind: 'pitfall',
        confidence: 0.9,
        fingerprint: { lang: ['typescript'], framework: ['node'], module: ['db', 'connection'] },
        boost: { surface_count: 10, impact_count: 8 },
      },
    ],
    ctx: {
      project: 'inverse-test-project',
      sessionType: 'compact',
      interrupted: false,
      compactionSnapshot: {
        recentFiles: ['src/hooks/shared/briefing-compiler.ts'],
        recentReadFiles: [],
        recentCommands: [],
        userContext: ['fix briefing compiler'],
        approachNotes: [],
        initialGoal: 'fix briefing compiler',
      },
    },
    expectedNeedles: ['INVERSE_NEEDLE_C'],
    forbiddenNeedles: ['INVERSE_DISTRACTOR'],
  },
];

const results = [];

for (const scenario of scenarios) {
  const db = openDatabase({ dbPath: ':memory:' });
  const memRepo = new MemoryRepository(db);
  const planRepo = new PlanRepository(db);

  for (const seed of scenario.seeds) {
    const mem = memRepo.create({
      content: seed.content,
      kind: seed.kind,
      project: scenario.ctx.project,
      confidence: seed.confidence,
      fingerprint: seed.fingerprint,
    });
    if (seed.boost) {
      db.prepare('UPDATE memories SET surface_count = ?, impact_count = ? WHERE id = ?')
        .run(seed.boost.surface_count, seed.boost.impact_count, mem.id);
    }
  }

  const out = compileBriefing(memRepo, planRepo, scenario.ctx);

  const missing = scenario.expectedNeedles.filter(n => !out.text.includes(n));
  const leaked = scenario.forbiddenNeedles.filter(n => out.text.includes(n));
  const recall = scenario.expectedNeedles.length === 0
    ? 1
    : (scenario.expectedNeedles.length - missing.length) / scenario.expectedNeedles.length;

  results.push({
    name: scenario.name,
    expected: scenario.expectedNeedles.length,
    found: scenario.expectedNeedles.length - missing.length,
    recall,
    missing,
    leaked,
    text: out.text,
  });

  db.close();
}

console.log('=== inverse SNR probe ===\n');
let totalExpected = 0;
let totalFound = 0;
let totalLeaks = 0;
for (const r of results) {
  console.log(`scenario: ${r.name}`);
  console.log(`  recall: ${r.found}/${r.expected} = ${(r.recall * 100).toFixed(1)}%`);
  if (r.missing.length > 0) {
    console.log(`  MISSING: ${r.missing.join(', ')}`);
  }
  if (r.leaked.length > 0) {
    console.log(`  LEAKED:  ${r.leaked.join(', ')}`);
  }
  if (verbose) {
    console.log('  --- briefing text ---');
    console.log(r.text.split('\n').map(l => '  | ' + l).join('\n'));
    console.log('  --- end ---');
  }
  console.log('');
  totalExpected += r.expected;
  totalFound += r.found;
  totalLeaks += r.leaked.length;
}

const overallRecall = totalExpected === 0 ? 1 : totalFound / totalExpected;
console.log('=== summary ===');
console.log(`overall recall: ${totalFound}/${totalExpected} = ${(overallRecall * 100).toFixed(1)}%`);
console.log(`total leaks: ${totalLeaks}`);

const pass = overallRecall >= 1 && totalLeaks === 0;
process.exitCode = pass ? 0 : 1;
