import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isSafeTranscriptPath } from '../src/hooks/shared/transcript/jsonl-io.js';
import { readState } from '../src/hooks/shared/state-io.js';
import { ENV } from '../src/constants/env.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'cairn-sec-'));
  dirs.push(d);
  return d;
}

// The hermetic test preload sets CAIRN_ALLOW_TMP_TRANSCRIPTS, so the OS tmpdir
// counts as an allowed transcript root here.
describe('isSafeTranscriptPath symlink containment (M4)', () => {
  it('accepts a real file under an allowed root', () => {
    const f = join(tempDir(), 'transcript.jsonl');
    writeFileSync(f, '{}\n');
    assert.equal(isSafeTranscriptPath(f), true);
  });

  it('rejects a symlink under an allowed root that escapes it', () => {
    const link = join(tempDir(), 'evil.jsonl');
    symlinkSync('/etc/passwd', link);
    assert.equal(isSafeTranscriptPath(link), false);
  });

  it('rejects a path outside every allowed root', () => {
    assert.equal(isSafeTranscriptPath('/etc/passwd'), false);
  });
});

describe('readState validation (L1)', () => {
  const prev = process.env[ENV.STATE_PATH];
  afterEach(() => {
    if (prev === undefined) delete process.env[ENV.STATE_PATH];
    else process.env[ENV.STATE_PATH] = prev;
  });

  function readWithState(contents: string): ReturnType<typeof readState> {
    const p = join(tempDir(), 'cairn-state.json');
    writeFileSync(p, contents);
    process.env[ENV.STATE_PATH] = p;
    return readState();
  }

  it('accepts a well-formed state', () => {
    assert.deepEqual(
      readWithState(JSON.stringify({ mode: 'compact', freeUntilCompact: 40 })),
      { mode: 'compact', freeUntilCompact: 40 },
    );
  });

  it('rejects an invalid mode and falls back to the safe default', () => {
    assert.equal(readWithState(JSON.stringify({ mode: 'evil', freeUntilCompact: 5 })).mode, 'normal');
  });

  it('rejects out-of-range freeUntilCompact', () => {
    const s = readWithState(JSON.stringify({ mode: 'normal', freeUntilCompact: 9999 }));
    assert.deepEqual(s, { mode: 'normal', freeUntilCompact: 100 });
  });

  it('rejects malformed JSON', () => {
    assert.equal(readWithState('{not json').mode, 'normal');
  });
});
