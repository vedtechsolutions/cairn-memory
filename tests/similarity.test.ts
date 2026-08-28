import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tokenOverlap } from '../src/utils/similarity.js';

describe('tokenOverlap (with bigram boost)', () => {
  it('should return 1 for identical strings', () => {
    assert.equal(tokenOverlap('hello world', 'hello world'), 1);
  });

  it('should return 0 for completely different strings', () => {
    assert.equal(tokenOverlap('apple banana', 'cherry grape'), 0);
  });

  it('should detect paraphrased content via bigrams', () => {
    // These have low unigram overlap but share bigrams
    const a = 'kanban template name changed from kanban-box to kanban-card';
    const b = 'kanban layout uses t-name card not kanban-box or kanban-card';
    const score = tokenOverlap(a, b);
    // With bigrams, these should score higher than pure unigram
    assert.ok(score > 0.2, `Expected > 0.2, got ${score}`);
  });

  it('should catch near-duplicate pitfalls', () => {
    const a = 'CSRF protection: All POST forms MUST include CSRF token';
    const b = 'POST routes require CSRF token by default. Disable only for webhooks';
    const score = tokenOverlap(a, b);
    assert.ok(score > 0.15, `Expected > 0.15, got ${score}`);
  });

  it('should score high for very similar content', () => {
    const a = 'Use t-out instead of t-esc in QWeb templates';
    const b = 't-esc is deprecated in QWeb, use t-out instead';
    const score = tokenOverlap(a, b);
    assert.ok(score > 0.4, `Expected > 0.4, got ${score}`);
  });

  it('should handle empty strings', () => {
    assert.equal(tokenOverlap('', ''), 1);
    assert.equal(tokenOverlap('hello', ''), 0);
    assert.equal(tokenOverlap('', 'hello'), 0);
  });
});
