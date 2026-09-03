/**
 * Exact-text guard for the memory-tool contract messages.
 *
 * errors.ts calls itself "the ONE mapping from every contract case to its
 * thrown message". Those messages now INTERPOLATE the limits they describe,
 * so they cannot drift from enforcement — but interpolation can still change
 * the rendered text (a locale, a formatter, a stray space).
 *
 * The existing coverage is regex SUBSTRING matching, which would not catch an
 * added prefix or suffix, and `lineLimitExceeded` had no coverage at all.
 * These are `assert.equal` on purpose.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ERR } from '../src/memory-tool/errors.js';
import { FREE_FORM_LIMITS, MAX_FILE_LINES, MAX_VIEW_CHARS } from '../src/constants/memory-tool.js';

describe('memory-tool contract messages render exactly', () => {
  it('free-form store limits', () => {
    assert.equal(ERR.fileTooLarge(), 'file exceeds the 64KB memory-file limit');
    assert.equal(ERR.storeFullFiles(), 'memory store is full (256 files)');
    assert.equal(ERR.storeFullBytes(), 'memory store is full (16MB aggregate limit)');
  });

  it('line limit — grouped thousands, locale-independent', () => {
    assert.equal(ERR.lineLimitExceeded('/memories/x.md'),
      'File /memories/x.md exceeds maximum line limit of 999,999 lines.');
  });

  it('the rendered text actually tracks the constants it describes', () => {
    // Not tautological: it asserts the SHAPE of the coupling, so a message that
    // stopped interpolating would still fail the exact-text checks above.
    assert.ok(ERR.storeFullFiles().includes(String(FREE_FORM_LIMITS.MAX_FILES)));
    assert.ok(ERR.lineLimitExceeded('/x').includes(MAX_FILE_LINES.toLocaleString('en-US')));
    assert.equal(MAX_VIEW_CHARS, 16_000);
  });
});
