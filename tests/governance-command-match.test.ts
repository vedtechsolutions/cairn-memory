import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  matchGateCommand, tokenizeSimpleCommand, type ObservedCommand,
} from '../src/governance/command-match.js';
import type { NormalizedGate } from '../src/governance/gate-config.js';

const root = '/project';

function gate(overrides: Partial<NormalizedGate> = {}): NormalizedGate {
  return {
    argv: ['npm', 'test'],
    cwd: '.',
    parser: 'node-test',
    timeoutMs: 900_000,
    skips: { max: 0, requireReasons: false },
    aliases: [{ argv: ['npm', 'run', 'test:ci'], cwd: 'packages/core' }],
    envNames: ['CI', 'NODE_ENV'],
    ...overrides,
  };
}

const environment = { CI: '1', NODE_ENV: 'test' };
const context = { projectRoot: root, expectedEnvironment: environment };

function observe(overrides: Partial<ObservedCommand> = {}): ObservedCommand {
  return { command: 'npm test', cwd: root, environment, ...overrides };
}

describe('exact governance command matching (A3)', () => {
  it('tokenizes one simple command with literal quoting and escaping', () => {
    assert.deepEqual(
      tokenizeSimpleCommand(`npm "run" 'test core' -- --name="a b" empty='' escaped\\ value`),
      {
        ok: true,
        argv: ['npm', 'run', 'test core', '--', '--name=a b', 'empty=', 'escaped value'],
      },
    );
    assert.deepEqual(tokenizeSimpleCommand(`printf '%s|%s' 'a;b' '$(literal)'`), {
      ok: true, argv: ['printf', '%s|%s', 'a;b', '$(literal)'],
    });
    assert.deepEqual(tokenizeSimpleCommand('npm "te\\st"'), {
      ok: true, argv: ['npm', 'te\\st'],
    });
  });

  it('preserves non-special backslashes inside double quotes for exact matching', () => {
    assert.deepEqual(
      matchGateCommand(observe({ command: 'npm "te\\st"' }), gate(), context),
      { matched: false, reason: 'argv_mismatch' },
    );
    assert.deepEqual(
      matchGateCommand(
        observe({ command: 'node "scripts/chec\\k.mjs"' }),
        gate({ argv: ['node', 'scripts/check.mjs'], envNames: [] }),
        { projectRoot: root },
      ),
      { matched: false, reason: 'argv_mismatch' },
    );
    assert.deepEqual(tokenizeSimpleCommand('escaped\\ value'), {
      ok: true, argv: ['escaped value'],
    });
  });

  it('matches executable, argv, cwd, and relevant environment exactly', () => {
    const matched = matchGateCommand(observe(), gate(), context);
    assert.deepEqual(matched, {
      matched: true, form: 'primary', aliasIndex: null,
      argv: ['npm', 'test'], cwd: root,
    });
    assert.equal(matchGateCommand(
      observe({ cwd: '/project/packages/core', command: 'npm run test:ci' }),
      gate(), context,
    ).matched, true);
  });

  it('prefers authoritative tokenized argv and preserves empty arguments exactly', () => {
    const exact = gate({ argv: ['node', 'script.mjs', '', 'a b'], envNames: [] });
    const result = matchGateCommand({
      argv: ['node', 'script.mjs', '', 'a b'],
      command: 'this shell string is deliberately ignored', cwd: root,
    }, exact, { projectRoot: root });
    assert.equal(result.matched, true);
  });

  it('rejects chaining, pipes, redirection, substitution, backgrounding, and control operators', () => {
    const hostile = [
      'npm test && true',
      'npm test || :',
      'npm test | tee result.log',
      'npm test > result.log',
      'npm test 2>> result.log',
      'npm test < input',
      'npm $(echo test)',
      'npm `echo test`',
      'npm test &',
      'npm test; true',
      'npm test\ntrue',
      '(npm test)',
      'npm test # success',
      'npm test *',
    ];
    for (const command of hostile) {
      const tokenized = tokenizeSimpleCommand(command);
      assert.equal(tokenized.ok, false, command);
      assert.deepEqual(
        matchGateCommand(observe({ command, argv: undefined }), gate(), context),
        { matched: false, reason: 'invalid_command' },
        command,
      );
    }
  });

  it('rejects success masking, malformed quoting/escaping, and empty commands', () => {
    for (const command of [
      'npm test || exit 0', `npm 'test`, 'npm "test', 'npm test\\', '', '   ',
    ]) {
      assert.equal(tokenizeSimpleCommand(command).ok, false, command);
    }
  });

  it('rejects command prefix/suffix and output-spoof forms', () => {
    for (const command of ['echo npm test', 'npm test extra', 'printf "npm test"']) {
      assert.deepEqual(matchGateCommand(observe({ command }), gate(), context), {
        matched: false, reason: 'argv_mismatch',
      });
    }
  });

  it('requires alias argv and alias cwd as one independent exact form', () => {
    assert.deepEqual(
      matchGateCommand(observe({ command: 'npm run test:ci' }), gate(), context),
      { matched: false, reason: 'cwd_mismatch' },
    );
    assert.deepEqual(
      matchGateCommand(observe({ command: 'npm test', cwd: '/project/packages/core' }), gate(), context),
      { matched: false, reason: 'cwd_mismatch' },
    );
    const alias = matchGateCommand(
      observe({ command: 'npm run test:ci', cwd: '/project/packages/core' }), gate(), context,
    );
    assert.equal(alias.matched, true);
    if (alias.matched) {
      assert.equal(alias.form, 'alias');
      assert.equal(alias.aliasIndex, 0);
    }
  });

  it('rejects cwd escape/mismatch and relevant environment mismatch or omission', () => {
    assert.deepEqual(matchGateCommand(observe({ cwd: '/other' }), gate(), context), {
      matched: false, reason: 'invalid_command',
    });
    assert.deepEqual(matchGateCommand(observe({ cwd: '/project/subdir' }), gate(), context), {
      matched: false, reason: 'cwd_mismatch',
    });
    assert.deepEqual(matchGateCommand(
      observe({ environment: { CI: '0', NODE_ENV: 'test' } }), gate(), context,
    ), { matched: false, reason: 'env_mismatch' });
    assert.deepEqual(matchGateCommand(
      observe({ environment: undefined }), gate(), context,
    ), { matched: false, reason: 'env_mismatch' });
  });

  it('has no process or shell execution surface', () => {
    const source = readFileSync(resolve('src/governance/command-match.ts'), 'utf8');
    assert.doesNotMatch(source, /node:child_process|\bspawn(?:Sync)?\b|\bexec(?:File|Sync)?\s*\(/);
  });
});
