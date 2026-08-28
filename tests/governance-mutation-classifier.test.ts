import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { adaptClaudeHook } from '../src/governance/claude-hook-adapter.js';
import {
  classifyMutation, READ_ONLY_COMMAND_ALLOWLIST_VERSION,
} from '../src/governance/mutation-classifier.js';

const base = {
  session_id: 'session-mutation', transcript_path: '/project/transcript.jsonl',
  cwd: '/project', client_name: 'claude-code',
};

function success(tool_name: string, tool_input: Record<string, unknown>) {
  return adaptClaudeHook({
    ...base, hook_event_name: 'PostToolUse', tool_name, tool_input,
    tool_response: tool_name === 'Bash'
      ? { stdout: '', stderr: '', interrupted: false }
      : { success: true },
  });
}

describe('pure governance mutation classification', () => {
  it('classifies successful Write/Edit/MultiEdit targets as normalized scoped mutations', () => {
    const fixtures = [
      success('Write', { file_path: '/project/src/a.ts', content: 'x' }),
      success('Edit', { file_path: 'src//b.ts', old_string: 'x', new_string: 'y' }),
      success('MultiEdit', {
        edits: [
          { file_path: 'src/c.ts', old_string: 'x', new_string: 'y' },
          { file_path: 'src/d.ts', old_string: 'a', new_string: 'b' },
        ],
      }),
    ];
    assert.deepEqual(classifyMutation(fixtures[0]), {
      mutationClass: 'scoped', affectedPaths: ['src/a.ts'], allowlistVersion: null,
      reason: 'successful edit tool',
    });
    assert.deepEqual(classifyMutation(fixtures[1]).affectedPaths, ['src/b.ts']);
    assert.deepEqual(classifyMutation(fixtures[2]).affectedPaths, ['src/c.ts', 'src/d.ts']);
  });

  it('treats escaped, traversing, or missing edit targets as unknown mutations', () => {
    for (const event of [
      success('Write', { file_path: '../outside.ts', content: 'x' }),
      success('Edit', { file_path: '/outside.ts', old_string: 'x', new_string: 'y' }),
      success('MultiEdit', { edits: [] }),
    ]) {
      assert.equal(classifyMutation(event).mutationClass, 'unknown');
    }
  });

  it('classifies only exact successful read-only Bash forms as none', () => {
    for (const command of ['pwd', 'git status', 'git status --short']) {
      assert.deepEqual(classifyMutation(success('Bash', { command })), {
        mutationClass: 'none', affectedPaths: [],
        allowlistVersion: READ_ONLY_COMMAND_ALLOWLIST_VERSION,
        reason: 'exact read-only command',
      });
    }
    for (const command of [
      'git status --short extra', 'git diff', 'pwd && touch x', 'npm test', 'git "sta\\tus"',
    ]) {
      const classified = classifyMutation(success('Bash', { command }));
      assert.equal(classified.mutationClass, 'unknown', command);
      assert.equal(classified.allowlistVersion, READ_ONLY_COMMAND_ALLOWLIST_VERSION, command);
    }
  });

  it('keeps failed Bash mutating even when its command is read-only', () => {
    const failed = adaptClaudeHook({
      ...base, hook_event_name: 'PostToolUseFailure', tool_name: 'Bash',
      tool_input: { command: 'git status' }, error: 'failed after partial work',
      exit_code: 1, is_interrupt: false,
    });
    const classified = classifyMutation(failed);
    assert.equal(classified.mutationClass, 'unknown');
    assert.match(classified.reason, /failed Bash/);
  });

  it('classifies FileChanged as external scoped mutation with or without correlation', () => {
    for (const tool_use_id of ['edit-1', undefined]) {
      const event = adaptClaudeHook({
        ...base, hook_event_name: 'FileChanged', file_path: '/project/src/external.ts',
        ...(tool_use_id === undefined ? {} : { tool_use_id }),
      });
      assert.deepEqual(classifyMutation(event), {
        mutationClass: 'scoped', affectedPaths: ['src/external.ts'],
        allowlistVersion: null, reason: 'FileChanged',
      });
    }
  });

  it('conservatively classifies malformed, unknown, and out-of-root inputs', () => {
    const fixtures = [
      adaptClaudeHook({ ...base, hook_event_name: 'MysteryEvent' }),
      adaptClaudeHook({ ...base, hook_event_name: 'FileChanged', file_path: '/outside/a.ts' }),
      adaptClaudeHook({
        ...base, hook_event_name: 'PostToolUse', tool_name: 'UnknownTool',
        tool_input: {}, tool_response: {},
      }),
    ];
    for (const event of fixtures) {
      assert.equal(classifyMutation(event).mutationClass, 'unknown');
      assert.deepEqual(classifyMutation(event).affectedPaths, []);
    }
  });
});
