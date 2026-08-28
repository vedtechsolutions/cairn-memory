/**
 * SNR Trust Guardrails — the measurement contract for briefing quality.
 *
 * These tests are the baseline for the "Cairn as trustworthy primary memory"
 * trust contract. They run three probes on every suite invocation:
 *
 *   1. WARM probe — compact-mode briefing with a task-rich snapshot.
 *      Asserts noise-free signal (current v2.2 behaviour: 100%).
 *   2. POST-RESTART STARTUP probe — startup-mode with a carried snapshot
 *      and irrelevant pitfalls competing with relevant ones. Asserts that
 *      cross-project leaks and task-irrelevant same-project pitfalls get
 *      filtered.
 *   3. COLD-START probe — startup-mode with NO snapshot, NO plan, NO goal.
 *      Asserts that the briefing stays sparse + relevant when queryFp is
 *      at its weakest. This is the cold-boot trust test.
 *   4. INVERSE probe — seeds known-relevant memories, asserts 100% recall.
 *      Complements the noise probes: catches over-aggressive guards that
 *      swallow the signal along with the noise.
 *   5. BANNED-PATTERN lint — fails if the `queryFp ?` guard-bypass ternary
 *      reappears in briefing-compiler.ts. After Commit 2 this count is 0.
 *
 * Each test has its own signal/noise budget. Regressions fail loudly.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { openDatabase } from '../src/db/connection.js';
import { MemoryRepository } from '../src/db/memory-repository.js';
import { PlanRepository } from '../src/db/plan-repository.js';
import { compileBriefing, buildBriefingQueryFp, type BriefingContext } from '../src/hooks/shared/briefing-compiler.js';
import { isMetaGoal } from '../src/hooks/shared/transcript-parser.js';
import { meaningfulTokenCount, deriveProjectIdentityTokens } from '../src/utils/cross-project-guard.js';
import type { ProjectContext } from '../src/utils/project-scanner.js';

// PROJECT intentionally starts with 'cairn' so
// deriveProjectIdentityTokens() produces {cairn} — this mirrors the real
// Cairn project's identity and lets us regression-test the exact failure
// mode from the user-observed post-restart SNR drop.
const PROJECT = 'cairn-guardrails-test';
const FOREIGN_PROJECT = 'odoo-globals-project';

const tsProjectContext: ProjectContext = {
  gitHash: 'guardrail',
  projectName: 'cairn-memory',
  techStack: 'TypeScript, Node, better-sqlite3',
  structure: ['src/', 'tests/'],
  entryPoints: ['src/mcp/server.ts'],
  keyConfigs: ['package.json', 'tsconfig.json'],
  scannedAt: new Date().toISOString(),
};

let db: Database.Database;
let memRepo: MemoryRepository;
let planRepo: PlanRepository;

beforeEach(() => {
  db = openDatabase({ dbPath: ':memory:' });
  memRepo = new MemoryRepository(db);
  planRepo = new PlanRepository(db);
});

afterEach(() => db.close());

/** Count items that should not appear — drives the noise budget. */
function countMatches(text: string, patterns: RegExp[]): number {
  return patterns.reduce((n, p) => (p.test(text) ? n + 1 : n), 0);
}

/** Boost a memory's effectiveness so it ranks high regardless of scoring
 *  heuristics — forces the guardrail into the "surfaced or filtered"
 *  decision path. */
function boost(id: string, surface = 10, impact = 8): void {
  db.prepare('UPDATE memories SET surface_count = ?, impact_count = ? WHERE id = ?')
    .run(surface, impact, id);
}

// ---------------------------------------------------------------------------
// PROBE 1 — warm compact, no regression tolerated
// ---------------------------------------------------------------------------

describe('SNR Guardrail: warm compact briefing stays clean', () => {
  it('rejects task-irrelevant same-project pitfalls when snapshot is task-rich', () => {
    // Relevant: briefing-compiler pitfall
    const relevant = memRepo.create({
      content: 'GUARDRAIL_RELEVANT: briefing-compiler dedup must run before token measurement',
      kind: 'pitfall', project: PROJECT, confidence: 0.9,
      fingerprint: { lang: ['typescript'], framework: ['node'], module: ['hooks', 'shared', 'briefing', 'compiler'] },
    });
    boost(relevant.id);

    // Irrelevant same-project distractor
    const distractor = memRepo.create({
      content: 'GUARDRAIL_DISTRACTOR: db/connection.ts migration ordering',
      kind: 'pitfall', project: PROJECT, confidence: 0.9,
      fingerprint: { lang: ['typescript'], framework: ['node'], module: ['db', 'connection'] },
    });
    boost(distractor.id);

    const ctx: BriefingContext = {
      project: PROJECT,
      sessionType: 'compact',
      interrupted: false,
      projectContext: tsProjectContext,
      compactionSnapshot: {
        recentFiles: ['src/hooks/shared/briefing-compiler.ts'],
        recentReadFiles: ['src/hooks/shared/briefing-compiler.ts'],
        recentCommands: [],
        userContext: ['dedup briefing compiler'],
        approachNotes: [],
        initialGoal: 'dedup briefing compiler',
      },
    };

    const out = compileBriefing(memRepo, planRepo, ctx);
    assert.match(out.text, /GUARDRAIL_RELEVANT/, 'relevant pitfall must surface');
    assert.doesNotMatch(out.text, /GUARDRAIL_DISTRACTOR/, 'irrelevant same-project pitfall must drop');
  });
});

// ---------------------------------------------------------------------------
// PROBE 2 — post-restart startup: carried snapshot, competing memories
// ---------------------------------------------------------------------------

describe('SNR Guardrail: post-restart startup briefing filters leaks', () => {
  it('drops foreign-project (Odoo-style) pitfalls even with high effectiveness', () => {
    const foreign = memRepo.create({
      content: 'GUARDRAIL_FOREIGN: Odoo global about ir.model.access rules',
      kind: 'pitfall', project: FOREIGN_PROJECT, confidence: 0.9,
      fingerprint: { lang: ['python'], framework: ['odoo'], module: ['ir', 'model', 'access'] },
    });
    boost(foreign.id, 20, 15);

    const relevant = memRepo.create({
      content: 'GUARDRAIL_STARTUP_RELEVANT: briefing-compiler pitfall about tier-2 dedup',
      kind: 'pitfall', project: PROJECT, confidence: 0.9,
      fingerprint: { lang: ['typescript'], framework: ['node'], module: ['hooks', 'shared', 'briefing', 'compiler'] },
    });
    boost(relevant.id);

    const ctx: BriefingContext = {
      project: PROJECT,
      sessionType: 'startup',
      interrupted: false,
      projectContext: tsProjectContext,
      gitState: {
        branch: 'feat/primary-memory-integration',
        uncommittedCount: 0,
        unpushedCount: 0,
        recentCommits: [],
      },
      compactionSnapshot: {
        recentFiles: ['src/hooks/shared/briefing-compiler.ts'],
        recentReadFiles: [],
        recentCommands: [],
        userContext: ['post-restart'],
        approachNotes: [],
        initialGoal: 'continue briefing work',
      },
    };

    const out = compileBriefing(memRepo, planRepo, ctx);
    assert.doesNotMatch(out.text, /GUARDRAIL_FOREIGN/, 'Odoo-style foreign pitfall must not leak into startup briefing');
  });

  it('reproduces the user-observed regression: project-identity overlap pitfalls leak', () => {
    // This is the exact failure mode from the Cairn SNR v5 post-restart fact:
    // "5 intra-project cairn pitfalls irrelevant to current task surfaced by
    // raw effectiveness ranking". The pitfalls are tagged with project-
    // identity modules (['cairn', 'hooks'] — the Cairn project's own top-
    // level buckets). On post-restart the snapshot enriches queryFp with
    // hooks/shared/briefing tokens, and the pitfalls trivially overlap via
    // the 'hooks' token alone.
    //
    // Commit 1 (project-identity token exclusion) is what makes this test
    // go from "baseline: pitfalls surface" to "target: 0 surface".
    for (let i = 0; i < 5; i++) {
      const p = memRepo.create({
        content: `GUARDRAIL_IDENTITY_${i}: generic hooks-bucket pitfall not relevant to briefing-compiler work`,
        kind: 'pitfall', project: PROJECT, confidence: 0.85,
        // Pitfall tagged with project-identity + generic area — trivially
        // overlaps with any queryFp that contains 'hooks'.
        fingerprint: { lang: ['typescript'], framework: ['node'], module: ['cairn', 'hooks'] },
      });
      boost(p.id, 15, 10);
    }

    // Task-relevant pitfall for the specific briefing-compiler work.
    const relevant = memRepo.create({
      content: 'GUARDRAIL_IDENTITY_RELEVANT: briefing-compiler tier-3 dedup pitfall',
      kind: 'pitfall', project: PROJECT, confidence: 0.9,
      fingerprint: { lang: ['typescript'], framework: ['node'], module: ['hooks', 'shared', 'briefing', 'compiler'] },
    });
    boost(relevant.id);

    const ctx: BriefingContext = {
      project: PROJECT,
      sessionType: 'startup',
      interrupted: false,
      projectContext: tsProjectContext,
      gitState: {
        branch: 'feat/primary-memory-integration',
        uncommittedCount: 0,
        unpushedCount: 0,
        recentCommits: [],
      },
      compactionSnapshot: {
        // Snapshot enriches queryFp with hooks/shared/briefing/compiler tokens.
        recentFiles: ['src/hooks/shared/briefing-compiler.ts'],
        recentReadFiles: ['src/hooks/shared/briefing-compiler.ts'],
        recentCommands: [],
        userContext: ['work on briefing compiler'],
        approachNotes: [],
        initialGoal: 'fix briefing compiler dedup',
      },
    };

    const out = compileBriefing(memRepo, planRepo, ctx);
    const noisePatterns = [0, 1, 2, 3, 4].map(i => new RegExp(`GUARDRAIL_IDENTITY_${i}(?!_RELEVANT)`));
    const noiseCount = countMatches(out.text, noisePatterns);

    // Commit 1 target: 0/5. Project-identity token exclusion in
    // passesSameProjectRelevance strips the `cairn` token from both sides
    // of the overlap check. The regression pitfalls' remaining `[hooks]`
    // is all-generic, so they fail the specific-token requirement.
    console.log(`[guardrail] post-restart project-identity noise count: ${noiseCount}/5`);
    assert.match(out.text, /GUARDRAIL_IDENTITY_RELEVANT/, 'task-relevant pitfall must still surface');
    assert.equal(
      noiseCount, 0,
      `post-restart project-identity noise count must be 0 (Commit 1 target), got ${noiseCount}`
    );
  });
});

// ---------------------------------------------------------------------------
// PROBE 3 — truly cold startup: no snapshot, no plan, no goal
// ---------------------------------------------------------------------------

describe('SNR Guardrail: cold-start startup briefing respects sparsity', () => {
  it('does not surface task-irrelevant disjoint-module pitfalls when queryFp is sparse', () => {
    // Five irrelevant same-project pitfalls with disjoint modules and high
    // effectiveness. Disjoint-module is the easier case — narrow-overlap
    // gate should already catch it. This test locks the current behaviour.
    for (let i = 0; i < 5; i++) {
      const p = memRepo.create({
        content: `GUARDRAIL_COLD_DISJOINT_${i}: unrelated pitfall about module ${i}`,
        kind: 'pitfall', project: PROJECT, confidence: 0.85,
        fingerprint: { lang: ['typescript'], framework: ['node'], module: [`unrelated${i}`, 'legacy'] },
      });
      boost(p.id, 15, 10);
    }

    const ctx: BriefingContext = {
      project: PROJECT,
      sessionType: 'startup',
      interrupted: false,
      projectContext: tsProjectContext,
      gitState: {
        branch: 'feat/primary-memory-integration',
        uncommittedCount: 0,
        unpushedCount: 0,
        recentCommits: [],
      },
      // No compactionSnapshot, no projectGoal, no lastEditCursor — cold boot.
    };

    const out = compileBriefing(memRepo, planRepo, ctx);

    const noisePatterns = [0, 1, 2, 3, 4].map(i => new RegExp(`GUARDRAIL_COLD_DISJOINT_${i}`));
    const noiseCount = countMatches(out.text, noisePatterns);

    // Cold-startup cap target = 2. Disjoint-module pitfalls shouldn't
    // surface at all — they fail the narrow-overlap gate on their own.
    // Failure here means the gate was skipped.
    assert.ok(
      noiseCount <= 2,
      `cold-start disjoint-module noise count ${noiseCount} exceeds cap (2). ` +
      'Expected 0 — disjoint modules should fail narrow-overlap. A non-zero ' +
      'count means the guard was bypassed via the queryFp-undefined branch.'
    );
  });

  it('does not surface task-irrelevant project-identity-overlap pitfalls (regression test)', () => {
    // This reproduces the actual failure mode from the user's post-restart
    // regression: 5 intra-project pitfalls tagged with PROJECT-IDENTITY
    // module tokens (['cairn', 'hooks'] — generic buckets of the Cairn
    // project itself). These trivially overlap with any queryFp that
    // contains the project identity, so narrow-overlap passes them through
    // even though they are not task-relevant to the current work.
    //
    // Commit 1 (project-identity token exclusion) must tighten this.
    // Commit 0 records the current count as the baseline.
    for (let i = 0; i < 5; i++) {
      const p = memRepo.create({
        content: `GUARDRAIL_COLD_IDENTITY_${i}: irrelevant pitfall tagged with project-identity modules`,
        kind: 'pitfall', project: PROJECT, confidence: 0.85,
        fingerprint: { lang: ['typescript'], framework: ['node'], module: ['cairn', 'hooks'] },
      });
      boost(p.id, 15, 10);
    }

    const ctx: BriefingContext = {
      project: PROJECT,
      sessionType: 'startup',
      interrupted: false,
      projectContext: tsProjectContext,
      gitState: {
        branch: 'feat/primary-memory-integration',
        uncommittedCount: 0,
        unpushedCount: 0,
        recentCommits: [],
      },
    };

    const out = compileBriefing(memRepo, planRepo, ctx);
    const noisePatterns = [0, 1, 2, 3, 4].map(i => new RegExp(`GUARDRAIL_COLD_IDENTITY_${i}`));
    const noiseCount = countMatches(out.text, noisePatterns);

    // Commit 1 target: 0/5. Same logic as the post-restart variant — the
    // pitfalls' remaining tokens after stripping project identity are all
    // generic-area labels and fail specific-token requirement.
    console.log(`[guardrail] cold-start project-identity noise count: ${noiseCount}/5`);
    assert.equal(
      noiseCount, 0,
      `cold-start project-identity noise count must be 0 (Commit 1 target), got ${noiseCount}`
    );
  });
});

// ---------------------------------------------------------------------------
// PROBE 4 — inverse recall: relevant memories must surface
// ---------------------------------------------------------------------------

describe('SNR Guardrail: inverse probe — relevant memories surface', () => {
  it('recalls a task-matched pitfall at 100% when the snapshot references the module', () => {
    const needle = memRepo.create({
      content: 'GUARDRAIL_NEEDLE: briefing-compiler must always dedup before token measurement',
      kind: 'pitfall', project: PROJECT, confidence: 0.9,
      fingerprint: { lang: ['typescript'], framework: ['node'], module: ['hooks', 'shared', 'briefing', 'compiler'] },
    });
    boost(needle.id);

    const ctx: BriefingContext = {
      project: PROJECT,
      sessionType: 'compact',
      interrupted: false,
      projectContext: tsProjectContext,
      compactionSnapshot: {
        recentFiles: ['src/hooks/shared/briefing-compiler.ts'],
        recentReadFiles: ['src/hooks/shared/briefing-compiler.ts'],
        recentCommands: [],
        userContext: ['fix briefing compiler'],
        approachNotes: [],
        initialGoal: 'fix briefing compiler',
      },
    };

    const out = compileBriefing(memRepo, planRepo, ctx);
    assert.match(out.text, /GUARDRAIL_NEEDLE/, 'task-matched pitfall must surface');
  });

  it('recalls a task-matched decision at 100% under the same conditions', () => {
    const needle = memRepo.create({
      content: 'GUARDRAIL_DECISION_NEEDLE: passesSameProjectRelevance is the correct gate location',
      kind: 'decision', project: PROJECT, confidence: 0.9,
      fingerprint: { lang: ['typescript'], framework: ['node'], module: ['hooks', 'shared', 'briefing', 'compiler'] },
    });
    boost(needle.id);

    const ctx: BriefingContext = {
      project: PROJECT,
      sessionType: 'compact',
      interrupted: false,
      projectContext: tsProjectContext,
      compactionSnapshot: {
        recentFiles: ['src/hooks/shared/briefing-compiler.ts'],
        recentReadFiles: [],
        recentCommands: [],
        userContext: ['fix briefing compiler'],
        approachNotes: [],
        initialGoal: 'fix briefing compiler',
      },
    };

    const out = compileBriefing(memRepo, planRepo, ctx);
    assert.match(out.text, /GUARDRAIL_DECISION_NEEDLE/, 'task-matched decision must surface');
  });
});

// ---------------------------------------------------------------------------
// PROBE 5 — banned-pattern lint: no queryFp guard-bypass ternary
// ---------------------------------------------------------------------------

describe('SNR Guardrail: banned guard-bypass patterns', () => {
  it('asserts zero queryFp guard-bypass ternaries across the briefing compiler modules', () => {
    // The compiler was split into briefing/ modules — lint the facade AND
    // every module, or a reintroduced bypass in a renderer would go unseen.
    const briefingDir = join(process.cwd(), 'src/hooks/shared/briefing');
    const sources = [
      join(process.cwd(), 'src/hooks/shared/briefing-compiler.ts'),
      ...readdirSync(briefingDir).filter(f => f.endsWith('.ts')).map(f => join(briefingDir, f)),
    ];
    const source = sources.map(p => readFileSync(p, 'utf-8')).join('\n');

    // Banned anti-pattern shape:
    //   const X = queryFp
    //     ? raw.filter(...)...
    //     : raw;
    // The `: <identifier>` false branch is the bypass — it returns the
    // un-guarded list when queryFp is absent, which was the 50% SNR
    // regression path. Always-on guards must fail CLOSED (return `[]`)
    // or use a synthesised cold-start queryFp instead (Commit 3).
    //
    // Deliberately conservative: matches multi-line ternaries whose false
    // branch is a bare identifier. Single-line sizing ternaries like
    // `queryFp ? N*2 : N` and type annotations like `queryFp?:` are
    // NOT banned — they don't bypass a guard.
    const antiPattern = /\bqueryFp\s*\n?\s*\?\s*[\s\S]{1,400}?\n\s*:\s*[a-zA-Z_][a-zA-Z0-9_]*\s*;/g;
    const matches = source.match(antiPattern) ?? [];

    assert.equal(
      matches.length, 0,
      `queryFp guard-bypass ternary count must be 0 (Commit 2 target), got ${matches.length}. ` +
      `Matches:\n${matches.map(m => '  ' + m.replace(/\n/g, ' ').slice(0, 120)).join('\n')}\n` +
      'Replace `queryFp ? guard : raw` with `queryFp ? guard : []` (fail closed) ' +
      'or `guard(queryFp ?? coldStartFp)` (Commit 3 synthesises the cold fp).'
    );
  });

  it('asserts zero indexQueryFp guard-bypass ternaries in briefing-compiler.ts', () => {
    const compilerPath = join(process.cwd(), 'src/hooks/shared/briefing-compiler.ts');
    const source = readFileSync(compilerPath, 'utf-8');
    const antiPattern = /\bindexQueryFp\s*\n?\s*\?\s*[\s\S]{1,400}?\n\s*:\s*[a-zA-Z_][a-zA-Z0-9_]*\s*;/g;
    const matches = source.match(antiPattern) ?? [];
    assert.equal(
      matches.length, 0,
      `indexQueryFp guard-bypass ternary count must be 0, got ${matches.length}`
    );
  });
});

// ---------------------------------------------------------------------------
// SNR v3 Commit 3: cold-start policy primitives.
// ---------------------------------------------------------------------------

describe('SNR v3 Commit 3: meaningfulTokenCount', () => {
  it('excludes project-identity tokens from the meaningful count', () => {
    const identity = deriveProjectIdentityTokens('cairn-2f161aa3');
    const fp = { lang: [], framework: [], module: ['cairn'] };
    assert.equal(meaningfulTokenCount(fp, identity), 0);
  });

  it('excludes generic area labels (hooks/utils/src/...) from the meaningful count', () => {
    const identity = new Set<string>();
    const fp = { lang: [], framework: [], module: ['hooks', 'utils', 'src'] };
    assert.equal(meaningfulTokenCount(fp, identity), 0);
  });

  it('counts task-specific tokens that survive both strips', () => {
    const identity = deriveProjectIdentityTokens('cairn-2f161aa3');
    const fp = { lang: [], framework: [], module: ['cairn', 'hooks', 'primary', 'memory', 'integration'] };
    // cairn stripped by identity, hooks stripped by generic → 3 meaningful
    assert.equal(meaningfulTokenCount(fp, identity), 3);
  });

  it('returns 0 for an empty module dimension', () => {
    assert.equal(meaningfulTokenCount({ lang: ['ts'], framework: [], module: [] }, new Set()), 0);
  });
});

describe('SNR v3 Commit 3: buildBriefingQueryFp always-returns contract', () => {
  const bareCtx: BriefingContext = {
    project: null,
    sessionType: 'startup',
    interrupted: false,
  };

  it('returns a ContextFingerprint (never undefined) even with a completely bare context', () => {
    const fp = buildBriefingQueryFp(bareCtx, null);
    assert.ok(fp, 'must not be undefined on bare ctx');
    assert.ok(Array.isArray(fp.module), 'module dim must exist');
    assert.ok(Array.isArray(fp.lang), 'lang dim must exist');
    assert.ok(Array.isArray(fp.framework), 'framework dim must exist');
  });

  it('synthesises project-identity tokens when only ctx.project is set', () => {
    const ctx: BriefingContext = { ...bareCtx, project: 'cairn-2f161aa3' };
    const fp = buildBriefingQueryFp(ctx, null);
    assert.ok(fp.module.includes('cairn'), 'project-identity token "cairn" must be seeded');
  });

  it('synthesises branch tokens so meaningful count crosses the narrow-overlap threshold', () => {
    const ctx: BriefingContext = {
      ...bareCtx,
      project: 'cairn-2f161aa3',
      gitState: { branch: 'feat/primary-memory-integration', uncommittedCount: 0, unpushedCount: 0 },
    };
    const fp = buildBriefingQueryFp(ctx, null);
    const identity = deriveProjectIdentityTokens(ctx.project);
    // branch produces primary/memory/integration (feat filtered) → 3 meaningful
    assert.ok(meaningfulTokenCount(fp, identity) >= 2, 'warm branch should cross narrow-overlap threshold');
  });

  it('cold start with only project yields meaningful count < 2 so narrow policy stays off', () => {
    const ctx: BriefingContext = { ...bareCtx, project: 'cairn-2f161aa3' };
    const fp = buildBriefingQueryFp(ctx, null);
    const identity = deriveProjectIdentityTokens(ctx.project);
    // Only cwd basename (if non-generic) contributes. On the test runner cwd
    // should be the repo root → `cairn` token → already identity-stripped.
    // Expected < 2 so the compiler falls back to effectiveness+recency.
    assert.ok(
      meaningfulTokenCount(fp, identity) < 2,
      `pure cold start should not cross narrow threshold, got ${meaningfulTokenCount(fp, identity)}: ${JSON.stringify(fp.module)}`,
    );
  });
});

// ---------------------------------------------------------------------------
// SNR v3 Commit 4 — resume-prose leakage into queryFp
// ---------------------------------------------------------------------------
//
// Background: the probe on a fresh snapshot showed the stored `initial_goal`
// being the verbatim session-resume prose ("Continue this was where you
// were before we cot disconnected: Next: Commit 2 — …"). `buildBriefingQueryFp`
// tokenized that prose at lines 242-252, adding English words like
// `continue`, `disconnected`, `ready`, `proceed`, `ternary`, `both`, `places`,
// `banned`, `tightens` to queryFp.module. These are pure noise.
//
// Fix strategy:
//   1. Extend `isMetaGoal` to detect long-form resume-session prose patterns
//      (currently the `shortMetaPatterns` group only catches short "continue"
//      / "proceed" / "go ahead" acks <60 chars).
//   2. Defence-in-depth at the tokenization site: `buildBriefingQueryFp`
//      skips goal tokenization entirely when `isMetaGoal(goal)` is true.
//
// Both layers are required. Layer 1 is the primary filter (meta goals also
// get suppressed from the rendered briefing). Layer 2 guarantees that even
// if a future prose variant bypasses layer 1, its tokens never enter queryFp.

describe('SNR v3 Commit 4: isMetaGoal catches resume-session prose', () => {
  const RESUME_PROSE_SAMPLES = [
    // The exact prose from the probe.
    'Continue this was where you were before we cot disconnected: Next: Commit 2 — always-on guards in renderTier3 + recoverDroppedPitfalls. Replaces the queryFp ? guard : raw ternary with guard(queryFp ?? COLD_FP) in both places, and tightens the banned-pattern test to assert 0. Ready to proceed?',
    // Common variants — "where you were", "before we got disconnected", etc.
    'OK so this was where you were before we got disconnected — please continue.',
    'I think this is where you left off before we got disconnected, ready to proceed?',
  ];

  for (const prose of RESUME_PROSE_SAMPLES) {
    it(`rejects: ${prose.slice(0, 50)}…`, () => {
      assert.ok(
        isMetaGoal(prose),
        `resume-session prose must be classified as meta, got false for: ${prose.slice(0, 80)}`,
      );
    });
  }

  it('still accepts real long-form task goals (e.g. "proceed with t4 and do not commit")', () => {
    const realGoal = 'proceed with t4 and do not commit until I tell you — this is a real task instruction about the tier-4 migration work';
    assert.equal(
      isMetaGoal(realGoal),
      false,
      'real long-form "proceed with" task directives must survive (>60 chars, not resume prose)',
    );
  });

  it('still accepts technical goal text mentioning "ready" or "continue" without the resume-prose shell', () => {
    const realGoal = 'implement the cold-start policy so cold briefings are ready for production rollout';
    assert.equal(
      isMetaGoal(realGoal),
      false,
      'goal text containing "ready" but no resume-prose markers must survive',
    );
  });
});

describe('SNR v3 Commit 4: buildBriefingQueryFp excludes resume-prose tokens', () => {
  const RESUME_PROSE = 'Continue this was where you were before we cot disconnected: Next: Commit 2 — always-on guards in renderTier3 + recoverDroppedPitfalls. Replaces the queryFp ? guard : raw ternary with guard(queryFp ?? COLD_FP) in both places, and tightens the banned-pattern test to assert 0. Ready to proceed?';

  // Every token that appeared in the probe output downstream of the goal
  // tokenization — all should now be suppressed.
  const BANNED_PROSE_TOKENS = [
    'continue', 'were', 'disconnected', 'ready', 'proceed',
    'ternary', 'both', 'places', 'banned', 'tightens', 'replaces',
    'always', 'guards', 'pattern', 'assert',
  ];

  it('does not tokenize resume-prose goal text into queryFp.module', () => {
    const ctx: BriefingContext = {
      project: 'cairn-2f161aa3',
      sessionType: 'compact',
      interrupted: false,
      projectContext: tsProjectContext,
      gitState: {
        branch: 'feat/primary-memory-integration',
        uncommittedCount: 0,
        unpushedCount: 0,
        recentCommits: [],
      },
      compactionSnapshot: {
        recentFiles: ['src/hooks/shared/briefing-compiler.ts'],
        recentReadFiles: ['src/utils/fingerprint.ts'],
        recentCommands: [],
        userContext: [],
        approachNotes: [],
        initialGoal: RESUME_PROSE,
      },
    };

    const fp = buildBriefingQueryFp(ctx, null);
    const leaked = BANNED_PROSE_TOKENS.filter(t => fp.module.includes(t));
    assert.deepEqual(
      leaked,
      [],
      `queryFp.module must not contain prose tokens, leaked: ${JSON.stringify(leaked)}, full module list: ${JSON.stringify(fp.module)}`,
    );
  });

  it('still extracts legitimate tokens from structured sources (files, branch, project identity)', () => {
    const ctx: BriefingContext = {
      project: 'cairn-2f161aa3',
      sessionType: 'compact',
      interrupted: false,
      projectContext: tsProjectContext,
      gitState: {
        branch: 'feat/primary-memory-integration',
        uncommittedCount: 0,
        unpushedCount: 0,
        recentCommits: [],
      },
      compactionSnapshot: {
        recentFiles: ['src/hooks/shared/briefing-compiler.ts'],
        recentReadFiles: ['src/utils/fingerprint.ts'],
        recentCommands: [],
        userContext: [],
        approachNotes: [],
        initialGoal: RESUME_PROSE,
      },
    };

    const fp = buildBriefingQueryFp(ctx, null);
    // Real signals must survive — files + branch + project-identity.
    for (const real of ['briefing', 'compiler', 'hooks', 'shared', 'fingerprint', 'primary', 'memory', 'integration', 'cairn']) {
      assert.ok(
        fp.module.includes(real),
        `real signal token "${real}" must survive, full module list: ${JSON.stringify(fp.module)}`,
      );
    }
  });

  it('still tokenizes a real (non-meta) initialGoal — reinforcement contract preserved', () => {
    const ctx: BriefingContext = {
      project: 'cairn-2f161aa3',
      sessionType: 'compact',
      interrupted: false,
      projectContext: tsProjectContext,
      compactionSnapshot: {
        recentFiles: ['src/hooks/shared/briefing-compiler.ts'],
        recentReadFiles: [],
        recentCommands: [],
        userContext: [],
        approachNotes: [],
        initialGoal: 'dedup briefing compiler tier-3 pitfalls',
      },
    };

    const fp = buildBriefingQueryFp(ctx, null);
    // "dedup" is not in any file path — it must come from the goal.
    assert.ok(
      fp.module.includes('dedup'),
      `real goal token "dedup" must survive tokenization, got: ${JSON.stringify(fp.module)}`,
    );
  });
});
