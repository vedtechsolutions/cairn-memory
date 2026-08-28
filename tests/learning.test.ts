import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { classifyIntent } from '../src/utils/intent-classifier.js';
import { classifyError, resetErrorTracker } from '../src/utils/error-classifier.js';
import { scoreRelevance, isRelevant } from '../src/utils/relevance.js';
import type { Memory } from '../src/db/memory-repository.js';

// --- Intent Classifier Tests ------------------------------------------------

describe('Intent Classifier', () => {
  // Correction patterns
  it('should classify "No, that\'s wrong" as correction', () => {
    assert.equal(classifyIntent("No, that's wrong"), 'correction');
  });

  it('should classify "don\'t use raw SQL" as correction', () => {
    assert.equal(classifyIntent("don't use raw SQL"), 'correction');
  });

  it('should classify "always use the ORM" as correction', () => {
    assert.equal(classifyIntent('always use the ORM'), 'correction');
  });

  it('should classify "I told you to use list" as correction', () => {
    assert.equal(classifyIntent('I told you to use list'), 'correction');
  });

  it('should classify "stop doing that" as correction', () => {
    assert.equal(classifyIntent('stop doing that'), 'correction');
  });

  it('should classify "never use exec" as correction', () => {
    assert.equal(classifyIntent('never use exec'), 'correction');
  });

  // Status patterns
  it('should classify "where are we?" as status', () => {
    assert.equal(classifyIntent('where are we?'), 'status');
  });

  it('should classify "what\'s the status" as status', () => {
    assert.equal(classifyIntent("what's the status"), 'status');
  });

  it('should classify "show me the plan" as status', () => {
    assert.equal(classifyIntent('show me the plan'), 'status');
  });

  it('should classify "status" as status', () => {
    assert.equal(classifyIntent('status'), 'status');
  });

  // Question patterns
  it('should classify "how does the auth module work?" as question', () => {
    assert.equal(classifyIntent('how does the auth module work?'), 'question');
  });

  it('should classify "what is the database schema?" as question', () => {
    assert.equal(classifyIntent('what is the database schema?'), 'question');
  });

  it('should classify "why did we choose SQLite?" as question', () => {
    assert.equal(classifyIntent('why did we choose SQLite?'), 'question');
  });

  // Questions with action verbs should be tasks
  it('should classify "how do I fix the login bug?" as task', () => {
    assert.equal(classifyIntent('how do I fix the login bug?'), 'task');
  });

  it('should classify "can you implement the payment module?" as task', () => {
    assert.equal(classifyIntent('can you implement the payment module?'), 'task');
  });

  // Task patterns
  it('should classify "fix the login bug" as task', () => {
    assert.equal(classifyIntent('fix the login bug'), 'task');
  });

  it('should classify "refactor the payment service" as task', () => {
    assert.equal(classifyIntent('refactor the payment service'), 'task');
  });

  it('should classify "create a new endpoint" as task', () => {
    assert.equal(classifyIntent('create a new endpoint'), 'task');
  });

  // "no" as discourse marker, not correction
  it('should classify "no i just need X" as task, not correction', () => {
    assert.equal(classifyIntent('no i just compact so i need you to do the analysis'), 'task');
  });

  it('should classify "no let me explain" as task, not correction', () => {
    assert.equal(classifyIntent('no let me explain what I want'), 'task');
  });

  it('should classify "no please fix the bug" as task, not correction', () => {
    assert.equal(classifyIntent('no please fix the login bug'), 'task');
  });

  // "no" followed by correction-like content should still be correction
  it('should classify "no that\'s wrong" as correction', () => {
    assert.equal(classifyIntent("no that's wrong"), 'correction');
  });

  it('should classify "no, don\'t do that" as correction', () => {
    assert.equal(classifyIntent("no, don't do that"), 'correction');
  });

  it('should classify "no stop doing that" as correction', () => {
    assert.equal(classifyIntent("no stop doing that"), 'correction');
  });

  it('should classify "no, you should never do that" as correction', () => {
    assert.equal(classifyIntent("no, you should never do that"), 'correction');
  });

  // Default: unknown → task
  it('should default to task for ambiguous messages', () => {
    assert.equal(classifyIntent('lets continue'), 'task');
  });
});

// --- Error Classifier Tests -------------------------------------------------

describe('Error Classifier', () => {
  beforeEach(() => {
    resetErrorTracker();
  });

  // Learnable errors
  it('should classify SyntaxError as learnable', () => {
    const result = classifyError('SyntaxError: unexpected token at line 42');
    assert.equal(result.learnable, true);
    assert.ok(result.tags.includes('python'));
    assert.ok(result.tags.includes('syntax'));
  });

  it('should classify ImportError as learnable', () => {
    const result = classifyError('ImportError: No module named "foo"');
    assert.equal(result.learnable, true);
    assert.ok(result.tags.includes('imports'));
  });

  it('should classify TypeError as learnable', () => {
    const result = classifyError("TypeError: 'NoneType' object is not subscriptable");
    assert.equal(result.learnable, true);
    assert.ok(result.tags.includes('api'));
  });

  it('should classify ParseError as learnable', () => {
    const result = classifyError('ParseError: unexpected end of input in XML');
    assert.equal(result.learnable, true);
    assert.ok(result.tags.includes('xml'));
  });

  it('should classify ValidationError as learnable', () => {
    const result = classifyError('ValidationError: field "name" is required');
    assert.equal(result.learnable, true);
    assert.ok(result.tags.includes('orm'));
  });

  // Noise errors
  it('should classify ConnectionError as noise', () => {
    const result = classifyError('ConnectionError: failed to connect to server');
    assert.equal(result.learnable, false);
  });

  it('should classify PermissionError as noise', () => {
    const result = classifyError('PermissionError: Permission denied');
    assert.equal(result.learnable, false);
  });

  it('should classify FileNotFoundError as learnable (code bug, not env issue)', () => {
    const result = classifyError('FileNotFoundError: No such file or directory');
    assert.equal(result.learnable, true);
    assert.ok(result.tags.includes('python'));
  });

  it('should classify "command not found" as noise', () => {
    const result = classifyError('bash: some-tool: command not found');
    assert.equal(result.learnable, false);
  });

  it('should classify KeyboardInterrupt as noise', () => {
    const result = classifyError('KeyboardInterrupt');
    assert.equal(result.learnable, false);
  });

  // Unknown errors
  it('should not classify unknown errors', () => {
    const result = classifyError('Something completely unexpected happened');
    assert.equal(result.learnable, false);
  });

  // Dedup within time window
  it('should dedup same error within time window', () => {
    const error = 'SyntaxError: unexpected token at line 42';
    const r1 = classifyError(error);
    assert.equal(r1.learnable, true);

    const r2 = classifyError(error);
    assert.equal(r2.learnable, false); // Deduped
  });

  it('should allow different errors', () => {
    const r1 = classifyError('SyntaxError: unexpected token');
    assert.equal(r1.learnable, true);

    const r2 = classifyError('ImportError: No module named foo');
    assert.equal(r2.learnable, true); // Different error
  });
});

// --- Relevance Scoring Tests ------------------------------------------------

describe('Relevance Scoring', () => {
  function makePitfall(overrides: Partial<Memory> = {}): Memory {
    return {
      id: 'test-id',
      revision: 1,
      content: 'Use list not tree in Odoo views',
      kind: 'pitfall',
      project: 'test-proj',
      tags: ['odoo19', 'xml', 'views'],
      confidence: 0.7,
      source: 'learned',
      created_at: '2024-01-01T00:00:00Z',
      last_recalled: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(), // 3 days ago
      recall_count: 5,
      invalidated: 0,
      surface_count: 0,
      impact_count: 0,
      fingerprint: null,
      context: null,
      anchor: null,
      ...overrides,
    };
  }

  it('should score high for matching file extension', () => {
    const pitfall = makePitfall();
    const score = scoreRelevance(pitfall, { filePath: '/src/views/dashboard.xml' });
    assert.ok(score > 0.25, `Score ${score} should exceed threshold`);
  });

  it('should score high for matching path component', () => {
    const pitfall = makePitfall();
    const score = scoreRelevance(pitfall, { filePath: '/src/views/dashboard.py' });
    assert.ok(score > 0, 'Should have some relevance from path match');
  });

  it('should score zero for unrelated file', () => {
    const pitfall = makePitfall();
    const score = scoreRelevance(pitfall, { filePath: '/src/utils/math.js' });
    // No tag match for "js", "utils", or "math"
    assert.equal(score, 0);
  });

  it('should score zero for empty tags', () => {
    const pitfall = makePitfall({ tags: [] });
    const score = scoreRelevance(pitfall, { filePath: '/src/views/dashboard.xml' });
    assert.equal(score, 0);
  });

  it('should use recency boost for recently recalled', () => {
    const recent = makePitfall({
      last_recalled: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
    });
    const stale = makePitfall({
      last_recalled: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(),
    });

    const recentScore = scoreRelevance(recent, { filePath: '/src/views/test.xml' });
    const staleScore = scoreRelevance(stale, { filePath: '/src/views/test.xml' });
    assert.ok(recentScore > staleScore, 'Recently recalled should score higher');
  });

  it('should factor in confidence', () => {
    const highConf = makePitfall({ confidence: 0.9 });
    const lowConf = makePitfall({ confidence: 0.3 });

    const highScore = scoreRelevance(highConf, { filePath: '/src/views/test.xml' });
    const lowScore = scoreRelevance(lowConf, { filePath: '/src/views/test.xml' });
    assert.ok(highScore > lowScore, 'Higher confidence should score higher');
  });

  it('should match user message content', () => {
    const pitfall = makePitfall();
    const score = scoreRelevance(pitfall, { userMessage: 'update the XML views for odoo19' });
    assert.ok(score > 0.25, `Score ${score} should be relevant`);
  });

  it('isRelevant should gate on threshold', () => {
    assert.equal(isRelevant(0.3), true);
    assert.equal(isRelevant(0.25), false); // Not strictly greater
    assert.equal(isRelevant(0.1), false);
  });
});
