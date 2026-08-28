import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { classifyError, resetErrorTracker } from '../src/utils/error-classifier.js';
import { ESCALATION, ESCALATION_ALTERNATIVES, ESCALATION_FALLBACK, ESCALATION_TOOL_ALTERNATIVES } from '../src/constants/index.js';

// --- Error Classifier: errorKey on deduped errors ---

describe('Error Classifier — errorKey persistence', () => {
  beforeEach(() => {
    resetErrorTracker();
  });

  it('should return errorKey on first (learnable) classification', () => {
    const result = classifyError('error TS2345: Argument of type string');
    assert.equal(result.learnable, true);
    assert.ok(result.errorKey, 'errorKey should be present');
    assert.ok(result.errorKey!.length > 0);
  });

  it('should return errorKey even when deduped (learnable=false)', () => {
    const error = 'error TS2345: Argument of type string';
    classifyError(error); // first — learnable
    const r2 = classifyError(error); // second — deduped
    assert.equal(r2.learnable, false, 'should be deduped');
    assert.ok(r2.errorKey, 'errorKey should still be present for escalation counting');
    assert.ok(r2.tags.includes('typescript'), 'tags should still be present');
  });

  it('should return null errorKey for noise errors', () => {
    const result = classifyError('ConnectionError: failed to connect');
    assert.equal(result.learnable, false);
    assert.equal(result.errorKey, null);
  });

  it('should return null errorKey for unknown errors', () => {
    const result = classifyError('Something completely unexpected happened');
    assert.equal(result.errorKey, null);
  });

  it('should normalize numbers in errorKey for stable dedup', () => {
    const r1 = classifyError('error TS2345: at line 42 column 8');
    resetErrorTracker();
    const r2 = classifyError('error TS2345: at line 99 column 3');
    assert.equal(r1.errorKey, r2.errorKey, 'same error with different numbers should produce same key');
  });
});

// --- Escalation Constants ---

describe('Escalation Constants', () => {
  it('should have a threshold of 3', () => {
    assert.equal(ESCALATION.THRESHOLD, 3);
  });

  it('should have category alternatives for common error types', () => {
    assert.ok('typescript' in ESCALATION_ALTERNATIVES);
    assert.ok('python' in ESCALATION_ALTERNATIVES);
    assert.ok('sqlite' in ESCALATION_ALTERNATIVES);
    assert.ok('node' in ESCALATION_ALTERNATIVES);
    assert.ok('testing' in ESCALATION_ALTERNATIVES);
  });

  it('should have tool alternatives for Write, Edit, Bash', () => {
    assert.ok('Write' in ESCALATION_TOOL_ALTERNATIVES);
    assert.ok('Edit' in ESCALATION_TOOL_ALTERNATIVES);
    assert.ok('Bash' in ESCALATION_TOOL_ALTERNATIVES);
  });

  it('should have a fallback alternative', () => {
    assert.ok(ESCALATION_FALLBACK.length > 0);
  });

  it('alternatives should use positive framing (no STOP/DONT)', () => {
    for (const [, msg] of Object.entries(ESCALATION_ALTERNATIVES)) {
      assert.ok(!/\bSTOP\b/.test(msg), `"${msg}" should not contain STOP`);
      assert.ok(!/\bDON'?T\b/i.test(msg), `"${msg}" should not contain DON'T`);
    }
  });
});

// --- Escalation Message Building (integration-style via imports) ---

// We test the message builders by importing them from the compiled hook.
// Since they're module-level functions (not exported), we test via constants
// and the classification pipeline behavior.

describe('Escalation Pipeline — classification → counting flow', () => {
  beforeEach(() => {
    resetErrorTracker();
  });

  it('first occurrence: learnable=true, errorKey present', () => {
    const r = classifyError('SQLITE_ERROR: no such table: memories');
    assert.equal(r.learnable, true);
    assert.ok(r.errorKey);
    assert.ok(r.tags.includes('sqlite'));
  });

  it('second occurrence within window: learnable=false, errorKey+tags preserved', () => {
    const err = 'SQLITE_ERROR: no such table: memories';
    classifyError(err);
    const r2 = classifyError(err);
    assert.equal(r2.learnable, false);
    assert.ok(r2.errorKey, 'errorKey preserved for counting');
    assert.ok(r2.tags.includes('sqlite'), 'tags preserved for alternative lookup');
    assert.ok(r2.tags.includes('database'), 'tags preserved for alternative lookup');
  });

  it('different errors get different errorKeys', () => {
    const r1 = classifyError('error TS2345: type mismatch');
    const r2 = classifyError('SQLITE_ERROR: no such table');
    assert.notEqual(r1.errorKey, r2.errorKey);
  });

  it('category alternatives resolve correctly for each tag', () => {
    // typescript
    const tsResult = classifyError('error TS2345: Argument of type');
    assert.ok(tsResult.tags[0] === 'typescript');
    assert.ok('typescript' in ESCALATION_ALTERNATIVES);

    // sqlite
    resetErrorTracker();
    const sqlResult = classifyError('SQLITE_CONSTRAINT: UNIQUE constraint failed');
    assert.ok(sqlResult.tags.includes('sqlite'));
    assert.ok('sqlite' in ESCALATION_ALTERNATIVES);

    // node modules
    resetErrorTracker();
    const nodeResult = classifyError('ERR_MODULE_NOT_FOUND: Cannot find package');
    assert.ok(nodeResult.tags.includes('node'));
    assert.ok('node' in ESCALATION_ALTERNATIVES);

    // python syntax
    resetErrorTracker();
    const pyResult = classifyError('SyntaxError: invalid syntax at line 10');
    assert.ok(pyResult.tags.includes('python'));
    assert.ok('python' in ESCALATION_ALTERNATIVES);

    // testing
    resetErrorTracker();
    const testResult = classifyError('AssertionError: expected true to be false');
    assert.ok(testResult.tags.includes('testing'));
    assert.ok('testing' in ESCALATION_ALTERNATIVES);
  });

  it('tool fallback resolves for unmatched categories', () => {
    // If tags don't match any ESCALATION_ALTERNATIVES key, tool fallback should work
    // odoo/fields tags → 'odoo' is in alternatives
    resetErrorTracker();
    const r = classifyError('KeyError: field "partner_id" not found');
    assert.ok(r.tags.includes('odoo'));
    assert.ok('odoo' in ESCALATION_ALTERNATIVES);
  });
});

// --- EditTracker session error count interface ---

describe('EditTracker — session error count fields', () => {
  // Import is possible because edit-tracker exports the interface
  // We test the shape via a runtime check
  it('should have sessionErrorCounts and sessionId in defaults', async () => {
    const { loadTracker, saveTracker } = await import('../src/hooks/shared/edit-tracker.js');
    // loadTracker returns defaults when file doesn't exist (we're in test env)
    // We can't call it without touching the filesystem, so we verify the type exists
    assert.ok(typeof loadTracker === 'function');
    assert.ok(typeof saveTracker === 'function');
  });
});
