import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type Database from 'better-sqlite3';
import { openDatabase } from '../src/db/connection.js';
import { MemoryRepository } from '../src/db/memory-repository.js';
import { parseMarkdown } from '../src/utils/markdown-parser.js';

let db: Database.Database;
let repo: MemoryRepository;

beforeEach(() => {
  db = openDatabase({ dbPath: ':memory:' });
  repo = new MemoryRepository(db);
});

afterEach(() => {
  db.close();
});

// =============================================================================
// cairn_ingest — Markdown Parser
// =============================================================================

describe('Markdown Parser', () => {
  it('should parse sections with kind prefixes', () => {
    const md = `
## Pitfall: Never use raw SQL
tags: odoo, orm
Always use ORM methods instead.

## Decision: Use XML-RPC for integrations
tags: api
XML-RPC is the documented standard.

## Correction: field is computed not stored
The amount_total field is computed.

## Fact: Odoo uses LGPL license
Open source license.
`.trim();

    const result = parseMarkdown(md);
    assert.equal(result.sections.length, 4);
    assert.equal(result.errors.length, 0);

    assert.equal(result.sections[0].kind, 'pitfall');
    assert.deepEqual(result.sections[0].tags, ['odoo', 'orm']);
    assert.ok(result.sections[0].content.includes('Never use raw SQL'));
    assert.ok(result.sections[0].content.includes('Always use ORM'));

    assert.equal(result.sections[1].kind, 'decision');
    assert.deepEqual(result.sections[1].tags, ['api']);

    assert.equal(result.sections[2].kind, 'correction');
    assert.deepEqual(result.sections[2].tags, []);

    assert.equal(result.sections[3].kind, 'fact');
  });

  it('should default to fact when no kind prefix', () => {
    const md = `## Some random heading\nSome content here.`;
    const result = parseMarkdown(md);
    assert.equal(result.sections.length, 1);
    assert.equal(result.sections[0].kind, 'fact');
    assert.ok(result.sections[0].content.includes('Some random heading'));
  });

  it('should handle tags line parsing', () => {
    const md = `## Pitfall: Check field access\ntags: python, orm, migration\nBody text.`;
    const result = parseMarkdown(md);
    assert.equal(result.sections.length, 1);
    assert.deepEqual(result.sections[0].tags, ['python', 'orm', 'migration']);
    // Tags line should NOT appear in content body
    assert.ok(!result.sections[0].content.includes('python, orm, migration'));
    assert.ok(result.sections[0].content.includes('Body text'));
  });

  it('should handle heading-only sections as valid', () => {
    const md = `## Pitfall: Has content\nSome body.\n\n## Pitfall: Heading only note\n\n## Pitfall: Also has content\nMore body.`;
    const result = parseMarkdown(md);
    // All 3 are valid — heading-only sections use heading as content
    assert.equal(result.sections.length, 3);
    assert.equal(result.errors.length, 0);
    assert.ok(result.sections[1].content.includes('Heading only note'));
  });

  it('should return error for no headings', () => {
    const md = `Just some plain text without any headings.`;
    const result = parseMarkdown(md);
    assert.equal(result.sections.length, 0);
    assert.equal(result.errors.length, 1);
    assert.ok(result.errors[0].error.includes('No ## headings'));
  });

  it('should strip confidence markers from export round-trip', () => {
    const md = `## Pitfall: Never use raw SQL [confidence: 0.85]\ntags: odoo\nUse ORM instead.`;
    const result = parseMarkdown(md);
    assert.equal(result.sections.length, 1);
    assert.ok(!result.sections[0].content.includes('[confidence:'));
    assert.ok(result.sections[0].content.includes('Never use raw SQL'));
  });

  it('should cap tags at MAX_TAGS', () => {
    const md = `## Fact: Many tags\ntags: a, b, c, d, e, f, g, h\nContent.`;
    const result = parseMarkdown(md);
    assert.equal(result.sections.length, 1);
    assert.ok(result.sections[0].tags.length <= 5);
  });

  it('should handle content exceeding max chars', () => {
    const longContent = 'x'.repeat(2100);
    const md = `## Fact: Too long\n${longContent}`;
    const result = parseMarkdown(md);
    assert.equal(result.sections.length, 0);
    assert.equal(result.errors.length, 1);
    assert.ok(result.errors[0].error.includes('exceeds max'));
  });
});

// =============================================================================
// cairn_ingest — Integration with MemoryRepository
// =============================================================================

describe('Ingest Integration', () => {
  it('should create memories from parsed markdown', () => {
    const md = `
## Pitfall: Never use raw SQL in Odoo
tags: odoo, orm
Always use ORM methods.

## Decision: Use XML-RPC
tags: api
The documented standard.
`.trim();

    const { sections } = parseMarkdown(md);
    const results = sections.map(s =>
      repo.create({
        content: s.content,
        kind: s.kind,
        tags: s.tags,
        project: 'test-proj',
      })
    );

    assert.equal(results.length, 2);
    assert.equal(results[0].deduplicated, false);
    assert.equal(results[1].deduplicated, false);

    // Verify in DB
    const recalled = repo.recall('SQL ORM odoo', { project: 'test-proj' });
    assert.ok(recalled.length > 0);
    assert.ok(recalled[0].memory.content.includes('Never use raw SQL'));
  });

  it('should deduplicate on ingest of overlapping content', () => {
    // First ingest
    repo.create({
      content: 'Never use raw SQL in Odoo models — use ORM methods',
      kind: 'pitfall',
      tags: ['odoo'],
      project: 'test-proj',
    });

    // Parse markdown with similar content
    const md = `## Pitfall: Never use raw SQL in Odoo models\ntags: odoo, orm\nUse ORM methods instead of raw SQL.`;
    const { sections } = parseMarkdown(md);
    const result = repo.create({
      content: sections[0].content,
      kind: sections[0].kind,
      tags: sections[0].tags,
      project: 'test-proj',
    });

    assert.equal(result.deduplicated, true);
  });
});

// =============================================================================
// cairn_export — Memory Export
// =============================================================================

describe('Export Memories', () => {
  it('should export all memories grouped by kind', () => {
    repo.create({ content: 'Pitfall one', kind: 'pitfall', project: 'test-proj' });
    repo.create({ content: 'Decision one', kind: 'decision', project: 'test-proj' });
    repo.create({ content: 'Fact one', kind: 'fact', project: 'test-proj' });

    const exported = repo.exportMemories({ project: 'test-proj' });
    assert.equal(exported.length, 3);
    // Should be sorted by kind order from query, then confidence
  });

  it('should filter by kind', () => {
    repo.create({ content: 'Pitfall one', kind: 'pitfall', project: 'test-proj' });
    repo.create({ content: 'Decision one', kind: 'decision', project: 'test-proj' });

    const exported = repo.exportMemories({ project: 'test-proj', kind: 'pitfall' });
    assert.equal(exported.length, 1);
    assert.equal(exported[0].kind, 'pitfall');
  });

  it('should filter by min_confidence', () => {
    repo.create({ content: 'Low confidence', kind: 'pitfall', project: 'test-proj', confidence: 0.2 });
    repo.create({ content: 'High confidence', kind: 'pitfall', project: 'test-proj', confidence: 0.9 });

    const exported = repo.exportMemories({ project: 'test-proj', minConfidence: 0.5 });
    assert.equal(exported.length, 1);
    assert.equal(exported[0].content, 'High confidence');
  });

  it('should exclude invalidated memories', () => {
    const { id } = repo.create({ content: 'Will be invalidated', kind: 'pitfall', project: 'test-proj' });
    repo.create({ content: 'Still valid', kind: 'pitfall', project: 'test-proj' });
    repo.invalidate(id);

    const exported = repo.exportMemories({ project: 'test-proj' });
    assert.equal(exported.length, 1);
    assert.equal(exported[0].content, 'Still valid');
  });

  it('should exclude task_state kind', () => {
    // task_state can only be created via direct DB insert (not learnable)
    db.prepare(`
      INSERT INTO memories (id, content, kind, project, tags, confidence, source, created_at, recall_count, invalidated)
      VALUES ('ts1', 'task state', 'task_state', 'test-proj', '[]', 0.5, 'learned', '2026-01-01', 0, 0)
    `).run();
    repo.create({ content: 'Normal fact', kind: 'fact', project: 'test-proj' });

    const exported = repo.exportMemories({ project: 'test-proj' });
    assert.equal(exported.length, 1);
    assert.equal(exported[0].kind, 'fact');
  });

  it('should include global memories when filtering by project', () => {
    repo.create({ content: 'Global correction', kind: 'correction', project: null });
    repo.create({ content: 'Project pitfall', kind: 'pitfall', project: 'test-proj' });

    const exported = repo.exportMemories({ project: 'test-proj' });
    assert.equal(exported.length, 2);
  });
});

// =============================================================================
// cairn_promote — Cross-Project Promotion
// =============================================================================

describe('Promote to Global', () => {
  it('should promote a project-scoped pitfall to global', () => {
    const { id } = repo.create({
      content: 'Always check field access in inherited models',
      kind: 'pitfall',
      project: 'test-proj',
      confidence: 0.8,
    });

    const ok = repo.promote(id);
    assert.equal(ok, true);

    const mem = repo.findById(id);
    assert.ok(mem);
    assert.equal(mem.project, null);
  });

  it('should fail to promote non-existent memory', () => {
    const ok = repo.promote('nonexistent-id');
    assert.equal(ok, false);
  });

  it('should not promote already-global memory', () => {
    const { id } = repo.create({
      content: 'Already global correction',
      kind: 'correction',
      project: null,
    });

    const ok = repo.promote(id);
    assert.equal(ok, false); // project IS NOT NULL guard fails
  });

  it('should not promote invalidated memory', () => {
    const { id } = repo.create({
      content: 'Will be invalidated',
      kind: 'pitfall',
      project: 'test-proj',
      confidence: 0.8,
    });
    repo.invalidate(id);

    const ok = repo.promote(id);
    assert.equal(ok, false);
  });

  it('should be visible in all projects after promotion', () => {
    const { id } = repo.create({
      content: 'Universal pitfall about field access and inherited models',
      kind: 'pitfall',
      project: 'project-a',
      confidence: 0.8,
    });

    repo.promote(id);

    // Should now appear in project-b recall
    const results = repo.recall('field access inherited models', { project: 'project-b' });
    assert.ok(results.length > 0);
    assert.equal(results[0].memory.id, id);
    assert.equal(results[0].memory.project, null);
  });
});

// =============================================================================
// Round-trip: Export → Ingest
// =============================================================================

describe('Export-Ingest Round Trip', () => {
  it('should produce ingestable markdown from export', () => {
    // Create some memories
    repo.create({
      content: 'Never use raw SQL: Always use ORM methods',
      kind: 'pitfall',
      tags: ['odoo', 'orm'],
      project: 'test-proj',
      confidence: 0.8,
    });
    repo.create({
      content: 'Use XML-RPC for integrations: Documented standard',
      kind: 'decision',
      tags: ['api'],
      project: 'test-proj',
      confidence: 0.7,
    });

    // Export
    const memories = repo.exportMemories({ project: 'test-proj' });
    assert.equal(memories.length, 2);

    // Build markdown (simulating what the tool produces)
    const lines: string[] = [];
    for (const m of memories) {
      const prefix = m.kind.charAt(0).toUpperCase() + m.kind.slice(1);
      lines.push(`## ${prefix}: ${m.content.split(':')[0].trim()} [confidence: ${m.confidence.toFixed(2)}]`);
      if (m.tags.length > 0) lines.push(`tags: ${m.tags.join(', ')}`);
      const colonIdx = m.content.indexOf(':');
      if (colonIdx !== -1) lines.push(m.content.slice(colonIdx + 1).trim());
      lines.push('');
    }
    const exportedMd = lines.join('\n');

    // Parse the exported markdown
    const parsed = parseMarkdown(exportedMd);
    assert.equal(parsed.errors.length, 0);
    assert.equal(parsed.sections.length, 2);

    // Ingest into fresh DB should deduplicate (same content exists)
    for (const section of parsed.sections) {
      const result = repo.create({
        content: section.content,
        kind: section.kind,
        tags: section.tags,
        project: 'test-proj',
      });
      assert.equal(result.deduplicated, true, `Expected dedup for: ${section.content.slice(0, 50)}`);
    }
  });
});
