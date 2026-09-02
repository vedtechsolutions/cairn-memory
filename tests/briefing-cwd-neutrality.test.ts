/**
 * A1 regression — briefing compilation must not depend on the checkout
 * directory's basename. Before the CAIRN_QUERY_CWD override,
 * buildBriefingQueryFp folded basename(process.cwd()) tokens into the query
 * fingerprint: a neutrally-named checkout (CI workspace/, a verification
 * worktree) contributed "meaningful" module tokens that narrowed the SNR
 * gate and silently dropped seeded same-project memories — 23 briefing
 * tests failed on a commit that passed in a directory named `cairn`.
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
import { ENV } from '../src/constants/env.js';

const CAIRN_PROJECT = 'cairn-test';
const TS_FP: ContextFingerprint = {
  lang: ['typescript'],
  framework: ['node', 'better-sqlite3'],
  module: ['hooks', 'handlers'],
};

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

/** The exact directory names that produced the original failure, plus
 *  representative CI/checkout shapes. */
const NEUTRAL_CWDS = [
  '/tmp/scratch/verify-base',
  '/home/ci/workspace',
  '/builds/runner/project-checkout',
];

describe('A1 — briefing is neutral to checkout directory basename', () => {
  let db: Database.Database;
  let memRepo: MemoryRepository;
  let planRepo: PlanRepository;
  let savedCwdOverride: string | undefined;

  beforeEach(() => {
    db = openDatabase({ dbPath: ':memory:' });
    memRepo = new MemoryRepository(db);
    planRepo = new PlanRepository(db);
    savedCwdOverride = process.env[ENV.QUERY_CWD];
  });

  afterEach(() => {
    db.close();
    if (savedCwdOverride === undefined) delete process.env[ENV.QUERY_CWD];
    else process.env[ENV.QUERY_CWD] = savedCwdOverride;
  });

  for (const cwd of NEUTRAL_CWDS) {
    it(`surfaces same-project memories when cwd is ${cwd}`, () => {
      process.env[ENV.QUERY_CWD] = cwd;
      memRepo.create({
        content: 'Cairn-specific pitfall about hook telemetry schema',
        kind: 'pitfall',
        project: CAIRN_PROJECT,
        confidence: 0.9,
        fingerprint: TS_FP,
      });

      const out = compileBriefing(memRepo, planRepo, makeCtx());
      assert.match(
        out.text,
        /Cairn-specific pitfall about hook telemetry schema/,
        `same-project pitfall must survive cwd=${cwd}`,
      );
    });
  }

  it('still blocks unfingerprinted cross-project globals under a neutral cwd', () => {
    process.env[ENV.QUERY_CWD] = NEUTRAL_CWDS[0];
    memRepo.create({
      content: 'Odoo 19 kanban templates do not have kanban_image function',
      kind: 'pitfall',
      project: null,
      confidence: 1.0,
    });

    const out = compileBriefing(memRepo, planRepo, makeCtx());
    assert.doesNotMatch(out.text, /kanban_image/, 'cross-project guard must hold regardless of cwd');
  });

  it('produces the same briefing under project-named and neutral cwds', () => {
    memRepo.create({
      content: 'Cairn-specific pitfall about hook telemetry schema',
      kind: 'pitfall',
      project: CAIRN_PROJECT,
      confidence: 0.9,
      fingerprint: TS_FP,
    });

    process.env[ENV.QUERY_CWD] = '/opt/cairn';
    const projectNamed = compileBriefing(memRepo, planRepo, makeCtx()).text;
    process.env[ENV.QUERY_CWD] = '/home/ci/workspace';
    const neutral = compileBriefing(memRepo, planRepo, makeCtx()).text;

    assert.equal(neutral, projectNamed, 'briefing must not vary with checkout dir name');
  });
});
