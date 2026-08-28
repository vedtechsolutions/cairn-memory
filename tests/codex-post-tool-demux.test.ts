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
import { demuxOutcome, handleCodexPostTool, isToolSeen } from '../src/hooks/handlers/codex-post-tool-handler.js';
import { createHookDbClient, type HookDbClient } from '../src/hooks/shared/db-client.js';
import { classifyError } from '../src/utils/error-classifier.js';

// Classifier dedup state persists across runs (by design) — every learnable
// error in these tests carries a per-run tag so keys never collide.
const RUN = Math.random().toString(36).slice(2, 8);

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
      { status: 'failed', exitCode: 3, outputText: 'boom-stderr\n' });
    assert.equal(o.failed, true);
    assert.equal(o.exitCode, 3);
    assert.match(o.errorText, /boom-stderr/);
  });

  it('routes a completed record to success', () => {
    const o = demuxOutcome({ tool_name: 'Bash', tool_response: 'ok\n' },
      { status: 'completed', exitCode: 0, outputText: 'ok\n' });
    assert.equal(o.failed, false);
  });

  it('Bash with no record is OUTCOME UNKNOWN — never success', () => {
    const o = demuxOutcome({ tool_name: 'Bash', tool_response: 'looks fine\n' }, null);
    assert.equal(o.failed, null);
    assert.equal(o.exitCode, null);
  });

  it('FAIL-SAFE: a novel status routes to unknown, and a non-zero exit code to failure regardless of status', () => {
    // Regression for review fix 1: `aborted` (exit 130) must never be success.
    const aborted = demuxOutcome({ tool_name: 'Bash', tool_response: 'interrupted' },
      { status: 'aborted', exitCode: 130, outputText: 'interrupted' });
    assert.equal(aborted.failed, true);
    assert.equal(aborted.exitCode, 130);

    const novel = demuxOutcome({ tool_name: 'Bash', tool_response: 'x' },
      { status: 'unknown', exitCode: null, outputText: 'x' });
    assert.equal(novel.failed, null);

    const completedNonZero = demuxOutcome({ tool_name: 'Bash', tool_response: 'x' },
      { status: 'completed', exitCode: 7, outputText: 'x' });
    assert.equal(completedNonZero.failed, true);
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

describe('error synthesis (classifier-facing contract)', () => {
  it('two DIFFERENT codex failures produce two distinct errorKeys — keys never collapse', () => {
    // Regression for the "Exit code N" preamble bug: a fixed first line gave
    // every codex failure the same classifier errorKey, so session error
    // counts lumped everything into one escalation bucket and dedup
    // suppressed all learning after the first pitfall. The synthesis now
    // leads with the real error text.
    const textA = `error TS2988: KEYS-A-${RUN} widget frobnicator misaligned in widget.ts`;
    const textB = `error TS2987: KEYS-B-${RUN} sprocket assembler overheated in sprocket.ts`;

    // New format (real text leads): distinct keys.
    const keyA = classifyError(textA).errorKey;
    const keyB = classifyError(textB).errorKey;
    assert.ok(keyA && keyB);
    assert.notEqual(keyA, keyB, 'distinct failures keep distinct classifier keys');

    // The OLD preamble format would have collapsed both into one key —
    // this is the documented bug shape, asserted so it can never return.
    const oldA = classifyError(`Exit code 2\n${textA}`).errorKey;
    const oldB = classifyError(`Exit code 2\n${textB}`).errorKey;
    assert.equal(oldA, oldB, 'the old preamble format collapses keys (the bug)');
  });

  it('codex-origin: learnable-but-undistillable output stores NO junk pitfall (strict mode)', async () => {
    // A learnable signature deep in the body (ECONNREFUSED) makes the
    // failure classify as learnable, but no DISTILLATION_PATTERN matches —
    // the first-line fallback would store the banner as a lesson. Strict
    // mode (codex only) stores nothing instead.
    const client: HookDbClient = createHookDbClient(':memory:');
    try {
      const p = join(dir, 'undistillable.jsonl');
      writeFileSync(p, rolloutLine({
        id: 'exec-banner-fail', type: 'CommandExecution', status: 'failed', exit_code: 1,
        aggregated_output: `▶ BANNER-${RUN} integration suite — postgres backend\nsetting up fixtures\nconnect ECONNREFUSED 127.0.0.1:5432\n`,
      }));
      const result = await handleCodexPostTool({
        session_id: 'banner-s1', transcript_path: p, cwd: '/opt/cairn',
        hook_event_name: 'PostToolUse', client_name: 'codex', tool_name: 'Bash',
        tool_input: { command: 'npm run integration' }, tool_use_id: 'exec-banner-fail', tool_response: '',
      }, { ...client, cache: undefined });
      assert.equal(result.action, 'error-routed');
      const junk = (client.db.prepare("SELECT COUNT(*) n FROM memories WHERE content LIKE '%BANNER-' || ? || '%'").get(RUN) as { n: number }).n;
      assert.equal(junk, 0, 'no banner stored as a lesson for codex');
    } finally {
      client.close();
    }
  });

  it('a failure with no learnable error pattern routes but stores NO pitfall', async () => {
    // Regression for the "(exit code N)" trailer bug: the lowercase trailer
    // matched a learnable pattern and turned every failure into a junk
    // pitfall distilled from ordinary output.
    const client: HookDbClient = createHookDbClient(':memory:');
    try {
      const p = join(dir, 'unlearnable.jsonl');
      writeFileSync(p, rolloutLine({
        id: 'exec-plain-fail', type: 'CommandExecution', status: 'failed', exit_code: 3,
        aggregated_output: `> cairn-memory@5.2.0 test UNLEARN-${RUN}\nordinary build output, no error signature\n`,
      }));
      const before = (client.db.prepare("SELECT COUNT(*) n FROM memories WHERE kind='pitfall'").get() as { n: number }).n;
      const result = await handleCodexPostTool({
        session_id: 'unlearn-s1', transcript_path: p, cwd: '/opt/cairn',
        hook_event_name: 'PostToolUse', client_name: 'codex', tool_name: 'Bash',
        tool_input: { command: 'npm test' }, tool_use_id: 'exec-plain-fail', tool_response: '',
      }, { ...client, cache: undefined });
      assert.equal(result.action, 'error-routed', 'routing is still correct');
      const after = (client.db.prepare("SELECT COUNT(*) n FROM memories WHERE kind='pitfall'").get() as { n: number }).n;
      assert.equal(after, before, 'no junk pitfall stored from unlearnable output');
    } finally {
      client.close();
    }
  });
});

describe('handleCodexPostTool (hook path, end to end)', () => {
  it('routes a large-record failure via the growing tail window and WRITES the seen-marker', async () => {
    // Regression for review fixes 2 (window growth) and the untested marker
    // write: the failed record's own line exceeds the base window.
    const client: HookDbClient = createHookDbClient(':memory:');
    try {
      const p = join(dir, 'bigline.jsonl');
      const bigOutput = `error TS2993: DEMUX-E2E-${RUN} type mismatch in bigline-check.ts\n` + 'x'.repeat(700 * 1024);
      writeFileSync(p, rolloutLine({
        id: 'exec-big-fail', type: 'CommandExecution', status: 'failed',
        exit_code: 2, aggregated_output: bigOutput,
      }));

      const result = await handleCodexPostTool({
        session_id: 'demux-e2e-session',
        transcript_path: p,
        cwd: '/opt/cairn',
        hook_event_name: 'PostToolUse',
        client_name: 'codex',
        tool_name: 'Bash',
        tool_input: { command: 'tsc' },
        tool_use_id: 'exec-big-fail',
        tool_response: `error TS2993: DEMUX-E2E-${RUN} type mismatch in bigline-check.ts\n`,
      }, { ...client, cache: undefined });

      assert.equal(result.action, 'error-routed');
      assert.equal(result.exitCode, 2);
      assert.equal(isToolSeen(client.db, 'exec-big-fail'), true, 'seen-marker written');
      const rows = client.db.prepare(
        "SELECT origin_client FROM memories WHERE kind='pitfall' AND content LIKE '%DEMUX-E2E-' || ? || '%'",
      ).all(RUN) as Array<{ origin_client: string }>;
      assert.equal(rows.length, 1);
      assert.equal(rows[0].origin_client, 'codex');
    } finally {
      client.close();
    }
  });
});
