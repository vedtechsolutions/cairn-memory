/**
 * SNR (Signal-to-Noise Ratio) benchmark for briefing pipeline.
 * Measures token allocation efficiency: how many tokens go to proven-useful
 * memories vs unproven/noisy ones.
 *
 * Compares:
 *   - Uniform rendering (old: every pitfall gets content + why)
 *   - Impact-proportional rendering (new: variable-width by effectiveness)
 *   - Correction pass recovery (new: high-impact dropped pitfalls recovered)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db/connection.js';
import { MemoryRepository } from '../src/db/memory-repository.js';
import { PlanRepository } from '../src/db/plan-repository.js';
import {
  compileBriefing,
  computeEffectiveness,
  recoverDroppedPitfalls,
  type BriefingContext,
} from '../src/hooks/shared/briefing-compiler.js';
import { estimateTokens } from '../src/utils/tokens.js';

/** Seed a realistic memory DB with a mix of high/medium/low effectiveness pitfalls */
function seedRealisticPitfalls(db: ReturnType<typeof openDatabase>, memRepo: MemoryRepository, project: string) {
  const pitfalls = [
    // HIGH effectiveness — proven valuable (high impact/surface ratio)
    {
      content: 'Schema migrations must be idempotent — use IF NOT EXISTS for ALTER TABLE ADD COLUMN',
      why: 'Non-idempotent migrations crash on re-run after partial failure',
      how_to_apply: 'Wrap every ALTER in IF NOT EXISTS guard',
      surface_count: 12, impact_count: 9,  confidence: 0.85,
    },
    {
      content: 'Cross-hook state requires file-based persistence — each hook is a fresh Node process',
      why: 'In-memory state is lost between hook invocations',
      how_to_apply: 'Use edit-tracker.json for inter-hook communication',
      surface_count: 8, impact_count: 7, confidence: 0.80,
    },
    {
      content: 'ISO datetime format required for SQLite time comparisons — datetime() uses space-separated format',
      why: 'strftime and datetime return different formats causing silent comparison failures',
      how_to_apply: 'Use strftime with explicit ISO pattern',
      surface_count: 6, impact_count: 5, confidence: 0.75,
    },

    // MEDIUM effectiveness — some signal, some noise
    {
      content: 'Claude Code transcript JSONL uses nested content arrays, not flat objects',
      why: 'Parsing as flat objects silently returns undefined for all fields',
      how_to_apply: null,
      surface_count: 10, impact_count: 3, confidence: 0.65,
    },
    {
      content: 'FTS5 stopword filtering needed to prevent false matches on common bash words',
      why: 'Generic terms like "error" and "file" match too broadly',
      how_to_apply: null,
      surface_count: 7, impact_count: 2, confidence: 0.60,
    },

    // LOW effectiveness — noise (surfaced often, never helped)
    {
      content: 'Remember to check environment variables are set before running integration tests against staging',
      why: 'Tests fail with cryptic connection errors when env vars are missing',
      how_to_apply: null,
      surface_count: 15, impact_count: 0, confidence: 0.30,
    },
    {
      content: 'Avoid using deprecated Buffer constructor — use Buffer.from or Buffer.alloc instead',
      why: 'Deprecation warnings clutter test output',
      how_to_apply: null,
      surface_count: 12, impact_count: 0, confidence: 0.25,
    },
    {
      content: 'Git hooks may timeout on large repos — consider increasing the timeout setting in your configuration',
      why: 'Slow pre-commit hooks cause frustration',
      how_to_apply: null,
      surface_count: 8, impact_count: 0, confidence: 0.35,
    },
  ];

  const ids: string[] = [];
  for (const p of pitfalls) {
    const result = memRepo.create({
      content: p.content,
      kind: 'pitfall',
      project,
      context: { why: p.why, ...(p.how_to_apply ? { how_to_apply: p.how_to_apply } : {}) },
      confidence: p.confidence,
    });
    ids.push(result.id);
    db.prepare('UPDATE memories SET surface_count = ?, impact_count = ? WHERE id = ?')
      .run(p.surface_count, p.impact_count, result.id);
  }
  return { ids, pitfalls };
}

/** Simulate old uniform rendering (content + why for all, no tiers) */
function uniformRender(memRepo: MemoryRepository, project: string, limit: number): { text: string; tokens: number } {
  const pitfalls = memRepo.topPitfalls(project, limit);
  const lines: string[] = ['Pitfalls:'];
  for (const p of pitfalls) {
    const why = p.context?.why ? ` (Why: ${p.context.why})` : '';
    lines.push(`  - ${p.content}${why}`);
  }
  const text = lines.join('\n');
  return { text, tokens: estimateTokens(text) };
}

/** Compute SNR: tokens on high+medium effectiveness / tokens on low effectiveness */
function computeSNR(
  memRepo: MemoryRepository,
  project: string,
  renderedText: string,
): { signalTokens: number; noiseTokens: number; ratio: number; details: string[] } {
  const pitfalls = memRepo.topPitfalls(project, 10);
  let signalTokens = 0;
  let noiseTokens = 0;
  const details: string[] = [];

  for (const p of pitfalls) {
    const eff = computeEffectiveness(p);
    // Check if this pitfall's content appears in the rendered text
    const contentSnippet = p.content.slice(0, 30);
    if (!renderedText.includes(contentSnippet)) continue;

    // Find the line containing this pitfall
    const line = renderedText.split('\n').find(l => l.includes(contentSnippet));
    if (!line) continue;

    const lineTokens = estimateTokens(line);
    const tier = eff >= 0.5 ? 'HIGH' : eff >= 0.1 ? 'MED' : 'LOW';

    if (eff >= 0.1) {
      signalTokens += lineTokens;
    } else {
      noiseTokens += lineTokens;
    }
    details.push(`  ${tier} (eff=${eff.toFixed(2)}): ${lineTokens} tokens — ${p.content.slice(0, 50)}…`);
  }

  const ratio = noiseTokens === 0 ? Infinity : signalTokens / noiseTokens;
  return { signalTokens, noiseTokens, ratio, details };
}

// ============================================================================

describe('SNR Benchmark — Impact-Proportional Allocation', () => {

  it('should allocate more tokens to high-effectiveness pitfalls than low', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    const memRepo = new MemoryRepository(db);
    const planRepo = new PlanRepository(db);
    const project = 'snr-test';
    seedRealisticPitfalls(db, memRepo, project);

    const ctx: BriefingContext = { project, sessionType: 'startup', interrupted: false };
    const result = compileBriefing(memRepo, planRepo, ctx);
    const snr = computeSNR(memRepo, project, result.text);

    console.log('\n=== NEW (Impact-Proportional) ===');
    console.log(`Signal tokens: ${snr.signalTokens}`);
    console.log(`Noise tokens:  ${snr.noiseTokens}`);
    console.log(`SNR ratio:     ${snr.ratio === Infinity ? '∞ (zero noise)' : snr.ratio.toFixed(2)}`);
    console.log(`Total tokens:  ${result.tokenEstimate}`);
    console.log('Per-pitfall breakdown:');
    for (const d of snr.details) console.log(d);

    // Signal should dominate noise
    assert.ok(snr.signalTokens > snr.noiseTokens,
      `Signal (${snr.signalTokens}) should exceed noise (${snr.noiseTokens})`);
    db.close();
  });

  it('should produce better SNR than uniform rendering', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    const memRepo = new MemoryRepository(db);
    const planRepo = new PlanRepository(db);
    const project = 'snr-compare';
    seedRealisticPitfalls(db, memRepo, project);

    // New: impact-proportional
    const ctx: BriefingContext = { project, sessionType: 'startup', interrupted: false };
    const newResult = compileBriefing(memRepo, planRepo, ctx);
    const newSNR = computeSNR(memRepo, project, newResult.text);

    // Old: uniform rendering (simulated)
    const oldResult = uniformRender(memRepo, project, 5);
    const oldSNR = computeSNR(memRepo, project, oldResult.text);

    console.log('\n=== COMPARISON ===');
    console.log(`Old uniform  — signal: ${oldSNR.signalTokens}, noise: ${oldSNR.noiseTokens}, ratio: ${oldSNR.ratio === Infinity ? '∞' : oldSNR.ratio.toFixed(2)}, total: ${oldResult.tokens} tokens`);
    console.log(`New proportional — signal: ${newSNR.signalTokens}, noise: ${newSNR.noiseTokens}, ratio: ${newSNR.ratio === Infinity ? '∞' : newSNR.ratio.toFixed(2)}, total: ${newResult.tokenEstimate} tokens`);

    if (oldSNR.noiseTokens > 0 && newSNR.noiseTokens > 0) {
      const improvement = ((newSNR.ratio - oldSNR.ratio) / oldSNR.ratio * 100);
      console.log(`SNR improvement: ${improvement.toFixed(1)}%`);
    } else if (newSNR.noiseTokens === 0 && oldSNR.noiseTokens > 0) {
      console.log('SNR improvement: ∞ (new approach eliminated all noise tokens)');
    }

    // New approach should use fewer noise tokens
    assert.ok(newSNR.noiseTokens <= oldSNR.noiseTokens,
      `New noise (${newSNR.noiseTokens}) should be ≤ old noise (${oldSNR.noiseTokens})`);
    db.close();
  });

  it('should render how_to_apply only for high-effectiveness pitfalls', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    const memRepo = new MemoryRepository(db);
    const planRepo = new PlanRepository(db);
    const project = 'snr-howto';
    seedRealisticPitfalls(db, memRepo, project);

    const ctx: BriefingContext = { project, sessionType: 'startup', interrupted: false };
    const result = compileBriefing(memRepo, planRepo, ctx);

    // High-effectiveness pitfalls should have → marker (how_to_apply)
    const howToCount = (result.text.match(/→/g) || []).length;
    console.log(`\nhow_to_apply rendered: ${howToCount} times`);

    // At least some high-effectiveness ones should have how_to_apply
    assert.ok(howToCount > 0, 'High-effectiveness pitfalls should render how_to_apply');

    // Low-effectiveness pitfalls should NOT have how_to_apply or why
    // The low-eff pitfalls about "environment variables", "Buffer", "Git hooks"
    // should be truncated
    const hasDeprecatedFull = result.text.includes('Deprecation warnings clutter');
    assert.ok(!hasDeprecatedFull, 'Low-effectiveness pitfall should not render full why context');
    db.close();
  });
});

describe('SNR Benchmark — Correction Pass Recovery', () => {

  it('should recover high-impact pitfalls dropped during reduction', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    const memRepo = new MemoryRepository(db);
    const project = 'snr-recovery';
    const { ids } = seedRealisticPitfalls(db, memRepo, project);

    // Simulate: briefing only included 1 pitfall (after aggressive reduction)
    // The first 3 are high-impact, so excluding them simulates them being dropped
    const includedIds = [ids[0]]; // only kept the first one

    const recovered = recoverDroppedPitfalls(memRepo, project, includedIds, 200);
    assert.ok(recovered !== null, 'Should recover dropped high-impact pitfalls');

    const recoveredLines = recovered!.split('\n').filter(l => l.includes('[!]'));
    console.log(`\n=== CORRECTION PASS ===`);
    console.log(`Recovered ${recoveredLines.length} high-impact pitfall(s):`);
    for (const line of recoveredLines) console.log(line);

    assert.ok(recoveredLines.length > 0, 'At least one high-impact pitfall should be recovered');
    assert.ok(recoveredLines.length <= 2, 'Should cap at CORRECTION_PASS_MAX_ITEMS');

    // Verify recovered content is from high-impact pitfalls (ids[1] or ids[2])
    assert.ok(
      recovered!.includes('Cross-hook') || recovered!.includes('ISO datetime'),
      'Should recover the high-impact pitfalls (cross-hook state or ISO datetime)',
    );
    db.close();
  });

  it('should not waste budget on low-impact pitfalls in correction pass', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    const memRepo = new MemoryRepository(db);
    const project = 'snr-no-waste';
    seedRealisticPitfalls(db, memRepo, project);

    // Include only high-impact ones, leave low-impact excluded
    // The correction pass should NOT recover the low-impact ones (ids 5,6,7)
    const allPitfalls = memRepo.topPitfalls(project, 10);
    const highImpactIds = allPitfalls
      .filter(p => p.impact_count >= 2)
      .map(p => p.id);

    const recovered = recoverDroppedPitfalls(memRepo, project, highImpactIds, 200);
    // All high-impact ones are included, so nothing should be recovered
    assert.equal(recovered, null, 'Should not recover low-impact pitfalls');
    db.close();
  });

  it('should measure end-to-end token efficiency with correction pass', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    const memRepo = new MemoryRepository(db);
    const planRepo = new PlanRepository(db);
    const project = 'snr-e2e';
    seedRealisticPitfalls(db, memRepo, project);

    // Full briefing with only 1 pitfall (simulating aggressive reduction)
    const ctx: BriefingContext = {
      project,
      sessionType: 'startup',
      interrupted: false,
      maxPitfalls: 1,
    };
    const briefing = compileBriefing(memRepo, planRepo, ctx);
    const remainingBudget = 1000 - briefing.tokenEstimate;

    const recovered = recoverDroppedPitfalls(
      memRepo, project, briefing.includedPitfallIds, remainingBudget,
    );

    const finalText = recovered ? briefing.text + '\n' + recovered : briefing.text;
    const finalTokens = estimateTokens(finalText);

    console.log(`\n=== END-TO-END ===`);
    console.log(`Briefing (1 pitfall): ${briefing.tokenEstimate} tokens`);
    console.log(`Remaining budget:     ${remainingBudget} tokens`);
    console.log(`Recovered text:       ${recovered ? estimateTokens(recovered) + ' tokens' : 'none'}`);
    console.log(`Final total:          ${finalTokens} tokens (budget: 1000)`);
    console.log(`Budget utilization:   ${(finalTokens / 1000 * 100).toFixed(1)}%`);

    assert.ok(finalTokens <= 1000, 'Final output should fit within budget');

    if (recovered) {
      // Recovery should add signal, not noise
      const recoveredTokens = estimateTokens(recovered);
      console.log(`Recovery efficiency:  ${recoveredTokens} tokens for ${recovered.split('\n').filter(l => l.includes('[!]')).length} critical pitfall(s)`);
      assert.ok(recoveredTokens < 100, 'Recovery should be ultra-compact (<100 tokens)');
    }
    db.close();
  });
});
