import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractPathConcepts } from '../src/utils/path-concepts.js';

describe('extractPathConcepts', () => {
  it('should extract concepts from a typical file path', () => {
    const concepts = extractPathConcepts('src/auth/oauth_handler.py');
    assert.ok(concepts.includes('auth'));
    assert.ok(concepts.includes('oauth'));
    assert.ok(concepts.includes('handler'));
    assert.ok(!concepts.includes('src')); // stopword
    assert.ok(concepts.includes('py'));   // 2 chars now allowed (>= 2)
  });

  it('should handle camelCase filenames', () => {
    const concepts = extractPathConcepts('src/OAuthHandler.ts');
    assert.ok(concepts.includes('auth'));
    assert.ok(concepts.includes('handler'));
    assert.ok(concepts.includes('ts'));
  });

  it('should handle lowercase camelCase', () => {
    const concepts = extractPathConcepts('src/oauthCallback.ts');
    assert.ok(concepts.includes('oauth'));
    assert.ok(concepts.includes('callback'));
  });

  it('should filter only generic stopwords', () => {
    const concepts = extractPathConcepts('src/lib/index.ts');
    // src, lib, index are stopwords; 'ts' (2 chars) passes the length filter
    assert.ok(!concepts.includes('src'));
    assert.ok(!concepts.includes('lib'));
    assert.ok(!concepts.includes('index'));
    assert.ok(concepts.includes('ts'));
  });

  it('should preserve architectural directory names', () => {
    const concepts = extractPathConcepts('src/hooks/shared/db-client.ts');
    assert.ok(concepts.includes('hooks'), 'hooks should not be filtered');
    assert.ok(concepts.includes('db'), 'db (2 chars) should not be filtered');
    assert.ok(concepts.includes('shared'));
    assert.ok(concepts.includes('client'));
  });

  it('should preserve views, models, controllers, utils', () => {
    const concepts = extractPathConcepts('src/views/controllers/models/utils/helper.ts');
    assert.ok(concepts.includes('views'));
    assert.ok(concepts.includes('controllers'));
    assert.ok(concepts.includes('models'));
    assert.ok(concepts.includes('utils'));
    assert.ok(concepts.includes('helper'));
  });

  it('should handle deeply nested paths', () => {
    const concepts = extractPathConcepts('packages/billing/stripe/payment-processor.ts');
    assert.ok(concepts.includes('billing'));
    assert.ok(concepts.includes('stripe'));
    assert.ok(concepts.includes('payment'));
    assert.ok(concepts.includes('processor'));
  });

  it('should deduplicate', () => {
    const concepts = extractPathConcepts('auth/auth_manager.ts');
    const authCount = concepts.filter(c => c === 'auth').length;
    assert.equal(authCount, 1);
  });

  it('should handle dotfiles and extensions', () => {
    const concepts = extractPathConcepts('src/database/connection.ts');
    assert.ok(concepts.includes('database'));
    assert.ok(concepts.includes('connection'));
  });

  it('should handle Windows-style paths', () => {
    const concepts = extractPathConcepts('src\\auth\\oauth_handler.py');
    assert.ok(concepts.includes('auth'));
    assert.ok(concepts.includes('oauth'));
  });
});
