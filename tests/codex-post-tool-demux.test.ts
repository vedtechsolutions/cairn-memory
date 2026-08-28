/**
 * Codex parity Slice B — rollout lookup and PostToolUse demux.
 * The demux must never infer success: failed rollout records route to
 * error-learning, completed to success-tracker, and a missing record is
 * OUTCOME UNKNOWN (never success).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findRolloutToolRecord } from '../src/hooks/shared/rollout-lookup.js';
import { demuxOutcome } from '../src/hooks/handlers/codex-post-tool-handler.js';

let dir: string;
before(() => { dir = mkdtempSync(join(tmpdir(), 'cairn-rollout-')); });
after(() => { rmSync(dir, { recursive: true, force: true }); });

function rolloutLine(item: Record<string, unknown>, nested = true): string {
  const payload = nested
    ? { type: 'item_completed', item: { item } }
    : { type: 'item_completed', item };
  return JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload }) + '\n';
}

const CMD_FAILED = {
  id: 'exec-fail-1', type: 'CommandExecution', status: 'failed',
  exit_code: 3, aggregated_output: 'boom-stderr\n', stdout: '', stderr: '',
};
const CMD_OK = {
  id: 'exec-ok-1', type: 'CommandExecution', status: 'completed',
  exit_code: 0, aggregated_output: 'all 12 tests pass\n',
};
const FILE_CHANGE = {
  id: 'exec-patch-1', type: 'FileChange', status: 'completed',
};

describe('findRolloutToolRecord', () => {
  it('finds a failed CommandExecution by tool_use_id (nested item shape)', async () => {
    const p = join(dir, 'nested.jsonl');
    writeFileSync(p, rolloutLine({ id: 'other' , type: 'CommandExecution', status: 'completed' }) + rolloutLine(CMD_FAILED));
    const r = await findRolloutToolRecord(p, 'exec-fail-1');
    assert.ok(r);
    assert.equal(r.kind, 'command');
    assert.equal(r.status, 'failed');
    assert.equal(r.exitCode, 3);
    assert.match(r.outputText, /boom-stderr/);
  });

  it('tolerates the unnested item shape', async () => {
    const p = join(dir, 'unnested.jsonl');
    writeFileSync(p, rolloutLine(CMD_OK, false));
    const r = await findRolloutToolRecord(p, 'exec-ok-1');
    assert.ok(r);
    assert.equal(r.status, 'completed');
    assert.equal(r.exitCode, 0);
  });

  it('matches FileChange records', async () => {
    const p = join(dir, 'patch.jsonl');
    writeFileSync(p, rolloutLine(FILE_CHANGE));
    const r = await findRolloutToolRecord(p, 'exec-patch-1');
    assert.ok(r);
    assert.equal(r.kind, 'file_change');
  });

  it('returns null for an unknown id, a torn tail line, and a missing file', async () => {
    const p = join(dir, 'torn.jsonl');
    writeFileSync(p, rolloutLine(CMD_OK));
    appendFileSync(p, '{"timestamp":"2026-08-28T00:00:00Z","type":"event_msg","payl'); // torn mid-write
    assert.equal(await findRolloutToolRecord(p, 'exec-nope'), null);
    assert.equal(await findRolloutToolRecord(join(dir, 'missing.jsonl'), 'exec-ok-1'), null);
    assert.equal(await findRolloutToolRecord(undefined, 'exec-ok-1'), null);
    assert.equal(await findRolloutToolRecord(p, undefined), null);
  });

  it('picks the NEWEST record when an id would somehow repeat', async () => {
    const p = join(dir, 'newest.jsonl');
    writeFileSync(p,
      rolloutLine({ ...CMD_OK, id: 'exec-dup' }) +
      rolloutLine({ ...CMD_FAILED, id: 'exec-dup' }));
    const r = await findRolloutToolRecord(p, 'exec-dup');
    assert.equal(r?.status, 'failed');
  });
});

describe('demuxOutcome', () => {
  it('routes a failed record to failure with exit code and output text', () => {
    const o = demuxOutcome({ tool_name: 'Bash', tool_response: 'boom-stderr\n' },
      { kind: 'command', status: 'failed', exitCode: 3, outputText: 'boom-stderr\n' });
    assert.equal(o.failed, true);
    assert.equal(o.exitCode, 3);
    assert.match(o.errorText, /boom-stderr/);
  });

  it('routes a completed record to success', () => {
    const o = demuxOutcome({ tool_name: 'Bash', tool_response: 'ok\n' },
      { kind: 'command', status: 'completed', exitCode: 0, outputText: 'ok\n' });
    assert.equal(o.failed, false);
  });

  it('Bash with no record is OUTCOME UNKNOWN — never success', () => {
    const o = demuxOutcome({ tool_name: 'Bash', tool_response: 'looks fine\n' }, null);
    assert.equal(o.failed, null);
    assert.equal(o.exitCode, null);
  });

  it('apply_patch falls back to the embedded "Exit code: N" line', () => {
    const ok = demuxOutcome({
      tool_name: 'apply_patch',
      tool_response: 'Exit code: 0\nWall time: 0.4 seconds\nOutput:\nSuccess.',
    }, null);
    assert.equal(ok.failed, false);
    assert.equal(ok.exitCode, 0);

    const bad = demuxOutcome({
      tool_name: 'apply_patch',
      tool_response: 'Exit code: 1\nOutput:\npatch failed: context mismatch',
    }, null);
    assert.equal(bad.failed, true);
    assert.equal(bad.exitCode, 1);
    assert.match(bad.errorText, /context mismatch/);
  });

  it('apply_patch with no record and no parseable exit line is unknown', () => {
    const o = demuxOutcome({ tool_name: 'apply_patch', tool_response: 'weird output' }, null);
    assert.equal(o.failed, null);
  });
});
