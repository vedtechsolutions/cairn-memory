/**
 * writeFileAtomic — the ONE temp-plus-rename implementation. Pins the
 * properties the six former copies disagreed on: an unpredictable, exclusive
 * temp name (a planted symlink at the old `<path>.<pid>.tmp` name redirected
 * a write — Codex pack review, Z3), no temp litter after a failure, the
 * regular-file refusal the pack codec relies on, and the mode/durable options
 * the migration marker relies on.
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writeFileAtomic, writeTempExclusive, isRegularFile } from '../src/utils/atomic-write.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs.length = 0; });
function dir(): string {
  const d = mkdtempSync(join(tmpdir(), 'cairn-atomic-'));
  dirs.push(d);
  return d;
}
const entries = (d: string): string[] => readdirSync(d).sort();

describe('writeFileAtomic', () => {
  it('creates and replaces a file, leaving no temp behind', () => {
    const d = dir();
    const target = join(d, 'state.json');
    writeFileAtomic(target, 'one');
    assert.equal(readFileSync(target, 'utf-8'), 'one');
    writeFileAtomic(target, 'two');
    assert.equal(readFileSync(target, 'utf-8'), 'two');
    assert.deepEqual(entries(d), ['state.json'], 'no temp litter');
  });

  it('never uses the predictable <path>.<pid>.tmp name', () => {
    // The old name could be pre-planted as a symlink; the exclusive open of
    // an unpredictable name cannot be pre-planted at all.
    const d = dir();
    const target = join(d, 'f');
    const planted = `${target}.${process.pid}.tmp`;
    symlinkSync(join(d, 'elsewhere'), planted);
    writeFileAtomic(target, 'x');
    assert.equal(readFileSync(target, 'utf-8'), 'x');
    assert.ok(lstatSync(planted).isSymbolicLink() && readlinkSync(planted) === join(d, 'elsewhere'), 'the planted link is untouched');
    assert.equal(existsSync(join(d, 'elsewhere')), false, 'nothing was written through the link');
    assert.equal(isRegularFile(planted), false);
  });

  it('the temp is exclusive: a name collision is retried, never written through, and gives up after the budget', () => {
    const d = dir();
    const taken = join(d, '.a.taken.tmp');
    writeFileSync(taken, 'someone else');
    // Attempt 0 collides with the pre-existing name; attempt 1 gets a fresh one.
    const names = [taken, join(d, '.a.fresh.tmp')];
    const tmp = writeTempExclusive(join(d, 'a'), 'mine', undefined, { tempName: (n) => names[n] ?? join(d, `.a.extra${n}.tmp`) });
    assert.equal(tmp, names[1], 'the collision was retried with the next name');
    assert.equal(readFileSync(taken, 'utf-8'), 'someone else', 'the colliding file was not written through');
    assert.equal(readFileSync(tmp, 'utf-8'), 'mine');
    // Every attempt colliding exhausts the budget with a clear error.
    assert.throws(() => writeTempExclusive(join(d, 'a'), 'x', undefined, { tempName: () => taken }), /could not allocate a temp file/u);
    assert.equal(readFileSync(taken, 'utf-8'), 'someone else');
  });

  it('a failure after the exclusive create (a full disk, an I/O error) removes the partial temp', () => {
    // ENOSPC cannot be produced portably; the seam throws at the same point.
    const d = dir();
    assert.throws(() => writeFileAtomic(join(d, 'f'), 'x', {}, { onCreated: () => { throw new Error('ENOSPC (simulated)'); } }), /ENOSPC/u);
    assert.deepEqual(entries(d), [], 'no partial temp left behind');
  });

  it('refuseNonRegular rejects a directory or a symlink destination and leaves it alone', () => {
    const d = dir();
    const asDir = join(d, 'd');
    mkdirSync(asDir);
    assert.throws(() => writeFileAtomic(asDir, 'x', { refuseNonRegular: true }), /not a regular file/u);
    const link = join(d, 'link');
    writeFileSync(join(d, 'real'), 'real');
    symlinkSync(join(d, 'real'), link);
    assert.throws(() => writeFileAtomic(link, 'x', { refuseNonRegular: true }), /not a regular file/u);
    assert.equal(readFileSync(join(d, 'real'), 'utf-8'), 'real', 'the link target was not written through');
    // A DANGLING symlink is still a symlink: existsSync would call it absent (Codex review).
    const dangling = join(d, 'dangling');
    symlinkSync(join(d, 'nowhere'), dangling);
    assert.throws(() => writeFileAtomic(dangling, 'x', { refuseNonRegular: true }), /not a regular file/u);
    assert.ok(lstatSync(dangling).isSymbolicLink(), 'the dangling link was not replaced');
    assert.deepEqual(entries(d), ['d', 'dangling', 'link', 'real'], 'no temp litter after the refusals');
  });

  it('removes its temp when the rename fails', () => {
    const d = dir();
    const target = join(d, 'occupied');
    mkdirSync(target); // rename of a file onto a non-empty-or-directory path fails
    writeFileSync(join(target, 'child'), '');
    assert.throws(() => writeFileAtomic(target, 'x'));
    assert.deepEqual(entries(d), ['occupied'], 'the temp was cleaned up');
  });

  it('applies mode and survives durable on an ordinary filesystem', () => {
    const d = dir();
    const target = join(d, 'marker.json');
    writeFileAtomic(target, '{}', { mode: 0o600, durable: true });
    assert.equal(statSync(target).mode & 0o777, 0o600);
    assert.equal(readFileSync(target, 'utf-8'), '{}');
  });
});
