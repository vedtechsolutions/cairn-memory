import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/db/connection.js';
import { GateConfigError } from '../src/governance/gate-config.js';
import {
  SHADOW_FAULT_CODES, type ShadowFaultCode,
} from '../src/governance/verdict-types.js';
import {
  faultDigest, faultSnapshot, runFaultHarness,
} from './helpers/shadow-fault-harness.js';

const roots: string[] = [];
const REPOSITORY_LAYER_FAULTS: readonly ShadowFaultCode[] = [
  'database_unavailable', 'database_busy', 'schema_unavailable', 'rule_malformed',
  'evidence_malformed', 'unsupported_payload_version', 'concurrent_mutation',
  'serialization_bound_exceeded', 'audit_write_failed',
];
const GATE_3_SELF_ERROR_FAULTS: readonly ShadowFaultCode[] = [
  'invalid_stop_identity', 'invalid_project_root', 'config_missing', 'config_invalid',
  'config_oversized', 'config_path_escape', 'unsupported_adapter_version',
  'unsupported_parser_version', 'unsupported_digest_version', 'impossible_result_counts',
  'digest_unavailable', 'digest_bound_exceeded', 'digest_race', 'deadline_exceeded',
  'unexpected_error',
];

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.length = 0;
});

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'cairn-shadow-fault-'));
  roots.push(value);
  return value;
}

describe('shadow evaluator fault injection completion', () => {
  it('classifies and persists every non-repository Gate 3 fault class', async () => {
    const db = openDatabase({ dbPath: ':memory:' });
    const covered = new Set<ShadowFaultCode>();
    const run = async (
      expected: ShadowFaultCode,
      options: Parameters<typeof runFaultHarness>[2],
      persistable = true,
    ) => {
      const result = await runFaultHarness(db, root(), options);
      assert.equal(result.diagnostic.verdict?.result, 'self_error', expected);
      assert.equal(result.diagnostic.verdict?.fault, expected, expected);
      assert.equal(result.diagnostic.verdict?.completionEffect, 'none', expected);
      assert.equal(result.persisted.length, persistable ? 1 : 0, `${expected} persistence`);
      covered.add(expected);
    };
    try {
      await run('invalid_stop_identity', { input: { sessionId: '' } }, false);
      await run('invalid_project_root', { input: { projectRoot: '/definitely/missing/cairn-root' } }, false);
      for (const [fault, error] of [
        ['config_missing', new GateConfigError('invalid-config-path', 'missing')],
        ['config_invalid', new GateConfigError('invalid-json', 'invalid')],
        ['config_oversized', new GateConfigError('config-too-large', 'large')],
        ['config_path_escape', new GateConfigError('path-escape', 'escape')],
      ] as const) {
        await run(fault, { evaluator: { loadConfig: () => { throw error; } } });
      }
      for (const [fault, reason] of [
        ['digest_unavailable', 'git snapshot unavailable'],
        ['digest_bound_exceeded', 'relevant file count exceeds digest bound'],
        ['digest_race', 'worktree changed during both digest attempts'],
        ['deadline_exceeded', 'digest deadline exceeded'],
      ] as const) {
        await run(fault, { evaluator: { captureDigest: async () => faultDigest({
          status: 'incomplete', digest: null, reason,
        }) } });
      }
      await run('unsupported_digest_version', { evaluator: {
        captureDigest: async () => ({ ...faultDigest(), version: 99 as 2 }),
      } });
      const adapter = faultSnapshot();
      adapter.capability!.adapterVersion = 99;
      await run('unsupported_adapter_version', { snapshot: adapter });
      const parser = faultSnapshot();
      parser.gateRuns[0].parserVersion = 99;
      await run('unsupported_parser_version', { snapshot: parser });
      const counts = faultSnapshot();
      Object.assign(counts.gateRuns[0], { testTotal: 1, testPass: 2 });
      await run('impossible_result_counts', { snapshot: counts });
      await run('unexpected_error', { evaluator: {
        captureDigest: async () => { throw new Error('injected unexpected evaluator error'); },
      } });
      assert.deepEqual([...covered].sort(), [...GATE_3_SELF_ERROR_FAULTS].sort());
    } finally {
      db.close();
    }
  });

  it('keeps unsupported clients degraded, as required by the verdict matrix', async () => {
    const db = openDatabase({ dbPath: ':memory:' });
    try {
      const result = await runFaultHarness(db, root(), { input: { clientName: 'legacy-client' } });
      assert.equal(result.diagnostic.verdict?.result, 'degraded');
      assert.equal(result.diagnostic.verdict?.reason, 'unsupported_client');
      assert.equal(result.diagnostic.verdict?.fault, null);
      assert.equal(result.persisted.length, 1);
    } finally {
      db.close();
    }
  });

  it('partitions the complete fault taxonomy across Gate 2 and Gate 3 coverage', () => {
    assert.deepEqual(
      [...REPOSITORY_LAYER_FAULTS, ...GATE_3_SELF_ERROR_FAULTS, 'unsupported_client'].sort(),
      [...SHADOW_FAULT_CODES].sort(),
    );
  });
});
