import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatTimestamp } from '../src/utils/time.js';

describe('formatTimestamp', () => {
  // 2026-08-28 01:00 UTC is 2026-08-27 20:00 in America/Jamaica (UTC-5, no DST).
  const iso = '2026-08-28T01:00:00.000Z';

  function withTz<T>(tz: string | undefined, fn: () => T): T {
    const prev = process.env.CAIRN_TZ;
    if (tz === undefined) delete process.env.CAIRN_TZ; else process.env.CAIRN_TZ = tz;
    try { return fn(); }
    finally { if (prev === undefined) delete process.env.CAIRN_TZ; else process.env.CAIRN_TZ = prev; }
  }

  it('returns the raw UTC ISO unchanged when CAIRN_TZ is unset', () => {
    withTz(undefined, () => assert.equal(formatTimestamp(iso), iso));
  });

  it('localizes to CAIRN_TZ — a UTC evening reads as the previous local day', () => {
    withTz('America/Jamaica', () => {
      const out = formatTimestamp(iso);
      assert.match(out, /^2026-08-27 20:00/, `expected local Jamaica time, got "${out}"`);
    });
  });

  it('falls back to the raw ISO on an invalid timezone', () => {
    withTz('Not/AZone', () => assert.equal(formatTimestamp(iso), iso));
  });

  it('returns "never" for null/undefined', () => {
    assert.equal(formatTimestamp(null), 'never');
    assert.equal(formatTimestamp(undefined), 'never');
  });
});
