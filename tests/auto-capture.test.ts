import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectUserProfile,
  detectReference,
  extractWhyContext,
} from '../src/utils/intent-classifier.js';

describe('detectUserProfile', () => {
  it('should detect role statements', () => {
    const result = detectUserProfile("I'm a senior TypeScript developer");
    assert.ok(result, 'Should detect role');
    assert.ok(result.content.includes('senior TypeScript developer'));
  });

  it('should detect experience statements', () => {
    const result = detectUserProfile("I've been writing Go for 10 years");
    assert.ok(result, 'Should detect experience');
  });

  it('should detect work context', () => {
    const result = detectUserProfile('I work on the platform team at Acme Corp');
    assert.ok(result, 'Should detect work context');
  });

  it('should detect "new to" statements', () => {
    const result = detectUserProfile("I'm new to React and this project's frontend");
    assert.ok(result, 'Should detect new-to');
  });

  it('should detect team/org context', () => {
    const result = detectUserProfile('Our team uses PostgreSQL and Redis');
    assert.ok(result, 'Should detect team context');
  });

  it('should detect background statements', () => {
    const result = detectUserProfile('My background is in data science and ML');
    assert.ok(result, 'Should detect background');
  });

  it('should NOT detect task-oriented messages', () => {
    assert.equal(detectUserProfile("I'm trying to fix the test"), null);
    assert.equal(detectUserProfile("I'm getting an error on line 42"), null);
    assert.equal(detectUserProfile("I'm working on the database migration"), null);
    assert.equal(detectUserProfile("I'm debugging the auth flow"), null);
  });

  it('should NOT detect short messages', () => {
    assert.equal(detectUserProfile('hi'), null);
    assert.equal(detectUserProfile('yes'), null);
  });

  it('should NOT detect long messages (>200 chars)', () => {
    const long = "I'm a developer who " + 'x'.repeat(200);
    assert.equal(detectUserProfile(long), null);
  });

  it('should NOT detect error-related messages', () => {
    assert.equal(detectUserProfile("I'm a bit confused by this error message"), null);
  });
});

describe('detectReference', () => {
  it('should detect URLs to known systems', () => {
    const result = detectReference('The dashboard is at https://grafana.internal/d/api-latency');
    assert.ok(result, 'Should detect Grafana URL');
    assert.deepEqual(result.tags, ['ref:grafana']);
  });

  it('should detect "tracked in" pattern', () => {
    const result = detectReference('Pipeline bugs are tracked in Linear project INGEST');
    assert.ok(result, 'Should detect Linear reference');
    assert.deepEqual(result.tags, ['ref:linear']);
  });

  it('should detect "check the X dashboard" pattern', () => {
    const result = detectReference('Check the Grafana dashboard for latency metrics');
    assert.ok(result, 'Should detect Grafana reference');
    assert.deepEqual(result.tags, ['ref:grafana']);
  });

  it('should detect Jira references', () => {
    const result = detectReference('Issues are managed in Jira project BACKEND');
    assert.ok(result, 'Should detect Jira reference');
    assert.deepEqual(result.tags, ['ref:jira']);
  });

  it('should detect Sentry references', () => {
    const result = detectReference('Errors are logged in Sentry project api-server');
    assert.ok(result, 'Should detect Sentry reference');
    assert.deepEqual(result.tags, ['ref:sentry']);
  });

  it('should NOT detect generic mentions without resource context', () => {
    // "fix the github repo" — no specific resource identifier in supported patterns
    assert.equal(detectReference('fix it'), null);
    assert.equal(detectReference('hello world'), null);
  });

  it('should NOT detect short messages', () => {
    assert.equal(detectReference('check jira'), null); // < 15 chars
  });

  it('should NOT detect long messages (>300 chars)', () => {
    const long = 'Check the Grafana dashboard ' + 'x'.repeat(300);
    assert.equal(detectReference(long), null);
  });

  it('should NOT detect unknown systems', () => {
    assert.equal(detectReference('Bugs are tracked in MyCustomTool project FOO'), null);
  });
});

describe('extractWhyContext', () => {
  it('should extract "because" clauses', () => {
    const why = extractWhyContext('We use PostgreSQL because MySQL does not support JSONB natively');
    assert.ok(why, 'Should extract because clause');
    assert.ok(why.includes('MySQL'));
  });

  it('should extract "since" clauses', () => {
    const why = extractWhyContext('Chose TypeScript since it provides compile-time type safety');
    assert.ok(why, 'Should extract since clause');
    assert.ok(why.includes('type safety'));
  });

  it('should extract "due to" clauses', () => {
    const why = extractWhyContext('Switched to Redis due to better caching performance');
    assert.ok(why, 'Should extract due-to clause');
    assert.ok(why.includes('caching'));
  });

  it('should extract "the reason is" clauses', () => {
    const why = extractWhyContext('The reason is that the old API was deprecated');
    assert.ok(why, 'Should extract reason clause');
    assert.ok(why.includes('deprecated'));
  });

  it('should return null when no rationale found', () => {
    assert.equal(extractWhyContext('Use PostgreSQL for the database'), null);
    assert.equal(extractWhyContext('fix the tests'), null);
    assert.equal(extractWhyContext('hello world'), null);
  });

  it('should return null for too-short rationale', () => {
    assert.equal(extractWhyContext('because yes'), null); // < 10 chars after "because"
  });

  it('should cap extraction at 150 chars from regex and truncate to 200', () => {
    // Regex captures .{10,150}? — needs a terminator within range
    const longReason = 'We chose X because ' + 'a'.repeat(120) + ' matters greatly.';
    const why = extractWhyContext(longReason);
    assert.ok(why, 'Should extract');
    assert.ok(why.length <= 200, `Should be ≤200 chars, got ${why.length}`);
    assert.ok(why.length >= 10, 'Should have meaningful content');
  });
});
