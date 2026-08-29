/**
 * Tests for prompt-check decision extraction — against the REAL
 * extractDecision export, not private regex copies (audit test-gap fix:
 * the old file re-declared the patterns it claimed to test, so it could
 * never catch a regression in prompt-handler.ts).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { extractDecision } from '../src/hooks/handlers/prompt-handler.js';

describe('extractDecision (real implementation)', () => {
  it('detects "let\'s use X because Y"', () => {
    assert.ok(extractDecision("let's use SQLite because we need atomic writes"));
  });

  it('detects "decided to X because Y"', () => {
    assert.ok(extractDecision("decided to use authlib because it's better maintained"));
  });

  it('detects "use X instead of Y because Z"', () => {
    assert.ok(extractDecision('use Redis instead of Memcached because we need persistence'));
  });

  it('detects "switch to X since Y"', () => {
    assert.ok(extractDecision('switch to PostgreSQL since we need JSON support'));
  });

  it('returns null for action requests without rationale', () => {
    assert.equal(extractDecision("let's use Python"), null);
    assert.equal(extractDecision('switch to the new API'), null);
  });

  it('returns null for questions about decisions', () => {
    assert.equal(extractDecision('why did we decide to use SQLite?'), null);
  });

  it('returns null for general statements with "because"', () => {
    assert.equal(extractDecision('the test failed because of a timeout'), null);
    assert.equal(extractDecision('it crashed because the file was missing'), null);
  });

  it('rejects conversational and tasking prompts about asking, reviewing, or evaluating', () => {
    const taskingPrompts = [
      'I decided to ask Codex for a review because I want a second opinion',
      'We decided to review the implementation because the first pass may have gaps',
      'I chose to evaluate these changes because the memory behavior has improved',
      'Please review this; we decided to use SQLite because atomic writes matter',
      'Can you evaluate why we decided to use SQLite because the old store was unsafe?',
    ];

    for (const prompt of taskingPrompts) {
      assert.equal(extractDecision(prompt), null, `tasking prompt must not become a decision: ${prompt}`);
    }
  });

  it('normalizes whitespace in the extracted decision', () => {
    const decision = extractDecision("let's   use\n\nSQLite because   we need atomic writes");
    assert.equal(decision, "let's use SQLite because we need atomic writes");
  });

  it('truncates decisions longer than 200 chars with an ellipsis', () => {
    const long = `we decided to use PostgreSQL because ${'the requirements demand it and '.repeat(10)}`;
    const decision = extractDecision(long);
    assert.ok(decision);
    assert.equal(decision.length, 200);
    assert.ok(decision.endsWith('...'));
  });
});
