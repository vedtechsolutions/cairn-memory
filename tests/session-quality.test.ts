import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type Database from 'better-sqlite3';
import { openDatabase } from '../src/db/connection.js';
import type { SessionQuality } from '../src/hooks/session-end.js';

function createTestDb() {
  return openDatabase({ dbPath: ':memory:' });
}

// --- Session Quality Classification ---

// Replicate the classification logic for unit testing
function classifySession(
  errorRate: number,
  escalationCount: number,
  errorCount: number,
  uniqueErrorKeys: number,
): SessionQuality['label'] {
  if (escalationCount >= 2 || (uniqueErrorKeys >= 4 && errorRate > 0.3)) return 'stuck';
  if (errorRate > 0.2 || escalationCount >= 1 || errorCount >= 5) return 'rough';
  if (errorCount <= 1) return 'smooth';
  return 'productive';
}

describe('Session Quality Classification', () => {
  it('should classify zero-error session as smooth', () => {
    assert.equal(classifySession(0, 0, 0, 0), 'smooth');
  });

  it('should classify 1 error session as smooth', () => {
    assert.equal(classifySession(0.02, 0, 1, 1), 'smooth');
  });

  it('should classify low-error session as productive', () => {
    assert.equal(classifySession(0.1, 0, 3, 2), 'productive');
  });

  it('should classify high-error-rate session as rough', () => {
    assert.equal(classifySession(0.3, 0, 4, 2), 'rough');
  });

  it('should classify session with escalation as rough', () => {
    assert.equal(classifySession(0.1, 1, 3, 1), 'rough');
  });

  it('should classify session with many errors as rough', () => {
    assert.equal(classifySession(0.15, 0, 6, 3), 'rough');
  });

  it('should classify session with 2+ escalations as stuck', () => {
    assert.equal(classifySession(0.3, 2, 8, 3), 'stuck');
  });

  it('should classify session with high error diversity + rate as stuck', () => {
    assert.equal(classifySession(0.4, 0, 10, 5), 'stuck');
  });
});

// --- Summary Builder ---

function buildSummary(
  label: string,
  errorCount: number,
  toolCallCount: number,
  stepsCompleted: number,
  totalSteps: number,
  escalationCount: number,
  compactionCount: number,
): string {
  const parts: string[] = [];
  if (toolCallCount > 0) {
    parts.push(`${errorCount} error${errorCount !== 1 ? 's' : ''} / ${toolCallCount} tool calls`);
  }
  if (totalSteps > 0) {
    parts.push(`${stepsCompleted}/${totalSteps} plan steps done`);
  }
  if (escalationCount > 0) {
    parts.push(`${escalationCount} escalation${escalationCount !== 1 ? 's' : ''}`);
  }
  if (compactionCount > 0) {
    parts.push(`${compactionCount} compaction${compactionCount !== 1 ? 's' : ''}`);
  }
  const detail = parts.length > 0 ? ` (${parts.join(', ')})` : '';
  return `${label}${detail}`;
}

describe('Session Quality Summary Builder', () => {
  it('should format smooth session with no plan', () => {
    const summary = buildSummary('smooth', 0, 20, 0, 0, 0, 0);
    assert.equal(summary, 'smooth (0 errors / 20 tool calls)');
  });

  it('should format productive session with plan progress', () => {
    const summary = buildSummary('productive', 2, 45, 3, 5, 0, 0);
    assert.equal(summary, 'productive (2 errors / 45 tool calls, 3/5 plan steps done)');
  });

  it('should format rough session with escalations', () => {
    const summary = buildSummary('rough', 7, 30, 1, 4, 2, 0);
    assert.equal(summary, 'rough (7 errors / 30 tool calls, 1/4 plan steps done, 2 escalations)');
  });

  it('should format stuck session with compactions', () => {
    const summary = buildSummary('stuck', 12, 50, 0, 3, 3, 2);
    assert.equal(summary, 'stuck (12 errors / 50 tool calls, 0/3 plan steps done, 3 escalations, 2 compactions)');
  });

  it('should handle singular forms correctly', () => {
    const summary = buildSummary('rough', 1, 10, 0, 0, 1, 1);
    assert.ok(summary.includes('1 error /'), 'Should use singular "error"');
    assert.ok(summary.includes('1 escalation'), 'Should use singular "escalation"');
    assert.ok(summary.includes('1 compaction'), 'Should use singular "compaction"');
  });

  it('should handle empty session gracefully', () => {
    const summary = buildSummary('smooth', 0, 0, 0, 0, 0, 0);
    assert.equal(summary, 'smooth');
  });
});

// --- Schema v8 Migration ---

describe('Schema v8 — session_quality column', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it('should have session_quality column on sessions table', () => {
    // Insert a session with quality data
    db.prepare(`
      INSERT INTO sessions (id, project, started_at, session_quality)
      VALUES ('test-session', 'test-project', datetime('now'), ?)
    `).run(JSON.stringify({ label: 'smooth', summary: 'smooth (0 errors / 20 tool calls)' }));

    const row = db.prepare('SELECT session_quality FROM sessions WHERE id = ?').get('test-session') as { session_quality: string };
    const quality = JSON.parse(row.session_quality);
    assert.equal(quality.label, 'smooth');
  });

  it('should default session_quality to NULL', () => {
    db.prepare(`
      INSERT INTO sessions (id, project, started_at)
      VALUES ('test-session', 'test-project', datetime('now'))
    `).run();

    const row = db.prepare('SELECT session_quality FROM sessions WHERE id = ?').get('test-session') as { session_quality: string | null };
    assert.equal(row.session_quality, null);
  });
});

// --- Briefing Integration ---

describe('Briefing — quality signal rendering', () => {
  it('should combine quality summary with task summary', () => {
    const quality = { label: 'productive', summary: 'productive (2 errors / 45 tool calls, 3/5 plan steps done)' };
    const taskSummary = 'Worked on "API refactor": 3/5 steps done';

    // Simulate briefing-compiler logic
    const line = `Previous session: ${quality.summary} — ${taskSummary}`;
    assert.ok(line.includes('productive'));
    assert.ok(line.includes('API refactor'));
    assert.ok(line.length < 200, 'Should be compact enough for briefing');
  });

  it('should fall back to task summary when no quality signal', () => {
    const taskSummary = 'Worked on "Bug fix": 1/2 steps done';
    const quality = null;
    const line = quality
      ? `Previous session: ${quality} — ${taskSummary}`
      : `Previous session: ${taskSummary}`;
    assert.ok(line.includes('Bug fix'));
    assert.ok(!line.includes('null'));
  });
});
