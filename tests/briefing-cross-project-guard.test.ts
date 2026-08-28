/**
 * Phase 6a.2 — briefing path must apply the same cross-project guard as the
 * runtime injection path. Phase 6a only patched pitfall-handler; topPitfalls /
 * topDecisionsRanked / activeCorrections (called from briefing-compiler) were
 * still leaking null-fingerprint global memories (e.g. Odoo 19 pitfalls) into
 * unrelated projects.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type Database from 'better-sqlite3';
import { openDatabase } from '../src/db/connection.js';
import { MemoryRepository } from '../src/db/memory-repository.js';
import { PlanRepository } from '../src/db/plan-repository.js';
import { compileBriefing, type BriefingContext } from '../src/hooks/shared/briefing-compiler.js';
import type { ContextFingerprint } from '../src/utils/fingerprint.js';
import type { ProjectContext } from '../src/utils/project-scanner.js';

const CAIRN_PROJECT = 'cairn-test';
const TS_FP: ContextFingerprint = {
  lang: ['typescript'],
  framework: ['node', 'better-sqlite3'],
  module: ['hooks', 'handlers'],
};

// Comma-separated stack so buildQueryFingerprint produces framework tokens
// ['node', 'better-sqlite3'] that overlap cleanly with stored TS_FP — otherwise
// 'TypeScript/Node.js' gets normalized into one opaque framework string and the
// framework dimension scores zero against any sane stored fingerprint.
const tsProjectContext: ProjectContext = {
  gitHash: 'abc1234',
  projectName: 'cairn',
  techStack: 'TypeScript, Node, better-sqlite3',
  structure: ['src/', 'tests/'],
  entryPoints: ['src/index.ts'],
  keyConfigs: ['package.json', 'tsconfig.json'],
  scannedAt: new Date().toISOString(),
};

function makeCtx(): BriefingContext {
  return {
    project: CAIRN_PROJECT,
    sessionType: 'startup',
    interrupted: false,
    projectContext: tsProjectContext,
    briefingMode: 'full',
    maxPitfalls: 5,
  };
}

let db: Database.Database;
let memRepo: MemoryRepository;
let planRepo: PlanRepository;

beforeEach(() => {
  db = openDatabase({ dbPath: ':memory:' });
  memRepo = new MemoryRepository(db);
  planRepo = new PlanRepository(db);
});

afterEach(() => {
  db.close();
});

describe('Phase 6a.2 — briefing pitfall guard', () => {
  it('blocks null-fingerprint global Odoo pitfalls from a TS project briefing', () => {
    // Same-project Cairn pitfall — must appear
    memRepo.create({
      content: 'Cairn-specific pitfall about hook telemetry schema',
      kind: 'pitfall',
      project: CAIRN_PROJECT,
      confidence: 0.9,
      fingerprint: TS_FP,
    });
    // Global Odoo pitfall with NULL fingerprint — must NOT appear
    memRepo.create({
      content: 'Odoo 19 kanban templates do not have kanban_image function',
      kind: 'pitfall',
      project: null,
      confidence: 1.0,
      // no fingerprint → null in DB
    });
    memRepo.create({
      content: 'Odoo 19 settings view <app> element requires a name attribute',
      kind: 'pitfall',
      project: null,
      confidence: 1.0,
    });

    const out = compileBriefing(memRepo, planRepo, makeCtx());
    assert.match(out.text, /Cairn-specific pitfall about hook telemetry schema/);
    assert.doesNotMatch(out.text, /kanban_image/);
    assert.doesNotMatch(out.text, /settings view/);
  });

  it('allows global TS pitfall with overlapping fingerprint to surface', () => {
    memRepo.create({
      content: 'Global TS pitfall about async error swallowing in node',
      kind: 'pitfall',
      project: null,
      confidence: 1.0,
      fingerprint: { lang: ['typescript'], framework: ['node'], module: [] },
    });

    const out = compileBriefing(memRepo, planRepo, makeCtx());
    assert.match(out.text, /async error swallowing/);
  });
});

describe('Phase 6a.2 — briefing decision guard', () => {
  it('blocks null-fingerprint global cross-project decisions', () => {
    memRepo.storeDecision({
      content: 'vedtech_appointments uses EE-compatible AssignMethod values',
      project: null,
      confidence: 0.9,
      // no fingerprint
    });
    memRepo.storeDecision({
      content: 'Cairn briefing budget is 500 tokens with multi-pass reduction',
      project: CAIRN_PROJECT,
      confidence: 0.9,
      fingerprint: TS_FP,
    });

    const out = compileBriefing(memRepo, planRepo, makeCtx());
    assert.match(out.text, /Cairn briefing budget is 500 tokens/);
    assert.doesNotMatch(out.text, /vedtech_appointments/);
  });
});

describe('Phase 6a.2 — briefing correction guard', () => {
  it('blocks null-fingerprint global corrections from leaking cross-project', () => {
    memRepo.create({
      content: 'Always use the Odoo ORM record API not raw SQL for sale.order',
      kind: 'correction',
      project: null,
      confidence: 0.95,
      // no fingerprint
    });
    memRepo.create({
      content: 'Always use cairn_learn for distilled one-sentence lessons not raw text',
      kind: 'correction',
      project: CAIRN_PROJECT,
      confidence: 0.95,
      fingerprint: TS_FP,
    });

    const out = compileBriefing(memRepo, planRepo, makeCtx());
    assert.match(out.text, /distilled one-sentence lessons/);
    assert.doesNotMatch(out.text, /sale\.order/);
  });
});

describe('Phase 6a.2 — INDEX mode also enforces guard', () => {
  it('strips Odoo pitfalls/decisions/corrections from INDEX briefing', () => {
    // Pitfalls
    memRepo.create({
      content: 'Cairn TS pitfall about better-sqlite3 prepared statement caching',
      kind: 'pitfall',
      project: CAIRN_PROJECT,
      confidence: 0.9,
      fingerprint: TS_FP,
    });
    memRepo.create({
      content: 'Odoo 19 ir.cron no longer has numbercall field',
      kind: 'pitfall',
      project: null,
      confidence: 1.0,
    });
    // Decision
    memRepo.storeDecision({
      content: 'Odoo 19 sale flow uses delivery_status field for kanban grouping',
      project: null,
      confidence: 0.9,
    });

    const ctx: BriefingContext = { ...makeCtx(), briefingMode: 'index', sessionType: 'compact' };
    const out = compileBriefing(memRepo, planRepo, ctx);
    assert.match(out.text, /better-sqlite3 prepared statement/);
    assert.doesNotMatch(out.text, /ir\.cron/);
    assert.doesNotMatch(out.text, /delivery_status/);
  });
});

describe('Phase 6a.2 — fallback when projectContext absent', () => {
  // SNR v3 Commit 2: always-on guards via BRIEFING_BROAD_FP fallback.
  // The pre-v3 "legacy bypass" (no guard when queryFp was absent) was
  // the primary 50% SNR regression path — unfingerprinted globals
  // would surface in any bare-ctx briefing. This test now asserts the
  // OPPOSITE: global pitfalls with no fingerprint must NOT surface on
  // a bare-ctx briefing because they fail the cross-project guard.
  //
  // Pre-v3 behavior (BROKEN): passed unfingerprinted globals through
  // when no projectContext was provided. See SNR-TRUST-IMPLEMENTATION-PLAN.md.
  it('blocks unfingerprinted global pitfalls when ctx.projectContext is undefined', () => {
    memRepo.create({
      content: 'Legacy global pitfall should NOT surface without a fingerprint',
      kind: 'pitfall',
      project: null,
      confidence: 1.0,
    });

    const ctx: BriefingContext = { ...makeCtx(), projectContext: undefined };
    const out = compileBriefing(memRepo, planRepo, ctx);
    assert.doesNotMatch(
      out.text, /Legacy global pitfall/,
      'unfingerprinted global must not bypass cross-project guard via bare ctx',
    );
  });
});
