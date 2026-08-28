import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { passesSameProjectRelevance } from '../src/utils/cross-project-guard.js';
import type { ContextFingerprint } from '../src/utils/fingerprint.js';

function fp(lang: string[] = [], framework: string[] = [], module: string[] = []): ContextFingerprint {
  return { lang, framework, module };
}

// Current edit: tests/plan.test.ts (module = [tests, plan, test])
const queryEditingTestFile = fp(['typescript'], ['node'], ['tests', 'plan', 'test']);

// Current edit: src/db/connection.ts (module = [db, connection])
const queryEditingConnection = fp(['typescript'], ['node'], ['db', 'connection']);

// Session-start / bash: no filePath, no module dim
const queryBroad = fp(['typescript'], ['node'], []);

describe('passesSameProjectRelevance — file-specific queries', () => {
  it('blocks connection-authored pitfall when editing unrelated test file (the regression)', () => {
    const mem = {
      fingerprint: fp(['typescript'], ['node'], ['db', 'connection']),
      anchor: JSON.stringify({ files: ['src/db/connection.ts'] }),
    };
    assert.equal(
      passesSameProjectRelevance(mem, queryEditingTestFile, 'tests/plan.test.ts'),
      false,
      'connection.ts schema pitfall must not fire on tests/plan.test.ts',
    );
  });

  it('allows connection-authored pitfall when editing connection.ts (anchor match)', () => {
    const mem = {
      fingerprint: fp(['typescript'], ['node'], ['db', 'connection']),
      anchor: JSON.stringify({ files: ['src/db/connection.ts'] }),
    };
    assert.equal(
      passesSameProjectRelevance(mem, queryEditingConnection, 'src/db/connection.ts'),
      true,
    );
  });

  it('allows cross-file pitfall via module overlap (both in db layer)', () => {
    const mem = {
      fingerprint: fp(['typescript'], ['node'], ['db', 'repository']),
      anchor: null,
    };
    // Editing src/db/connection.ts, memory from src/db/memory-repository.ts
    assert.equal(
      passesSameProjectRelevance(mem, queryEditingConnection, 'src/db/connection.ts'),
      true,
      'db+db module intersection should pass',
    );
  });

  it('blocks pitfall with module mismatch on file-specific query', () => {
    const mem = {
      fingerprint: fp(['typescript'], ['node'], ['hooks', 'handlers']),
      anchor: null,
    };
    // Editing tests/plan.test.ts — no module overlap with hooks/handlers
    assert.equal(
      passesSameProjectRelevance(mem, queryEditingTestFile, 'tests/plan.test.ts'),
      false,
    );
  });

  it('blocks broad memory (no module, no anchor) on file-specific query', () => {
    const mem = { fingerprint: fp(['typescript'], [], []), anchor: null };
    assert.equal(
      passesSameProjectRelevance(mem, queryEditingTestFile, 'tests/plan.test.ts'),
      false,
      'broad memory should not surface on specific edits — symmetric rule',
    );
  });

  it('blocks memory with null fingerprint on file-specific query', () => {
    const mem = { fingerprint: null, anchor: null };
    assert.equal(
      passesSameProjectRelevance(mem, queryEditingTestFile, 'tests/plan.test.ts'),
      false,
    );
  });

  it('allows anchor match by basename even if full path differs', () => {
    const mem = {
      fingerprint: fp(['typescript'], [], ['something', 'else']),
      anchor: JSON.stringify({ files: ['plan.test.ts'] }),
    };
    assert.equal(
      passesSameProjectRelevance(mem, queryEditingTestFile, 'tests/plan.test.ts'),
      true,
      'basename match in anchor JSON should count',
    );
  });
});

describe('passesSameProjectRelevance — broad queries', () => {
  it('passes broad memory on broad query (symmetric)', () => {
    const mem = { fingerprint: fp(['typescript'], [], []), anchor: null };
    assert.equal(passesSameProjectRelevance(mem, queryBroad, null), true);
  });

  it('passes file-specific memory on broad query (no file context to block against)', () => {
    const mem = {
      fingerprint: fp(['typescript'], [], ['db', 'connection']),
      anchor: JSON.stringify({ files: ['src/db/connection.ts'] }),
    };
    assert.equal(
      passesSameProjectRelevance(mem, queryBroad, null),
      true,
      'broad query (SessionStart, plain bash) should not be filtered by same-project gate',
    );
  });

  it('passes null-fingerprint memory on broad query', () => {
    const mem = { fingerprint: null, anchor: null };
    assert.equal(passesSameProjectRelevance(mem, queryBroad, null), true);
  });
});

describe('passesSameProjectRelevance — module-only queries (tag-driven recall)', () => {
  it('requires module intersection when query has module but no filePath', () => {
    const queryModuleOnly = fp(['typescript'], [], ['db']);
    const memNoOverlap = { fingerprint: fp(['typescript'], [], ['hooks']), anchor: null };
    const memOverlap = { fingerprint: fp(['typescript'], [], ['db', 'repository']), anchor: null };

    assert.equal(passesSameProjectRelevance(memNoOverlap, queryModuleOnly, null), false);
    assert.equal(passesSameProjectRelevance(memOverlap, queryModuleOnly, null), true);
  });

  it('blocks broad same-project memory (no module, no anchor) on module-only query', () => {
    // SNR fix: broad memories (empty fingerprint.module, no anchor) must not
    // ride through task-specific briefings. Only true broad↔broad (query
    // also has no module) surfaces broad memories.
    const queryModuleOnly = fp(['typescript'], [], ['db']);
    const memBroad = { fingerprint: fp(['typescript'], [], []), anchor: null };
    assert.equal(passesSameProjectRelevance(memBroad, queryModuleOnly, null), false);
  });

  it('passes null-fingerprint memory with matching anchor on module-only query', () => {
    // Anchor overlap with query modules is a valid relevance signal even
    // when the fingerprint itself is null/empty.
    const queryModuleOnly = fp(['typescript'], [], ['connection', 'db']);
    const mem = { fingerprint: null, anchor: 'src/db/connection.ts' };
    assert.equal(passesSameProjectRelevance(mem, queryModuleOnly, null), true);
  });

  it('blocks null-fingerprint memory with non-matching anchor on module-only query', () => {
    const queryModuleOnly = fp(['typescript'], [], ['connection', 'db']);
    const mem = { fingerprint: null, anchor: 'src/hooks/unrelated.ts' };
    assert.equal(passesSameProjectRelevance(mem, queryModuleOnly, null), false);
  });
});

describe('passesSameProjectRelevance — narrow vs broad module overlap', () => {
  // The exact regression: "PostToolUse hooks must be registered" pitfall
  // stored with fingerprint.module = [hooks, settings, wiring]. On any task
  // whose query fingerprint contains "hooks" (a common token in this repo),
  // the single-token intersection used to pass the relevance gate.
  const leakyPitfall = {
    fingerprint: fp(['typescript'], ['node'], ['hooks', 'settings', 'wiring']),
    anchor: null,
  };

  it('blocks a 3-module pitfall when only ONE query module matches', () => {
    // Task fingerprint from the decision-reflector audit: lots of task
    // tokens, one of which happens to be "hooks".
    const auditQuery = fp(['typescript'], ['node'], [
      'decision', 'reflector', 'stop', 'handler', 'hooks', 'test',
    ]);
    assert.equal(
      passesSameProjectRelevance(leakyPitfall, auditQuery, null),
      false,
      'single-token module overlap should not surface a 3-module broad pitfall',
    );
  });

  it('allows a 3-module pitfall when TWO query modules match', () => {
    const onTopicQuery = fp(['typescript'], ['node'], [
      'hooks', 'settings', 'auth',
    ]);
    assert.equal(
      passesSameProjectRelevance(leakyPitfall, onTopicQuery, null),
      true,
      'two-token overlap is enough evidence even for a broad memory',
    );
  });

  it('still allows a narrow 2-module pitfall on single-token overlap', () => {
    const narrowPitfall = {
      fingerprint: fp(['typescript'], ['node'], ['db', 'repository']),
      anchor: null,
    };
    const dbQuery = fp(['typescript'], ['node'], ['db', 'connection']);
    assert.equal(
      passesSameProjectRelevance(narrowPitfall, dbQuery, null),
      true,
      'narrow (1–2 module) memories should still pass on single-hit',
    );
  });

  it('blocks the leaky pitfall in the file-specific path too', () => {
    const auditQuery = fp(['typescript'], ['node'], [
      'decision', 'reflector', 'stop', 'handler', 'hooks', 'test',
    ]);
    assert.equal(
      passesSameProjectRelevance(leakyPitfall, auditQuery, 'tests/decision-reflector.test.ts'),
      false,
    );
  });
});

describe('passesSameProjectRelevance — undefined filePath (Bash tool calls)', () => {
  // Bash tool calls have no file path: the pitfall handler passes undefined,
  // not null. The gate crashed on `filePath.length` because its no-file check
  // was `!== null`. Undefined must behave exactly like null.
  it('treats undefined filePath as broad query — broad memory passes (the crash regression)', () => {
    const mem = { fingerprint: fp(['typescript'], [], []), anchor: null };
    assert.equal(passesSameProjectRelevance(mem, queryBroad, undefined), true);
  });

  it('undefined filePath with module-bearing query still requires module overlap', () => {
    const mem = {
      fingerprint: fp(['typescript'], ['node'], ['db', 'connection']),
      anchor: null,
    };
    assert.equal(passesSameProjectRelevance(mem, queryEditingTestFile, undefined), false);
    assert.equal(passesSameProjectRelevance(mem, queryEditingConnection, undefined), true);
  });

  it('undefined and null filePath produce identical verdicts across memory shapes', () => {
    const memories = [
      { fingerprint: fp(['typescript'], [], []), anchor: null },
      { fingerprint: fp(['typescript'], ['node'], ['db', 'connection']), anchor: null },
      { fingerprint: null, anchor: JSON.stringify({ files: ['src/db/connection.ts'] }) },
      { fingerprint: null, anchor: null },
    ];
    for (const mem of memories) {
      for (const query of [queryBroad, queryEditingTestFile, queryEditingConnection]) {
        assert.equal(
          passesSameProjectRelevance(mem, query, undefined),
          passesSameProjectRelevance(mem, query, null),
          `undefined/null divergence for mem=${JSON.stringify(mem)} query=${JSON.stringify(query)}`,
        );
      }
    }
  });
});
