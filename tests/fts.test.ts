import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildFtsQuery } from '../src/utils/fts.js';

describe('buildFtsQuery — shared FTS5 query builder', () => {
  it('should return quoted OR-joined terms', () => {
    const result = buildFtsQuery('python import error handling');
    assert.ok(result);
    assert.ok(result.includes('"python"'));
    assert.ok(result.includes('"import"'));
    assert.ok(result.includes('"error"'));
    assert.ok(result.includes(' OR '));
  });

  it('should filter stopwords by default', () => {
    const result = buildFtsQuery('the and for not with');
    // All words are stopwords — should return null
    assert.equal(result, null);
  });

  it('should keep stopwords when filterStopwords is false', () => {
    const result = buildFtsQuery('the quick brown fox', { filterStopwords: false });
    assert.ok(result);
    assert.ok(result.includes('"the"'));
    assert.ok(result.includes('"quick"'));
  });

  it('should respect maxTerms', () => {
    const result = buildFtsQuery('one two three four five six seven eight nine ten', { maxTerms: 3 });
    assert.ok(result);
    const termCount = result.split(' OR ').length;
    assert.equal(termCount, 3);
  });

  it('should return null for empty input', () => {
    assert.equal(buildFtsQuery(''), null);
    assert.equal(buildFtsQuery('   '), null);
  });

  it('should strip special characters', () => {
    const result = buildFtsQuery('error: SyntaxError (line 42)');
    assert.ok(result);
    // Should not contain colons or parens
    assert.ok(!result.includes(':'));
    assert.ok(!result.includes('('));
  });

  it('should filter words with 2 or fewer characters', () => {
    const result = buildFtsQuery('a b cd python');
    assert.ok(result);
    // Only 'python' should survive (cd is 2 chars, filtered)
    assert.ok(result.includes('"python"'));
    assert.ok(!result.includes('"a"'));
    assert.ok(!result.includes('"b"'));
  });

  it('should default to max 8 terms', () => {
    const words = Array.from({ length: 15 }, (_, i) => `keyword${i}`);
    const result = buildFtsQuery(words.join(' '));
    assert.ok(result);
    const termCount = result.split(' OR ').length;
    assert.equal(termCount, 8);
  });
});
