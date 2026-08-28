import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { passesCrossProjectGuard } from '../src/hooks/handlers/pitfall-handler.js';
import type { ContextFingerprint } from '../src/utils/fingerprint.js';

function fp(lang: string[] = [], framework: string[] = [], module: string[] = []): ContextFingerprint {
  return { lang, framework, module };
}

const queryFpTs = fp(['typescript'], ['node', 'better-sqlite3'], ['hooks', 'handlers']);
const queryFpPy = fp(['python'], ['django'], ['models']);

describe('passesCrossProjectGuard — same-project pass-through', () => {
  it('passes when memory.project === currentProject', () => {
    const mem = { project: 'cairn-abc', fingerprint: null };
    assert.equal(passesCrossProjectGuard(mem, 'cairn-abc', queryFpTs), true);
  });

  it('passes same-project even when memory has no fingerprint', () => {
    const mem = { project: 'cairn-abc', fingerprint: null };
    assert.equal(passesCrossProjectGuard(mem, 'cairn-abc', queryFpTs), true);
  });

  it('passes same-project even with zero overlap fingerprint', () => {
    const mem = { project: 'cairn-abc', fingerprint: fp(['python'], ['odoo'], ['sale']) };
    assert.equal(passesCrossProjectGuard(mem, 'cairn-abc', queryFpTs), true);
  });

  it('passes both null projects (global → global)', () => {
    const mem = { project: null, fingerprint: fp(['typescript']) };
    assert.equal(passesCrossProjectGuard(mem, null, queryFpTs), true);
  });
});

describe('passesCrossProjectGuard — cross-project blocks null fingerprints', () => {
  it('blocks global null-fingerprint memory from cross-project surfacing', () => {
    const mem = { project: null, fingerprint: null };
    assert.equal(passesCrossProjectGuard(mem, 'cairn-abc', queryFpTs), false);
  });

  it('blocks global memory with empty arrays but null fingerprint reference', () => {
    const mem = { project: null, fingerprint: null };
    assert.equal(passesCrossProjectGuard(mem, 'cairn-xyz', queryFpPy), false);
  });

  it('blocks other-project null-fingerprint memory', () => {
    const mem = { project: 'other-project', fingerprint: null };
    assert.equal(passesCrossProjectGuard(mem, 'cairn-abc', queryFpTs), false);
  });
});

describe('passesCrossProjectGuard — cross-project overlap threshold', () => {
  it('passes a global TS pitfall on a TS project (full lang overlap)', () => {
    const mem = { project: null, fingerprint: fp(['typescript']) };
    assert.equal(passesCrossProjectGuard(mem, 'cairn-abc', queryFpTs), true);
  });

  it('blocks an Odoo/Python global pitfall from surfacing on a TS/Node edit', () => {
    const mem = { project: null, fingerprint: fp(['python'], ['odoo'], ['sale', 'account']) };
    assert.equal(passesCrossProjectGuard(mem, 'cairn-abc', queryFpTs), false);
  });

  it('passes when module dimension has strong overlap (shared framework)', () => {
    // memory fp: node framework + hooks module. query fp: node + hooks. Jaccard(framework) = 0.5,
    // Jaccard(module) = 0.5 — combined weighted ~0.5 which exceeds 0.3 threshold.
    const mem = { project: null, fingerprint: fp([], ['node'], ['hooks']) };
    assert.equal(passesCrossProjectGuard(mem, 'cairn-abc', queryFpTs), true);
  });

  it('blocks when overlap is below 0.3 (only a tangential framework match)', () => {
    // Only 1 framework match out of many dims; weighted overlap stays < 0.3.
    const mem = { project: null, fingerprint: fp(['rust'], ['tokio', 'serde'], ['crates']) };
    assert.equal(passesCrossProjectGuard(mem, 'cairn-abc', queryFpTs), false);
  });

  it('blocks a Python/Django global from a TS/Node query entirely', () => {
    const mem = { project: null, fingerprint: fp(['python'], ['django'], ['models']) };
    assert.equal(passesCrossProjectGuard(mem, 'cairn-abc', queryFpTs), false);
  });
});

describe('passesCrossProjectGuard — Odoo 19 regression fixtures', () => {
  // These are the exact memory shapes that were leaking into Cairn sessions
  // before the guard. All should be blocked for a Cairn TS/Node query.
  const odoo19Pitfalls = [
    { name: 'kanban_image pitfall', fingerprint: null },
    { name: 'website.snippets XPath pitfall', fingerprint: null },
    { name: 'ir.cron numbercall pitfall', fingerprint: null },
    { name: 'useService user pitfall', fingerprint: null },
    { name: 'settings view app name pitfall', fingerprint: null },
  ];
  for (const p of odoo19Pitfalls) {
    it(`blocks ${p.name} from Cairn TS query`, () => {
      const mem = { project: null, fingerprint: p.fingerprint };
      assert.equal(passesCrossProjectGuard(mem, 'cairn-2f161aa3', queryFpTs), false);
    });
  }

  it('still blocks even if the Odoo pitfall gained a python lang fingerprint later', () => {
    // Defense in depth: even with a lang hint, python fingerprint should not
    // pass a typescript-context guard.
    const mem = { project: null, fingerprint: fp(['python'], ['odoo']) };
    assert.equal(passesCrossProjectGuard(mem, 'cairn-abc', queryFpTs), false);
  });
});
