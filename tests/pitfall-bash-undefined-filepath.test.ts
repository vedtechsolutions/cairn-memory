/**
 * Regression: Bash tool calls carry no file path, so the pitfall handler's
 * `filePath` is undefined — not null. `passesSameProjectRelevance` guarded
 * only against null (`filePath !== null && filePath.length > 0`), so ANY
 * Bash command whose fingerprint recall produced at least one candidate
 * crashed the whole pitfall hook with "Cannot read properties of undefined
 * (reading 'length')" — observed live 2026-08-25 through both the embedded
 * daemon (HTTP 500 → bad-status fallback) and the direct-node fallback.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { openDatabase } from '../src/db/connection.js';
import { MemoryRepository } from '../src/db/memory-repository.js';
import { PlanRepository } from '../src/db/plan-repository.js';
import { ReminderRepository } from '../src/db/reminder-repository.js';
import { ContextRepository } from '../src/db/context-repository.js';
import { InvestigationRepository } from '../src/db/investigation-repository.js';
import { SessionCache } from '../src/hooks/shared/session-cache.js';
import type { CachedHookContext } from '../src/hooks/shared/db-client.js';
import { handlePitfallCheck } from '../src/hooks/handlers/pitfall-handler.js';
import type { PreToolUseInput } from '../src/hooks/shared/hook-io.js';
import { projectId } from '../src/utils/project-id.js';

let db: Database.Database;
let cache: SessionCache;
let client: CachedHookContext;
let cwd: string;

beforeEach(() => {
  db = openDatabase({ dbPath: ':memory:' });
  cache = new SessionCache();
  client = {
    db,
    memoryRepo: new MemoryRepository(db),
    planRepo: new PlanRepository(db),
    reminderRepo: new ReminderRepository(db),
    contextRepo: new ContextRepository(db),
    investigationRepo: new InvestigationRepository(db),
    close: () => db.close(),
    cache,
  };
  // Non-git temp cwd: no branch tokens, no project context → the Bash query
  // fingerprint has an empty module dimension (broad query by design).
  cwd = mkdtempSync(join(tmpdir(), 'cairn-bash-fp-'));
});

afterEach(() => {
  try { db.close(); } catch { /* already closed */ }
  rmSync(cwd, { recursive: true, force: true });
});

function bashInput(sessionId: string, command: string): PreToolUseInput {
  return {
    session_id: sessionId,
    transcript_path: '/tmp/x.jsonl',
    cwd,
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command, description: 'test command' },
  } as unknown as PreToolUseInput;
}

// Not read-only (node -e executes arbitrary code) → the handler runs the
// full fingerprint-recall path. Token overlap with the seeded pitfall below
// drives the FTS match and multi-signal score above the injection floor.
const COMMAND =
  'node -e "const Database = require(\'better-sqlite3\'); ' +
  'new Database(\'cairn.db\').prepare(\'SELECT * FROM memories\').all()"';

describe('pitfall-handler — Bash tool call has no file path (undefined, not null)', () => {
  it('does not crash when fingerprint recall yields candidates (the live regression)', () => {
    client.memoryRepo.storePitfall({
      content:
        'better-sqlite3 cairn.db: opening the memories database from node -e ' +
        'while the daemon holds the write lock stalls on SQLITE_BUSY',
      project: projectId(cwd),
      confidence: 0.9,
      source: 'user',
    });

    // Pre-fix this threw: TypeError: Cannot read properties of undefined
    // (reading 'length') at passesSameProjectRelevance.
    const result = handlePitfallCheck(bashInput('sess-bash-1', COMMAND), client);

    // A broad query (no file, no module tokens) must surface the matching
    // same-project pitfall rather than crash or silently drop it.
    assert.ok(result.pitfallsSurfaced >= 1, 'seeded pitfall should surface');
    assert.ok(
      result.output?.includes('better-sqlite3'),
      `output should contain the pitfall content, got: ${String(result.output)}`,
    );
  });

  it('returns cleanly when nothing matches a Bash command', () => {
    const result = handlePitfallCheck(bashInput('sess-bash-2', COMMAND), client);
    assert.equal(result.output, null);
    assert.equal(result.pitfallsSurfaced, 0);
  });
});
