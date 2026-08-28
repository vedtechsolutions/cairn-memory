import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parsePlanContent } from '../src/utils/plan-parser.js';

describe('parsePlanContent', () => {
  it('should parse numbered steps with heading', () => {
    const content = `# Plan: Add Authentication

## Overview
Add JWT auth to the API.

## Steps
1. Create auth middleware in src/middleware/auth.ts
2. Add JWT token validation
3. Update API routes to use auth middleware
4. Add login/logout endpoints
5. Write tests

## Notes
Use existing user model.
`;
    const result = parsePlanContent(content);
    assert.ok(result !== null);
    assert.equal(result.name, 'Add Authentication');
    assert.equal(result.steps.length, 5);
    assert.equal(result.steps[0], 'Create auth middleware in src/middleware/auth.ts');
    assert.equal(result.steps[4], 'Write tests');
  });

  it('should parse bold-formatted numbered steps', () => {
    const content = `# Implement Dark Mode

1. **Create theme context** - Add ThemeProvider with light/dark state
2. **Update CSS variables** - Define color tokens for both themes
3. **Add toggle component** - Switch in header nav
4. **Persist preference** - Save to localStorage
`;
    const result = parsePlanContent(content);
    assert.ok(result !== null);
    assert.equal(result.name, 'Implement Dark Mode');
    assert.equal(result.steps.length, 4);
    assert.ok(result.steps[0].includes('Create theme context'));
  });

  it('should parse bullet list steps when no numbered list', () => {
    const content = `# Refactor Database Layer

- Extract connection pool into separate module
- Replace raw SQL with query builder
- Add migration system
- Update all repository classes
`;
    const result = parsePlanContent(content);
    assert.ok(result !== null);
    assert.equal(result.name, 'Refactor Database Layer');
    assert.equal(result.steps.length, 4);
  });

  it('should parse checkbox steps', () => {
    const content = `# Migration Plan

- [ ] Back up existing database
- [ ] Run schema migration
- [x] Update connection strings
- [ ] Verify data integrity
`;
    const result = parsePlanContent(content);
    assert.ok(result !== null);
    assert.equal(result.steps.length, 4);
    assert.equal(result.steps[0], 'Back up existing database');
  });

  it('should strip common plan prefixes from name', () => {
    const content = `# Implementation Plan: OAuth Integration

1. Add OAuth library
2. Configure providers
3. Implement callback handler
`;
    const result = parsePlanContent(content);
    assert.ok(result !== null);
    assert.equal(result.name, 'OAuth Integration');
  });

  it('should handle multi-line step continuations', () => {
    const content = `# Feature Plan

1. Create the data model with all required fields
   including foreign keys and indexes
2. Add API endpoints
3. Write tests
`;
    const result = parsePlanContent(content);
    assert.ok(result !== null);
    assert.equal(result.steps.length, 3);
    assert.ok(result.steps[0].includes('including foreign keys'));
  });

  it('should return null for content without steps', () => {
    const content = `# Meeting Notes

We discussed the architecture but didn't make any decisions yet.
Need to follow up with the team.
`;
    const result = parsePlanContent(content);
    assert.equal(result, null);
  });

  it('should return null for content with only one step', () => {
    const content = `# Quick Fix

1. Update the config file
`;
    const result = parsePlanContent(content);
    assert.equal(result, null);
  });

  it('should truncate long step descriptions to 200 chars', () => {
    const longStep = 'A'.repeat(250);
    const content = `# Plan

1. ${longStep}
2. Short step
`;
    const result = parsePlanContent(content);
    assert.ok(result !== null);
    assert.ok(result.steps[0].length <= 200);
    assert.ok(result.steps[0].endsWith('...'));
  });

  it('should truncate plan name to 100 chars', () => {
    const longName = 'B'.repeat(150);
    const content = `# ${longName}

1. Step one
2. Step two
`;
    const result = parsePlanContent(content);
    assert.ok(result !== null);
    assert.ok(result.name.length <= 100);
  });

  it('should use first non-empty line as name when no heading', () => {
    const content = `Add caching to API responses

1. Evaluate Redis vs in-memory
2. Add cache middleware
3. Configure TTL per endpoint
`;
    const result = parsePlanContent(content);
    assert.ok(result !== null);
    assert.equal(result.name, 'Add caching to API responses');
  });

  it('should handle ## and ### headings', () => {
    const content = `## Optimization Plan

1. Profile slow queries
2. Add database indexes
3. Implement connection pooling
`;
    const result = parsePlanContent(content);
    assert.ok(result !== null);
    assert.equal(result.name, 'Optimization Plan');
    assert.equal(result.steps.length, 3);
  });

  it('should return null for empty content', () => {
    assert.equal(parsePlanContent(''), null);
    assert.equal(parsePlanContent('\n\n'), null);
  });

  it('should reject file metadata as plan name (encoding declaration)', () => {
    const content = `-*- coding: utf-8 -*-
1. Step one
2. Step two
3. Step three`;
    assert.equal(parsePlanContent(content), null);
  });

  it('should reject shebangs as plan name', () => {
    const content = `#!/usr/bin/env python
1. First task
2. Second task`;
    assert.equal(parsePlanContent(content), null);
  });

  it('should reject source code as plan name', () => {
    assert.equal(parsePlanContent('import { foo } from "bar"\n1. Step one\n2. Step two'), null);
    assert.equal(parsePlanContent('export default class Foo\n1. Step one\n2. Step two'), null);
    assert.equal(parsePlanContent('const config = {\n1. Step one\n2. Step two'), null);
    assert.equal(parsePlanContent('"use strict"\n1. Step one\n2. Step two'), null);
  });

  it('should reject comments as plan name', () => {
    assert.equal(parsePlanContent('// This is a comment\n1. Step one\n2. Step two'), null);
    assert.equal(parsePlanContent('/* Block comment */\n1. Step one\n2. Step two'), null);
  });
});
