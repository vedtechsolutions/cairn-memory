/**
 * The diagnostic logger: WAYKEEP_LOG_LEVEL gates what reaches stderr, the
 * prefix derives from the namespace (one spelling, scoped children), and the
 * level is resolved per call so a hook's env or a test's override applies
 * after import.
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NAMESPACE } from 'waykeep-contract';

import { ENV } from '../src/constants/env.js';
import { LOG_LEVELS, DEFAULT_LOG_LEVEL } from '../src/constants/runtime.js';
import { createLogger, currentLogLevel, log } from '../src/utils/log.js';

const saved = { level: process.env[ENV.LOG_LEVEL], verbose: process.env[ENV.VERBOSE] };
afterEach(() => {
  if (saved.level === undefined) delete process.env[ENV.LOG_LEVEL]; else process.env[ENV.LOG_LEVEL] = saved.level;
  if (saved.verbose === undefined) delete process.env[ENV.VERBOSE]; else process.env[ENV.VERBOSE] = saved.verbose;
});

/** Capture console.error for one call. */
function captured(fn: () => void): unknown[][] {
  const lines: unknown[][] = [];
  const real = console.error;
  console.error = (...args: unknown[]) => { lines.push(args); };
  try { fn(); } finally { console.error = real; }
  return lines;
}

describe('log level resolution', () => {
  it('defaults to info, accepts every declared level, falls back on garbage', () => {
    delete process.env[ENV.LOG_LEVEL];
    delete process.env[ENV.VERBOSE];
    assert.equal(currentLogLevel(), DEFAULT_LOG_LEVEL);
    for (const level of LOG_LEVELS) {
      process.env[ENV.LOG_LEVEL] = level;
      assert.equal(currentLogLevel(), level);
    }
    process.env[ENV.LOG_LEVEL] = 'loud';
    assert.equal(currentLogLevel(), DEFAULT_LOG_LEVEL);
  });

  it('WAYKEEP_VERBOSE=1 is the debug shortcut and wins over the level', () => {
    process.env[ENV.LOG_LEVEL] = 'error';
    process.env[ENV.VERBOSE] = '1';
    assert.equal(currentLogLevel(), 'debug');
  });
});

describe('logger output', () => {
  it('prints only at or above the configured level, with the namespace prefix', () => {
    delete process.env[ENV.VERBOSE];
    process.env[ENV.LOG_LEVEL] = 'warn';
    const lines = captured(() => { log.debug('d'); log.info('i'); log.warn('w'); log.error('e', 42); });
    assert.deepEqual(lines, [[`[${NAMESPACE}] w`], [`[${NAMESPACE}] e`, 42]]);
  });

  it('silent prints nothing, even errors', () => {
    delete process.env[ENV.VERBOSE];
    process.env[ENV.LOG_LEVEL] = 'silent';
    assert.deepEqual(captured(() => log.error('boom')), []);
  });

  it('child scopes nest into one prefix form', () => {
    delete process.env[ENV.VERBOSE];
    process.env[ENV.LOG_LEVEL] = 'info';
    const lines = captured(() => { createLogger('db').info('x'); log.child('daemon').child('tailer').info('y'); });
    assert.deepEqual(lines, [[`[${NAMESPACE}:db] x`], [`[${NAMESPACE}:daemon:tailer] y`]]);
  });

  it('re-reads the level on every call (no import-time snapshot)', () => {
    delete process.env[ENV.VERBOSE];
    process.env[ENV.LOG_LEVEL] = 'error';
    assert.deepEqual(captured(() => log.info('hidden')), []);
    process.env[ENV.LOG_LEVEL] = 'info';
    assert.equal(captured(() => log.info('shown')).length, 1);
  });
});

describe('log prefix is never spelled by hand', () => {
  // The migration that introduced the logger left the original string behind
  // as a second argument at five multi-line sites, printing the fail-closed
  // security diagnostics twice with the old hand-spelled prefix (review).
  const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const SRC = join(REPO, 'src');
  const files = (dir: string): string[] => readdirSync(dir).flatMap(e => {
    const p = join(dir, e);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
  });
  const stripComments = (code: string): string => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('no non-CLI source carries a [namespace…] prefix in a string — the logger adds it', () => {
    const prefix = new RegExp(`['"\`]\\[${NAMESPACE}[\\]:-]`);
    // memory-injection.ts frames TEAM memories with a contract-visible
    // "[waykeep-team: author]" marker whose exact spelling the neutralizer and
    // the sync tests depend on — content framing, not a log line.
    const CONTENT_MARKERS = new Set([join(SRC, 'utils', 'memory-injection.ts')]);
    const scanned = files(SRC).filter(f => !f.includes(`${join('src', 'cli')}/`) && !f.endsWith(join('utils', 'log.ts')) && !CONTENT_MARKERS.has(f));
    assert.ok(scanned.length > 50, 'vacuous-instrument guard');
    const offenders = scanned.filter(f => prefix.test(stripComments(readFileSync(f, 'utf-8')))).map(f => relative(REPO, f));
    assert.deepEqual(offenders, [], `these files spell the log prefix by hand — use log / log.child():\n  ${offenders.join('\n  ')}`);
  });
});
