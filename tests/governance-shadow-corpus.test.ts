import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/db/connection.js';
import {
  cleanupCorpusAuxiliaries, runCorpusScenario, type CorpusScenario,
} from './helpers/shadow-corpus.js';

interface AuditedScenario extends CorpusScenario {
  expectedResult: string;
  expectedReason: string;
}

const SCENARIOS: readonly AuditedScenario[] = [
  { id: 'clean', tree: 'clean', expectedResult: 'pass', expectedReason: 'all_required_gates_fresh' },
  { id: 'dirty-tracked', tree: 'dirty', expectedResult: 'pass', expectedReason: 'all_required_gates_fresh' },
  { id: 'staged', tree: 'staged', expectedResult: 'pass', expectedReason: 'all_required_gates_fresh' },
  { id: 'staged-unstaged-mix', tree: 'mixed', expectedResult: 'pass', expectedReason: 'all_required_gates_fresh' },
  { id: 'untracked', tree: 'untracked', expectedResult: 'pass', expectedReason: 'all_required_gates_fresh' },
  { id: 'rename', tree: 'rename', expectedResult: 'pass', expectedReason: 'all_required_gates_fresh' },
  { id: 'deletion', tree: 'deletion', expectedResult: 'pass', expectedReason: 'all_required_gates_fresh' },
  { id: 'mode-change', tree: 'mode', expectedResult: 'pass', expectedReason: 'all_required_gates_fresh' },
  { id: 'symlink', tree: 'symlink', expectedResult: 'pass', expectedReason: 'all_required_gates_fresh' },
  { id: 'submodule-clean', tree: 'submodule-clean', expectedResult: 'pass', expectedReason: 'all_required_gates_fresh' },
  { id: 'submodule-dirty', tree: 'submodule-dirty', expectedResult: 'pass', expectedReason: 'all_required_gates_fresh' },
  { id: 'non-git-manifest', tree: 'non-git', expectedResult: 'pass', expectedReason: 'all_required_gates_fresh' },
  { id: 'unborn-head', tree: 'unborn', expectedResult: 'pass', expectedReason: 'all_required_gates_fresh' },
  { id: 'changing-during-hash', tree: 'clean', mutation: 'hash-race', expectedResult: 'self_error', expectedReason: 'digest_race' },
  { id: 'scoped-mutation-invalidates', tree: 'clean', mutation: 'scoped', expectedResult: 'stale', expectedReason: 'gate_stale' },
  { id: 'unknown-mutation-invalidates', tree: 'clean', mutation: 'unknown', expectedResult: 'stale', expectedReason: 'gate_stale' },
  { id: 'zero-test-run', tree: 'clean', evidence: { counts: { total: 0, pass: 0, fail: 0, skip: 0 } }, expectedResult: 'non_pass', expectedReason: 'gate_non_pass' },
  { id: 'excess-skips', tree: 'clean', evidence: { counts: { total: 3, pass: 2, fail: 0, skip: 1 } }, expectedResult: 'non_pass', expectedReason: 'gate_non_pass' },
  { id: 'timeout-run', tree: 'clean', evidence: { captureResult: 'failed' }, expectedResult: 'non_pass', expectedReason: 'gate_non_pass' },
  { id: 'killed-run', tree: 'dirty', evidence: { captureResult: 'failed' }, expectedResult: 'non_pass', expectedReason: 'gate_non_pass' },
  { id: 'exit-only-gate', tree: 'clean', evidence: { parser: 'exit-only' }, expectedResult: 'pass', expectedReason: 'all_required_gates_fresh' },
  { id: 'multi-gate-partial', tree: 'clean', evidence: { secondGateMissing: true }, expectedResult: 'missing', expectedReason: 'gate_missing' },
  { id: 'degraded-capability', tree: 'clean', capability: 'degraded', expectedResult: 'degraded', expectedReason: 'missing_file_changed' },
  { id: 'stale-heartbeat-current-stop', tree: 'clean', capability: 'stale-heartbeat', expectedResult: 'pass', expectedReason: 'all_required_gates_fresh' },
  { id: 'unsupported-client', tree: 'clean', clientName: 'legacy-client', expectedResult: 'degraded', expectedReason: 'unsupported_client' },
  { id: 'missing-evidence', tree: 'clean', evidence: { missing: true }, expectedResult: 'missing', expectedReason: 'gate_missing' },
  { id: 'digest-only-mutation', tree: 'clean', mutation: 'digest-only', expectedResult: 'stale', expectedReason: 'gate_stale' },
  { id: 'config-missing-with-rule', tree: 'clean-no-config', expectedResult: 'self_error', expectedReason: 'config_missing' },
  { id: 'no-governance', tree: 'clean-no-config', rules: false, expectedResult: 'skipped', expectedReason: 'no_governance' },
  { id: 'recorded-test-failure', tree: 'clean', evidence: { counts: { total: 3, pass: 2, fail: 1, skip: 0 } }, expectedResult: 'non_pass', expectedReason: 'gate_non_pass' },
  { id: 'unsupported-parser-version', tree: 'clean', evidence: { parserVersion: 99 }, expectedResult: 'self_error', expectedReason: 'gate_self_error' },
  { id: 'relevant-paths-mismatch', tree: 'clean', evidence: { relevantPathsMismatch: true }, expectedResult: 'missing', expectedReason: 'gate_missing' },
] as const;

const temporaryRoots: string[] = [];
const auxiliaries: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
  temporaryRoots.length = 0;
  cleanupCorpusAuxiliaries(auxiliaries);
  auxiliaries.length = 0;
});

describe('hand-audited shadow verdict corpus', () => {
  it('matches all 32 audited verdicts with zero false pass', async () => {
    assert.ok(SCENARIOS.length >= 30);
    const db = openDatabase({ dbPath: ':memory:' });
    const passAllowlist = new Set(
      SCENARIOS.filter(scenario => scenario.expectedResult === 'pass').map(scenario => scenario.id),
    );
    try {
      for (const scenario of SCENARIOS) {
        const root = mkdtempSync(join(tmpdir(), `cairn-corpus-${scenario.id}-`));
        temporaryRoots.push(root);
        const { diagnostic, persisted } = await runCorpusScenario(db, root, scenario, auxiliaries);
        const actualResult = diagnostic.verdict?.result ?? diagnostic.status;
        const actualReason = diagnostic.verdict?.reason ??
          (diagnostic.status === 'skipped' ? 'no_governance' : 'no_verdict');
        assert.equal(actualResult, scenario.expectedResult, `${scenario.id} result`);
        assert.equal(actualReason, scenario.expectedReason, `${scenario.id} reason`);
        if (actualResult === 'pass') {
          assert.ok(passAllowlist.has(scenario.id), `false pass: ${scenario.id}`);
        }
        if (scenario.id === 'no-governance') assert.equal(persisted.length, 0);
        else assert.equal(persisted.length, 1, `${scenario.id} persistence`);
      }
    } finally {
      db.close();
    }
  });
});
