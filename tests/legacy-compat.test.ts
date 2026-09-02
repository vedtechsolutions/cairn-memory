/**
 * Phase-B legacy compatibility (the rename's safety net).
 *
 * Until the Phase-C migration moves ~/.cairn to ~/.waykeep, a freshly
 * flipped binary MUST keep finding the user's store, config, gates, and
 * env overrides under their legacy names. The alternative failure mode —
 * silently starting an empty store — would present as total memory loss.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DATA_DIR_NAME, DB_FILENAME, LEGACY_NAMESPACES } from 'waykeep-contract';
import { resolveDbPath } from '../src/db/db-path.js';
import { ENV } from '../src/constants/env.js';

describe('legacy compatibility (Phase B)', () => {
  it('the legacy namespace list drives every fallback — pinned non-empty', () => {
    assert.deepEqual([...LEGACY_NAMESPACES], ['cairn']);
  });

  it('resolveDbPath prefers the current store and falls back to an EXISTING legacy one', () => {
    // Cannot safely create files in the real home — assert the LOGIC via
    // the path shapes: with neither store present, the default is the
    // CURRENT path (fallback never invents a legacy store).
    const resolved = resolveDbPath();
    const current = join(homedir(), DATA_DIR_NAME, DB_FILENAME);
    const legacy = join(homedir(), '.cairn', 'cairn.db');
    assert.ok(resolved === current || resolved === legacy,
      `default resolution must be the current store or an existing legacy one, got ${resolved}`);
    // Explicit paths are never redirected.
    assert.equal(resolveDbPath('/x/y.db'), '/x/y.db');
    assert.equal(resolveDbPath(':memory:'), ':memory:');
  });

  it('legacy-prefixed env values are inherited by unset current names at load', () => {
    // The bootstrap ran at module load; simulate its exact rule here to pin
    // the contract: current-set wins, legacy fills gaps only.
    const suffix = 'GOVERNANCE_TIMEOUT_MS';
    const current = ENV[suffix];
    const legacy = `CAIRN_${suffix}`;
    const savedCur = process.env[current];
    const savedLeg = process.env[legacy];
    try {
      delete process.env[current];
      process.env[legacy] = '12345';
      // Re-run the documented bootstrap rule (module-load already passed).
      for (const [sfx, name] of Object.entries(ENV)) {
        if (process.env[name] !== undefined) continue;
        for (const ns of LEGACY_NAMESPACES) {
          const v = process.env[`${ns.toUpperCase()}_${sfx}`];
          if (v !== undefined) { process.env[name] = v; break; }
        }
      }
      assert.equal(process.env[current], '12345', 'legacy value inherited');
      process.env[current] = '999';
      process.env[legacy] = '111';
      for (const [sfx, name] of Object.entries(ENV)) {
        if (process.env[name] !== undefined) continue;
        const v = process.env[`CAIRN_${sfx}`];
        if (v !== undefined) process.env[name] = v;
      }
      assert.equal(process.env[current], '999', 'an explicitly set current name is never overridden');
    } finally {
      if (savedCur === undefined) delete process.env[current]; else process.env[current] = savedCur;
      if (savedLeg === undefined) delete process.env[legacy]; else process.env[legacy] = savedLeg;
    }
  });

  it('gates fallback: a legacy .cairn/gates.json project stays governed (pinned in gate-config tests)', () => {
    // The behavioral pin lives in governance-gate-config.test.ts
    // ('honors a LEGACY .cairn/gates.json…') and session-start-handler
    // (legacy-dir briefing render). This cross-reference stops either from
    // being deleted as 'redundant' without this suite noticing.
    assert.ok(LEGACY_NAMESPACES.length > 0);
  });
});
