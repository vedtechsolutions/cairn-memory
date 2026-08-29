/**
 * SNR precision regressions observed live on 2026-08-29.
 *
 * These are product goldens, not implementation-characterization tests:
 * resolved/superseded pitfalls inject zero text, and a correlated agent turn
 * gets one bounded proactive warning. Loosening either expectation requires a
 * deliberate product decision and an explicit golden update.
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
import { SessionCache } from '../src/hooks/shared/session-cache.js';
import type { CachedHookContext } from '../src/hooks/shared/db-client.js';
import type { PreToolUseInput, SubagentStartInput } from '../src/hooks/shared/hook-io.js';
import { handlePitfallCheck } from '../src/hooks/handlers/pitfall-handler.js';
import { handlePromptCheck } from '../src/hooks/handlers/prompt-handler.js';
import { handleSubagentContext } from '../src/hooks/handlers/subagent-context-handler.js';
import { compileBriefing } from '../src/hooks/shared/briefing-compiler.js';
import { estimateTokensFast } from '../src/utils/tokens.js';
import { projectId } from '../src/utils/project-id.js';
import { PROACTIVE } from '../src/constants/index.js';

const CWD = '/tmp/waykeep-snr-precision';
const PROJECT = projectId(CWD);

let db: Database.Database;
let client: CachedHookContext;

beforeEach(() => {
  db = openDatabase({ dbPath: ':memory:' });
  client = {
    db,
    memoryRepo: new MemoryRepository(db),
    planRepo: new PlanRepository(db),
    reminderRepo: new ReminderRepository(db),
    contextRepo: new ContextRepository(db),
    investigationRepo: new InvestigationRepository(db),
    cache: new SessionCache(),
    close: () => db.close(),
  };
});

afterEach(() => {
  try { db.close(); } catch { /* already closed */ }
});

function seedPitfall(content: string, file: string): string {
  const pathTokens = file.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 2);
  const created = client.memoryRepo.create({
    content,
    kind: 'pitfall',
    project: PROJECT,
    confidence: 0.9,
    source: 'confirmed',
    anchor: JSON.stringify({ file }),
    skipDedup: true,
    fingerprint: {
      lang: ['typescript'],
      framework: ['node'],
      module: ['snr', 'precision', 'warning', 'injection', ...pathTokens],
    },
  });
  db.prepare('UPDATE memories SET surface_count = 4, impact_count = 4 WHERE id = ?').run(created.id);
  return created.id;
}

function editInput(session: string, turn: string, file: string): PreToolUseInput {
  return {
    session_id: session,
    turn_id: turn,
    transcript_path: null,
    cwd: CWD,
    tool_name: 'Edit',
    tool_input: { file_path: file, old_string: 'before', new_string: 'after' },
  };
}

function injectedText(output: string | null): string {
  if (!output) return '';
  const parsed = JSON.parse(output) as {
    hookSpecificOutput?: { additionalContext?: string };
  };
  return parsed.hookSpecificOutput?.additionalContext ?? '';
}

describe('resolved and superseded pitfalls are never injected', () => {
  it('filters both states from full briefings and repository-backed context surfaces', () => {
    const resolvedId = seedPitfall(
      'RESOLVED (2026-08-28): old hook relay flake no longer needs a warning',
      'src/hooks/hook-relay.ts',
    );
    const supersededId = seedPitfall(
      'SUPERSEDED_GOLDEN: old SNR guidance must never surface',
      'src/hooks/hook-relay.ts',
    );
    const activeId = seedPitfall(
      'ACTIVE_GOLDEN: keep warning payloads bounded by the current turn',
      'src/hooks/hook-relay.ts',
    );
    db.prepare('UPDATE memories SET superseded_by = ?, superseded_at = datetime(\'now\') WHERE id = ?')
      .run(activeId, supersededId);

    const briefing = compileBriefing(client.memoryRepo, client.planRepo, {
      project: PROJECT,
      sessionType: 'compact',
      interrupted: false,
      compactionSnapshot: {
        recentFiles: ['src/hooks/hook-relay.ts'],
        recentReadFiles: [],
        recentCommands: [],
        userContext: ['warning injection precision'],
        approachNotes: [],
        initialGoal: 'tighten warning injection precision',
      },
    });
    assert.doesNotMatch(briefing.text, /RESOLVED \(2026-08-28\)/);
    assert.doesNotMatch(briefing.text, /SUPERSEDED_GOLDEN/);
    assert.match(briefing.text, /ACTIVE_GOLDEN/);

    const top = client.memoryRepo.topPitfalls(PROJECT, 10);
    assert.ok(!top.some((m) => m.id === resolvedId), 'resolved rows must not reach subagent/resource consumers');
    assert.ok(!top.some((m) => m.id === supersededId), 'superseded rows must not reach subagent/resource consumers');
  });

  it('filters resolved pitfalls from prompt, pre-tool, and subagent injections', () => {
    seedPitfall(
      '[RESOLVED] prompt parser warning was fixed and must stay retired',
      'docs/prompt-parser.md',
    );

    const prompt = handlePromptCheck({
      session_id: 'snr-resolved-prompt',
      turn_id: 'turn-prompt',
      transcript_path: null,
      cwd: CWD,
      prompt: 'Please review the prompt parser warning because it may affect this task',
    }, client);
    assert.doesNotMatch(String(prompt.output ?? ''), /prompt parser warning was fixed/);

    const preTool = handlePitfallCheck(
      editInput('snr-resolved-tool', 'turn-tool', 'docs/prompt-parser.md'),
      client,
    );
    assert.doesNotMatch(injectedText(preTool.output), /prompt parser warning was fixed/);

    const subagent = handleSubagentContext({
      session_id: 'snr-resolved-subagent',
      turn_id: 'turn-subagent',
      transcript_path: null,
      cwd: CWD,
      agent_id: 'reviewer',
      agent_type: 'review',
    } as SubagentStartInput, client);
    assert.doesNotMatch(String(subagent.output ?? ''), /prompt parser warning was fixed/);
  });
});

describe('per-turn proactive warning budget', () => {
  it('injects one bounded warning, suppresses the rest of that turn, and resets next turn', () => {
    seedPitfall('FIRST_TURN_WARNING: inspect the first file before editing it', 'docs/first.md');
    seedPitfall('SECOND_TURN_WARNING: inspect the second file before editing it', 'docs/second.md');

    const first = handlePitfallCheck(editInput('snr-budget', 'turn-1', 'docs/first.md'), client);
    const firstText = injectedText(first.output);
    assert.match(firstText, /FIRST_TURN_WARNING/);
    assert.equal(first.pitfallsSurfaced, 1, 'SNR golden: one warning per correlated turn');
    assert.ok(
      estimateTokensFast(firstText) <= PROACTIVE.WARNING_TOKEN_BUDGET_PER_TURN,
      `warning context exceeds ${PROACTIVE.WARNING_TOKEN_BUDGET_PER_TURN}-token turn budget`,
    );

    const sameTurn = handlePitfallCheck(editInput('snr-budget', 'turn-1', 'docs/second.md'), client);
    assert.equal(sameTurn.output, null, 'a second tool call in the same turn gets no additional warning');
    assert.equal(sameTurn.pitfallsSurfaced, 0);

    const nextTurn = handlePitfallCheck(editInput('snr-budget', 'turn-2', 'docs/second.md'), client);
    assert.match(injectedText(nextTurn.output), /SECOND_TURN_WARNING/);
    assert.equal(nextTurn.pitfallsSurfaced, 1);
  });
});
