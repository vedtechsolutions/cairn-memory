import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PROACTIVE, FINGERPRINT, RELEVANCE } from '../src/constants/index.js';

// --- Proactive Warning Constants ---

describe('Proactive Warning Constants', () => {
  it('should have a max of 3 warnings per call', () => {
    assert.equal(PROACTIVE.MAX_WARNINGS_PER_CALL, 3);
  });

  it('should have a 30s rapid re-edit window', () => {
    assert.equal(PROACTIVE.RAPID_REEDIT_MS, 30_000);
  });

  it('should have session error confidence floor below normal floor', () => {
    assert.ok(
      PROACTIVE.SESSION_ERROR_CONFIDENCE_FLOOR < RELEVANCE.MIN_CONFIDENCE_FOR_PITFALL,
      `Session floor ${PROACTIVE.SESSION_ERROR_CONFIDENCE_FLOOR} should be below normal ${RELEVANCE.MIN_CONFIDENCE_FOR_PITFALL}`,
    );
  });

  it('should include MultiEdit in TOOLS list', () => {
    assert.ok(PROACTIVE.TOOLS.includes('MultiEdit'));
  });

  it('should include the 4 write/edit/exec tool types', () => {
    // Read was removed in chunk 9 of the v5 performance work: it was a
    // read-only op with no mutation risk, so firing a full pitfall-check on
    // every Read invocation cost ~30% of hook overhead for essentially no
    // SNR value. Pitfalls now fire only on Write/Edit/MultiEdit/Bash.
    for (const tool of ['Write', 'Edit', 'MultiEdit', 'Bash']) {
      assert.ok(PROACTIVE.TOOLS.includes(tool), `Missing ${tool}`);
    }
    assert.ok(!PROACTIVE.TOOLS.includes('Read'), 'Read must not be in PROACTIVE.TOOLS');
  });

  it('should have decision confidence threshold above pitfall threshold', () => {
    assert.ok(
      PROACTIVE.MIN_DECISION_CONFIDENCE >= RELEVANCE.MIN_CONFIDENCE_FOR_PITFALL,
      'Decisions need higher confidence to surface than pitfalls',
    );
  });
});

// --- Loop Detection Logic ---
// We test the exported detectEditFailLoop pattern by recreating the logic

interface ChainEvent {
  tool: string;
  file?: string;
  success: boolean;
  timestamp: number;
}

function detectEditFailLoop(chain: ChainEvent[], filePath: string): boolean {
  let sawEdit = false;
  let sawFailAfterEdit = false;

  for (const event of chain) {
    if (!sawEdit) {
      if ((event.tool === 'Edit' || event.tool === 'Write' || event.tool === 'MultiEdit') && event.file === filePath) {
        sawEdit = true;
      }
    } else if (!sawFailAfterEdit) {
      if (!event.success) {
        sawFailAfterEdit = true;
      }
    } else {
      if ((event.tool === 'Edit' || event.tool === 'Write' || event.tool === 'MultiEdit') && event.file === filePath) {
        return true;
      }
    }
  }

  return false;
}

describe('Edit-Fail Loop Detection', () => {
  const FILE = '/src/db/repo.ts';
  const now = Date.now();

  it('should detect Edit→Bash(fail)→Edit pattern', () => {
    const chain: ChainEvent[] = [
      { tool: 'Edit', file: FILE, success: true, timestamp: now - 3000 },
      { tool: 'Bash', file: undefined, success: false, timestamp: now - 2000 },
      { tool: 'Edit', file: FILE, success: true, timestamp: now - 1000 },
    ];
    assert.ok(detectEditFailLoop(chain, FILE));
  });

  it('should detect Write→Bash(fail)→Edit pattern', () => {
    const chain: ChainEvent[] = [
      { tool: 'Write', file: FILE, success: true, timestamp: now - 3000 },
      { tool: 'Bash', file: undefined, success: false, timestamp: now - 2000 },
      { tool: 'Edit', file: FILE, success: true, timestamp: now - 1000 },
    ];
    assert.ok(detectEditFailLoop(chain, FILE));
  });

  it('should NOT detect loop without failure in between', () => {
    const chain: ChainEvent[] = [
      { tool: 'Edit', file: FILE, success: true, timestamp: now - 3000 },
      { tool: 'Bash', file: undefined, success: true, timestamp: now - 2000 },
      { tool: 'Edit', file: FILE, success: true, timestamp: now - 1000 },
    ];
    assert.ok(!detectEditFailLoop(chain, FILE));
  });

  it('should NOT detect loop for different files', () => {
    const chain: ChainEvent[] = [
      { tool: 'Edit', file: FILE, success: true, timestamp: now - 3000 },
      { tool: 'Bash', file: undefined, success: false, timestamp: now - 2000 },
      { tool: 'Edit', file: '/src/other.ts', success: true, timestamp: now - 1000 },
    ];
    assert.ok(!detectEditFailLoop(chain, FILE));
  });

  it('should NOT detect loop from empty chain', () => {
    assert.ok(!detectEditFailLoop([], FILE));
  });

  it('should detect loop with Edit(fail) instead of Bash(fail)', () => {
    const chain: ChainEvent[] = [
      { tool: 'Edit', file: FILE, success: true, timestamp: now - 3000 },
      { tool: 'Edit', file: FILE, success: false, timestamp: now - 2000 },
      { tool: 'Edit', file: FILE, success: true, timestamp: now - 1000 },
    ];
    assert.ok(detectEditFailLoop(chain, FILE));
  });
});

// --- File Path Extraction ---

function extractFilePaths(toolName: string, toolInput: Record<string, unknown>): string[] {
  const paths: string[] = [];
  const fp = (toolInput.file_path ?? toolInput.path) as string | undefined;
  if (fp) paths.push(fp);

  if (toolName === 'MultiEdit' && Array.isArray(toolInput.edits)) {
    for (const edit of toolInput.edits) {
      const editFp = (edit as Record<string, unknown>).file_path as string | undefined;
      if (editFp && !paths.includes(editFp)) paths.push(editFp);
    }
  }

  return paths;
}

describe('File Path Extraction', () => {
  it('should extract file_path from Write/Edit', () => {
    const paths = extractFilePaths('Edit', { file_path: '/src/foo.ts' });
    assert.deepEqual(paths, ['/src/foo.ts']);
  });

  it('should extract from MultiEdit edits array', () => {
    const paths = extractFilePaths('MultiEdit', {
      edits: [
        { file_path: '/src/a.ts', old_string: 'x', new_string: 'y' },
        { file_path: '/src/b.ts', old_string: 'x', new_string: 'y' },
      ],
    });
    assert.deepEqual(paths, ['/src/a.ts', '/src/b.ts']);
  });

  it('should deduplicate MultiEdit paths', () => {
    const paths = extractFilePaths('MultiEdit', {
      edits: [
        { file_path: '/src/a.ts', old_string: 'x', new_string: 'y' },
        { file_path: '/src/a.ts', old_string: 'a', new_string: 'b' },
      ],
    });
    assert.deepEqual(paths, ['/src/a.ts']);
  });

  it('should return empty array for Bash (no file_path)', () => {
    const paths = extractFilePaths('Bash', { command: 'npm test' });
    assert.deepEqual(paths, []);
  });

  it('should handle path field as fallback', () => {
    const paths = extractFilePaths('Read', { path: '/src/foo.ts' });
    assert.deepEqual(paths, ['/src/foo.ts']);
  });
});

// --- Warning Cap ---

describe('Warning Cap', () => {
  it('should cap warnings at MAX_WARNINGS_PER_CALL', () => {
    const allWarnings = ['w1', 'w2', 'w3', 'w4', 'w5'];
    const capped = allWarnings.slice(0, PROACTIVE.MAX_WARNINGS_PER_CALL);
    assert.equal(capped.length, 3);
  });

  it('should preserve order (session warnings first, then pitfalls)', () => {
    const warnings = [
      'This file had 2 error(s) this session',
      'Loop detected: you have edited this file',
      'Use parameterized queries',
    ];
    const capped = warnings.slice(0, PROACTIVE.MAX_WARNINGS_PER_CALL);
    assert.equal(capped[0], 'This file had 2 error(s) this session');
    assert.equal(capped[2], 'Use parameterized queries');
  });
});

// --- Confidence Floor Adjustment ---

describe('Confidence Floor Adjustment', () => {
  it('session error floor should allow auto-detected pitfalls (0.4) through', () => {
    assert.ok(
      PROACTIVE.SESSION_ERROR_CONFIDENCE_FLOOR <= 0.4,
      `Floor ${PROACTIVE.SESSION_ERROR_CONFIDENCE_FLOOR} should be <= auto-detected confidence 0.4`,
    );
  });

  it('normal floor should exclude auto-detected pitfalls', () => {
    assert.ok(
      RELEVANCE.MIN_CONFIDENCE_FOR_PITFALL > 0.4,
      `Normal floor ${RELEVANCE.MIN_CONFIDENCE_FOR_PITFALL} should exclude auto-detected 0.4`,
    );
  });
});

// --- Integration: Fingerprint MIN_SCORE threshold ---

describe('Fingerprint MIN_SCORE consistency', () => {
  it('MIN_SCORE should be between 0.1 and 0.3', () => {
    assert.ok(FINGERPRINT.MIN_SCORE >= 0.1, 'Too low — would surface noise');
    assert.ok(FINGERPRINT.MIN_SCORE <= 0.3, 'Too high — would miss relevant pitfalls');
  });
});

// --- Content-Aware Matching ---

function extractCodeContent(toolName: string, toolInput: Record<string, unknown>): string | null {
  const maxChars = PROACTIVE.CONTENT_QUERY_MAX_CHARS;

  if (toolName === 'Edit') {
    const newStr = toolInput.new_string as string | undefined;
    return newStr ? newStr.slice(0, maxChars) : null;
  }

  if (toolName === 'Write') {
    const content = toolInput.content as string | undefined;
    return content ? content.slice(0, maxChars) : null;
  }

  if (toolName === 'MultiEdit' && Array.isArray(toolInput.edits)) {
    const parts: string[] = [];
    let total = 0;
    for (const edit of toolInput.edits) {
      const newStr = (edit as Record<string, unknown>).new_string as string | undefined;
      if (newStr && total < maxChars) {
        const chunk = newStr.slice(0, maxChars - total);
        parts.push(chunk);
        total += chunk.length;
      }
    }
    return parts.length > 0 ? parts.join(' ') : null;
  }

  return null;
}

describe('Content-Aware Code Extraction', () => {
  it('should extract new_string from Edit tool', () => {
    const content = extractCodeContent('Edit', {
      file_path: '/src/parser.ts',
      old_string: 'const x = 1;',
      new_string: 'const entry = JSON.parse(line);\nconst content = entry.message.content;',
    });
    assert.ok(content);
    assert.ok(content!.includes('entry.message.content'));
  });

  it('should extract content from Write tool', () => {
    const content = extractCodeContent('Write', {
      file_path: '/src/new-file.ts',
      content: 'import { readFileSync } from "fs";\nconst data = JSON.parse(readFileSync(path));',
    });
    assert.ok(content);
    assert.ok(content!.includes('readFileSync'));
  });

  it('should extract from MultiEdit edits array', () => {
    const content = extractCodeContent('MultiEdit', {
      edits: [
        { file_path: '/src/a.ts', new_string: 'function parseEntry(entry) {' },
        { file_path: '/src/b.ts', new_string: 'return entry.type;' },
      ],
    });
    assert.ok(content);
    assert.ok(content!.includes('parseEntry'));
    assert.ok(content!.includes('entry.type'));
  });

  it('should return null for Bash (no code content)', () => {
    const content = extractCodeContent('Bash', { command: 'npm test' });
    assert.equal(content, null);
  });

  it('should return null for Read', () => {
    const content = extractCodeContent('Read', { file_path: '/src/foo.ts' });
    assert.equal(content, null);
  });

  it('should truncate to CONTENT_QUERY_MAX_CHARS', () => {
    const longContent = 'x'.repeat(1000);
    const content = extractCodeContent('Edit', {
      file_path: '/src/foo.ts',
      old_string: '',
      new_string: longContent,
    });
    assert.ok(content);
    assert.equal(content!.length, PROACTIVE.CONTENT_QUERY_MAX_CHARS);
  });

  it('should return null when new_string is absent', () => {
    const content = extractCodeContent('Edit', { file_path: '/src/foo.ts' });
    assert.equal(content, null);
  });
});

// --- Surface Dedup ---

describe('Surface Dedup Constants', () => {
  it('should have a 5 minute cooldown', () => {
    assert.equal(PROACTIVE.SURFACE_COOLDOWN_MS, 300_000);
  });

  it('should suppress after 5 surfaces with 0 impact', () => {
    assert.equal(PROACTIVE.UNPROVEN_SURFACE_THRESHOLD, 5);
  });

  it('content query max chars should be reasonable', () => {
    assert.ok(PROACTIVE.CONTENT_QUERY_MAX_CHARS >= 100, 'Too small for meaningful matching');
    assert.ok(PROACTIVE.CONTENT_QUERY_MAX_CHARS <= 500, 'Too large — wastes FTS processing');
  });
});

describe('Surface Dedup Logic', () => {
  it('should skip pitfall surfaced within cooldown window', () => {
    const now = Date.now();
    const recentlySurfaced: Record<string, number> = { 'mem-1': now - 60_000 }; // 1 min ago
    const withinCooldown = (now - (recentlySurfaced['mem-1'] ?? 0)) < PROACTIVE.SURFACE_COOLDOWN_MS;
    assert.ok(withinCooldown, 'Should be within cooldown');
  });

  it('should allow pitfall surfaced outside cooldown window', () => {
    const now = Date.now();
    const recentlySurfaced: Record<string, number> = { 'mem-1': now - 400_000 }; // 6.6 min ago
    const withinCooldown = (now - (recentlySurfaced['mem-1'] ?? 0)) < PROACTIVE.SURFACE_COOLDOWN_MS;
    assert.ok(!withinCooldown, 'Should be outside cooldown');
  });

  it('should skip unproven pitfall (5+ surfaces, 0 impact)', () => {
    const memory = { surface_count: 6, impact_count: 0 };
    const isUnproven = memory.surface_count >= PROACTIVE.UNPROVEN_SURFACE_THRESHOLD && memory.impact_count === 0;
    assert.ok(isUnproven, 'Should be flagged as unproven');
  });

  it('should NOT skip pitfall with some impact', () => {
    const memory = { surface_count: 10, impact_count: 1 };
    const isUnproven = memory.surface_count >= PROACTIVE.UNPROVEN_SURFACE_THRESHOLD && memory.impact_count === 0;
    assert.ok(!isUnproven, 'Should NOT be flagged — has impact');
  });

  it('should NOT skip low-surface pitfall even with 0 impact', () => {
    const memory = { surface_count: 3, impact_count: 0 };
    const isUnproven = memory.surface_count >= PROACTIVE.UNPROVEN_SURFACE_THRESHOLD && memory.impact_count === 0;
    assert.ok(!isUnproven, 'Too few surfaces to judge');
  });
});

// --- Phase 3: Action-Triggered Recall ---

import { openDatabase } from '../src/db/connection.js';
import { InvestigationRepository } from '../src/db/investigation-repository.js';

describe('Phase 3: Action-Triggered Recall Constants', () => {
  it('should allow 2 decisions per tool call', () => {
    assert.equal(PROACTIVE.MAX_DECISIONS, 2);
  });

  it('should allow 1 investigation chain per tool call', () => {
    assert.equal(PROACTIVE.MAX_INVESTIGATION_CHAINS, 1);
  });
});

describe('Phase 3: Investigation Chain Surfacing', () => {
  it('should surface active chain for current session', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    const repo = new InvestigationRepository(db);

    repo.create('proj', 'sess-1', 'TypeError on handler.ts', {
      approach: 'Edit on handler.ts', outcome: 'TypeError', timestamp: new Date().toISOString(),
    });

    const active = repo.getActiveChain('proj', 'sess-1');
    assert.ok(active, 'should have active chain');

    // Simulate the warning format from pitfall-check.ts
    const approaches = active!.attempts.slice(-3).map(a => a.approach).join(', ');
    const warning = `Active investigation: "${active!.trigger_error.slice(0, 60)}" — tried: ${approaches}`;
    assert.ok(warning.includes('TypeError'), 'warning should include trigger');
    assert.ok(warning.includes('Edit on handler.ts'), 'warning should include approach');
    db.close();
  });

  it('should surface recently resolved chain when no active chain', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    const repo = new InvestigationRepository(db);

    const chain = repo.create('proj', 'sess-old', 'ImportError', {
      approach: 'Edit on imports.ts', outcome: 'fail', timestamp: new Date().toISOString(),
    });
    repo.resolve(chain.id, 'Fixed via package.json — added missing dep');

    // No active chain for current session
    const active = repo.getActiveChain('proj', 'sess-new');
    assert.equal(active, null);

    // But resolved chain surfaces
    const resolved = repo.getRecentResolved('proj', PROACTIVE.MAX_INVESTIGATION_CHAINS);
    assert.equal(resolved.length, 1);

    const warning = `Prior investigation: "${resolved[0].trigger_error.slice(0, 60)}" → ${resolved[0].resolution!.slice(0, 80)}`;
    assert.ok(warning.includes('ImportError'), 'should include trigger');
    assert.ok(warning.includes('missing dep'), 'should include resolution');
    db.close();
  });

  it('should not surface chains from other projects', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    const repo = new InvestigationRepository(db);

    repo.create('other-proj', 'sess-1', 'Error in other project', {
      approach: 'Edit', outcome: 'fail', timestamp: new Date().toISOString(),
    });

    const active = repo.getActiveChain('my-proj', 'sess-1');
    assert.equal(active, null);

    const resolved = repo.getRecentResolved('my-proj', 5);
    assert.equal(resolved.length, 0);
    db.close();
  });
});
