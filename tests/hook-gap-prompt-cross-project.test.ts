/**
 * GAP K — prompt-handler must apply passesCrossProjectGuard after every
 * memoryRepo.recall/search path. Null-fingerprint global pitfalls (e.g.
 * Odoo 19 pitfalls with no lang dim) were leaking into TS/Node projects
 * via the task-intent injection path.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type Database from 'better-sqlite3';
import { openDatabase } from '../src/db/connection.js';
import { MemoryRepository } from '../src/db/memory-repository.js';
import { PlanRepository } from '../src/db/plan-repository.js';
import { ReminderRepository } from '../src/db/reminder-repository.js';
import { ContextRepository } from '../src/db/context-repository.js';
import { InvestigationRepository } from '../src/db/investigation-repository.js';
import { handlePromptCheck } from '../src/hooks/handlers/prompt-handler.js';
import { passesCrossProjectGuard } from '../src/utils/cross-project-guard.js';
import { generateFingerprint } from '../src/utils/fingerprint.js';
import type { CachedHookContext } from '../src/hooks/shared/db-client.js';
import type { UserPromptSubmitInput } from '../src/hooks/shared/hook-io.js';

let db: Database.Database;
let client: CachedHookContext;

const TS_PROJECT_CWD = '/tmp/ts-test-project-cwd';

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
  // Seed project context with a TS/Node stack so the query fingerprint has lang=typescript.
  client.contextRepo.store(
    // project id will be derived by the handler from cwd — store with the same derivation
    // The handler calls projectId(cwd) which hashes the cwd, so we use getLatest() fallback.
    'any-project',
    {
      gitHash: 'abcdef',
      projectName: 'ts-test',
      techStack: 'TypeScript, Node',
      structure: ['src/'],
      entryPoints: ['src/index.ts'],
      keyConfigs: ['package.json'],
      scannedAt: new Date().toISOString(),
    },
  );
});

afterEach(() => db.close());

function makePromptInput(prompt: string): UserPromptSubmitInput {
  return {
    session_id: 'test-session',
    transcript_path: '/tmp/no-transcript.jsonl',
    cwd: TS_PROJECT_CWD,
    prompt,
  } as unknown as UserPromptSubmitInput;
}

describe('GAP K — prompt-handler cross-project guard', () => {
  it('blocks null-fingerprint global pitfall from TS-project task prompt', () => {
    // Odoo-shaped null-fp global pitfall (exact regression shape)
    client.memoryRepo.create({
      content: 'LEAKY_GLOBAL pitfall about Odoo 19 kanban image',
      kind: 'pitfall',
      project: null,
      confidence: 1.0,
      // fingerprint intentionally omitted → null in DB
    });

    const result = handlePromptCheck(
      makePromptInput('I need to add a new pitfall handler for the file change detection path, please implement it'),
      client,
    );

    // If the guard is applied, the leaky global must NOT be in the output.
    if (result.output) {
      assert.doesNotMatch(result.output, /LEAKY_GLOBAL/);
    }
    // Non-null output is fine as long as it does not contain the leaked pitfall.
  });

  it('admits a global pitfall with overlapping TS fingerprint', () => {
    client.memoryRepo.create({
      content: 'LEGITIMATE_TS_GLOBAL pitfall about async node error handling',
      kind: 'pitfall',
      project: null,
      confidence: 1.0,
      fingerprint: { lang: ['typescript'], framework: ['node'], module: [] },
    });

    // Don't assert on the output directly because the handler also applies
    // intent classification, budget checks, and session dedup. The narrow
    // invariant we want: the legitimate TS global is in the candidate set
    // (i.e. not dropped by the guard).
    const projectCtx = client.contextRepo.getLatest('any-project');
    const fp = generateFingerprint({ projectContext: projectCtx });
    const results = client.memoryRepo.search('async node error handling', {
      kind: 'pitfall',
      maxResults: 5,
      minConfidence: 0.5,
    });
    const tsGlobal = results.find(r => r.memory.content.includes('LEGITIMATE_TS_GLOBAL'));
    assert.ok(tsGlobal, 'legit global is in the unfiltered recall set');
    assert.equal(
      passesCrossProjectGuard(tsGlobal!.memory, 'any-project', fp),
      true,
      'legit global passes the guard',
    );
  });
});
