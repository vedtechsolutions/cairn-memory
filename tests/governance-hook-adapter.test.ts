import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { adaptClaudeHook } from '../src/governance/claude-hook-adapter.js';
import type { PostToolUseInput } from '../src/hooks/shared/hook-io.js';

const base = {
  session_id: 'session-a2',
  transcript_path: '/project/transcript.jsonl',
  cwd: '/project',
  client_name: 'claude-code',
  client_version: '1.2.3',
  client_installation_id: 'install-1',
};

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

describe('Claude Code governance hook adapter (A2)', () => {
  it('normalizes the current structured Bash success response without guessing', () => {
    const wire: PostToolUseInput = {
      ...base,
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_use_id: 'tool-1',
      duration_ms: 42,
      tool_input: { command: 'npm test' },
      tool_response: {
        stdout: 'ok 1 - works\r\n1..1\r\n',
        stderr: 'diagnostic',
        interrupted: false,
        isImage: false,
      },
    };
    const adapted = adaptClaudeHook(wire);
    assert.equal(adapted.kind, 'tool');
    if (adapted.kind !== 'tool') return;
    assert.equal(adapted.hookEvent, 'PostToolUse');
    assert.deepEqual(adapted.command, { shellCommand: 'npm test', tokenizedArgv: null });
    assert.deepEqual(adapted.client, {
      name: 'claude-code', version: '1.2.3', installationId: 'install-1',
    });
    assert.equal(adapted.result.outcome, 'success');
    assert.equal(adapted.result.exitCode, 0);
    assert.equal(adapted.result.outputText, 'ok 1 - works\n1..1\ndiagnostic');
    assert.equal(adapted.result.outputSha256, sha(adapted.result.outputText));
    assert.equal(adapted.captureStatus, 'complete');
  });

  it('normalizes current Write, Edit, and MultiEdit structured successes as scoped tool facts', () => {
    for (const [toolName, toolInput] of [
      ['Write', { file_path: '/project/a.ts', content: 'secret source' }],
      ['Edit', { file_path: '/project/b.ts', old_string: 'a', new_string: 'b' }],
      ['MultiEdit', { file_path: '/project/c.ts', edits: [{ old_string: 'a', new_string: 'b' }] }],
    ] as const) {
      const adapted = adaptClaudeHook({
        ...base,
        hook_event_name: 'PostToolUse',
        tool_name: toolName,
        tool_use_id: `tool-${toolName}`,
        tool_input: toolInput,
        tool_response: { success: true, filePath: toolInput.file_path },
      });
      assert.equal(adapted.kind, 'tool', toolName);
      if (adapted.kind !== 'tool') continue;
      assert.equal(adapted.toolName, toolName);
      assert.equal(adapted.result.outcome, 'success');
      assert.equal(adapted.result.exitCode, null);
      assert.equal(adapted.result.outputText, '', 'non-Bash response is never parser input');
      assert.match(adapted.result.outputSha256, /^[a-f0-9]{64}$/);
    }
  });

  it('normalizes failure status, signal/interruption metadata, and omitted status honestly', () => {
    const numeric = adaptClaudeHook({
      ...base,
      hook_event_name: 'PostToolUseFailure',
      tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: 'failure-1',
      error: 'tests failed', exit_code: 7, signal: 'SIGTERM', is_interrupt: true,
      timed_out: false, duration_ms: 500,
    });
    assert.equal(numeric.kind, 'tool');
    if (numeric.kind === 'tool') {
      assert.equal(numeric.result.outcome, 'failure');
      assert.equal(numeric.result.exitCode, 7);
      assert.equal(numeric.result.signal, 'SIGTERM');
      assert.equal(numeric.result.interrupted, true);
      assert.equal(numeric.result.outputSha256, sha('tests failed'));
    }

    const omitted = adaptClaudeHook({
      ...base,
      hook_event_name: 'PostToolUseFailure',
      tool_name: 'Bash', tool_input: { command: 'npm test' },
      error: 'client omitted status', is_interrupt: false,
    });
    assert.equal(omitted.kind, 'tool');
    if (omitted.kind === 'tool') {
      assert.equal(omitted.result.outcome, 'unknown_failure');
      assert.equal(omitted.result.exitCode, null);
      assert.equal(omitted.captureStatus, 'incomplete');
      assert.match(omitted.captureReason ?? '', /omitted numeric exit status/);
    }
  });

  it('accepts the legacy serialized response through its explicit legacy shape', () => {
    const adapted = adaptClaudeHook({
      ...base,
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      tool_response: 'legacy output\r\nall done',
    });
    assert.equal(adapted.kind, 'tool');
    if (adapted.kind !== 'tool') return;
    assert.equal(adapted.hookEvent, 'PostToolUse');
    assert.equal(adapted.result.outputText, 'legacy output\nall done');
    assert.equal(adapted.result.outputSha256, sha('legacy output\nall done'));
    assert.equal(adapted.result.exitCode, 0);
  });

  it('normalizes FileChanged with and without correlation metadata', () => {
    const correlated = adaptClaudeHook({
      ...base, hook_event_name: 'FileChanged', file_path: '/project/src/a.ts',
      tool_use_id: 'edit-1', delivery_fingerprint: 'delivery-1',
    });
    assert.equal(correlated.kind, 'file_changed');
    if (correlated.kind === 'file_changed') {
      assert.equal(correlated.toolUseId, 'edit-1');
      assert.equal(correlated.deliveryFingerprint, 'delivery-1');
      assert.equal(correlated.filePath, '/project/src/a.ts');
    }

    const external = adaptClaudeHook({
      ...base, hook_event_name: 'FileChanged', file_path: 'src/external.ts',
    });
    assert.equal(external.kind, 'file_changed');
    if (external.kind === 'file_changed') {
      assert.equal(external.toolUseId, null);
      assert.equal(external.deliveryFingerprint, null);
    }
  });

  it('returns structured adapter_error for unknown clients and shapes without guessed facts', () => {
    const fixtures: unknown[] = [
      null,
      { ...base, client_name: 'other-client', hook_event_name: 'PostToolUse' },
      { ...base, hook_event_name: 'MysteryEvent' },
      {
        ...base, hook_event_name: 'PostToolUse', tool_name: 'Bash',
        tool_input: { command: 'npm test' }, tool_response: { output: 'unrecognized' },
      },
      {
        ...base, hook_event_name: 'PostToolUseFailure', tool_name: 'Bash',
        tool_input: { command: 'npm test' }, error: { message: 'not wire-safe' },
      },
      {
        ...base, hook_event_name: 'PostToolUse', tool_name: 'Write',
        tool_input: { file_path: '/project/a.ts' }, tool_response: { mystery: true },
      },
      {
        ...base, hook_event_name: 'PostToolUse', tool_name: 'Bash',
        tool_input: { command: 'npm test' },
        tool_response: { stdout: 'looks fine', interrupted: false, timed_out: 'false' },
      },
    ];
    for (const fixture of fixtures) {
      const adapted = adaptClaudeHook(fixture);
      assert.equal(adapted.kind, 'adapter_error');
      if (adapted.kind !== 'adapter_error') continue;
      assert.equal(adapted.captureStatus, 'adapter_error');
      assert.equal('result' in adapted, false);
      assert.equal('command' in adapted, false);
      assert.equal('toolInput' in adapted, false);
    }
  });
});
