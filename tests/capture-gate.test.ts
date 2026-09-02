/**
 * Write-path capture gate (remediation plan, step 1).
 *
 * The defect (M3/M4): `extractDecision` and `extractCorrectionLesson` match
 * their trigger anywhere in the prompt but store the PROMPT PREFIX —
 * `prompt.replace(/\s+/g,' ').slice(0,197)+'...'`. A long paste with a buried
 * trigger therefore persists as an unrelated 200-char fragment: 88 such rows
 * in the live store (83 decisions, 5 corrections), 70 of which do not even
 * contain the trigger that captured them. An `<ide_opened_file>` fragment
 * was stored as an architectural decision this way.
 *
 * The gate (from the dual plan review): a long prompt with a buried trigger
 * must capture THE MATCHING SENTENCE or reject; attributed/transcript-glyph
 * shapes are rejected; legitimate short captures still pass. Raising the cap
 * alone would be a regression (it would store whole transcripts).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractDecision } from '../src/hooks/handlers/prompt/extractors.js';
import { extractCorrectionLesson } from '../src/hooks/handlers/prompt/helpers.js';

const PAD = (n: number, seed = 'the quick brown fox jumps over the lazy dog near the riverbank at dawn ') =>
  Array.from({ length: n }, (_, i) => `${seed}${i}.`).join(' ');

describe('extractDecision — captures the sentence, not the prefix', () => {
  it('legitimate short decision still captures whole (gate: no regression)', () => {
    const p = "we'll use SQLite because the store must be local-first";
    assert.equal(extractDecision(p), p);
  });

  it('buried trigger in a long paste captures the MATCHING sentence, not the opening', () => {
    const decision = "we'll use SQLite because the store must be local-first and zero-config.";
    const prompt = `${PAD(8)} ${decision} ${PAD(8)}`;
    const out = extractDecision(prompt);
    assert.ok(out, 'a real decision with rationale must still be captured');
    assert.ok(out.includes("we'll use SQLite"), `capture must contain the trigger sentence, got: ${out}`);
    assert.ok(!out.startsWith('the quick brown fox'),
      'capture must NOT be the prompt prefix — that is the 88-row defect');
  });

  it('rationale requirement applies to the captured sentence, not the whole prompt', () => {
    // Trigger sentence has no rationale; an unrelated sentence carries
    // "because". The old code conflated them and captured the prefix.
    const prompt = `${PAD(6)} we'll use SQLite for this. ${PAD(3)} It rains because of condensation. ${PAD(3)}`;
    const out = extractDecision(prompt);
    assert.equal(out, null,
      'a trigger sentence without its own rationale must not be captured off another sentence’s "because"');
  });

  it('rejects attributed/IDE XML shapes outright', () => {
    const prompt = `<ide_opened_file>The user opened the file /opt/x.py and we'll use tabs because the linter says so</ide_opened_file> ${PAD(6)}`;
    assert.equal(extractDecision(prompt), null, 'XML-attributed content is not a user decision');
  });

  it('rejects transcript-glyph shapes outright', () => {
    const prompt = `this was where we were ● Monitor(Watch) ⎿ started, we'll use retries because the socket flakes ${PAD(6)}`;
    assert.equal(extractDecision(prompt), null, 'pasted transcript fragments are not decisions');
  });

  it('never emits a bare 197-char prompt-prefix truncation', () => {
    const decision = "we'll use Postgres because pooling matters here.";
    const prompt = `${PAD(12)} ${decision}`;
    const out = extractDecision(prompt);
    assert.ok(out === null || out.includes('Postgres'),
      'output must be the sentence or nothing — never the unrelated prefix');
    if (out) assert.ok(out.length <= 200, 'cap preserved');
  });
});

describe('short prompts with an IDE prelude — sentence rules apply at any length', () => {
  // Recheck finding: the short path blanket-rejected on <ide_opened_file>,
  // suppressing a genuine trailing sentence under 200 chars while the same
  // content over 200 chars captured correctly. Length must not change WHICH
  // sentence is eligible.
  it('short IDE prelude + genuine decision still captures the decision', () => {
    const p = "<ide_opened_file>/opt/x.py</ide_opened_file> we'll use SQLite because atomic writes matter.";
    assert.equal(extractDecision(p), "we'll use SQLite because atomic writes matter.");
  });

  it('short IDE prelude + genuine correction still captures the correction', () => {
    const p = "<ide_opened_file>/opt/x.py</ide_opened_file> don't use Redis for the queue again";
    assert.equal(extractCorrectionLesson(p), "don't use Redis for the queue again");
  });

  it('short prompt whose only decision sits INSIDE the IDE block stays rejected', () => {
    const p = "<ide_opened_file>we'll use tabs because the linter says so</ide_opened_file>";
    assert.equal(extractDecision(p), null);
  });
});

describe('the 200-char seam — pinned and documented', () => {
  // <=200: historical whole-capture, rationale may live in ANY sentence.
  // >200: precision-first sentence selection, rationale must share the
  // trigger's sentence. The discontinuity is deliberate: short prompts are
  // authored messages where the whole IS the decision; long prompts are
  // paste-risk territory where every heuristic tightens at once.
  it('at exactly 200 chars, two-sentence rationale still captures whole', () => {
    const base = "we'll use SQLite here for the store. Because atomic local writes matter a great deal for this design and the io path stays simple in practice";
    const prompt = base + 'x'.repeat(200 - base.length);
    assert.equal(prompt.length, 200);
    assert.equal(extractDecision(prompt), prompt);
  });

  it('at 201 chars, cross-sentence rationale no longer qualifies', () => {
    const base = "we'll use SQLite here for the store. Because atomic local writes matter a great deal for this design and the io path stays simple in practice";
    const prompt = base + 'x'.repeat(201 - base.length);
    assert.equal(prompt.length, 201);
    assert.equal(extractDecision(prompt), null);
  });
});

describe('extractCorrectionLesson — captures the lesson sentence, not the prefix', () => {
  it('legitimate short correction still captures whole (gate: no regression)', () => {
    const p = 'always run the build before claiming a fix works';
    assert.equal(extractCorrectionLesson(`no, ${p}`), p);
  });

  it('long paste with a buried lesson yields the lesson sentence or nothing — never the prefix', () => {
    const prompt = `this was where we were before we got disconnected ${PAD(10)}`;
    const out = extractCorrectionLesson(prompt);
    assert.ok(!out.startsWith('this was where we were'),
      'the exact live-store pollution row must no longer be storable');
  });

  it('rejects transcript glyphs; strips prepended IDE blocks and keeps the authored text', () => {
    assert.equal(extractCorrectionLesson('● Monitor(Watch for test completion) ⎿ started task b2w'), '');
    // CHANGED at recheck round: the well-formed prepended block is stripped
    // and the user's own trailing correction is the lesson — rejecting it
    // suppressed genuine corrections behind short IDE preludes.
    assert.equal(extractCorrectionLesson('<ide_opened_file>/opt/x.py</ide_opened_file> never do that again'),
      'never do that again');
  });

  it('output is never a mid-word 197-char slice of a longer text', () => {
    const prompt = PAD(12); // long, no lesson shape at all
    const out = extractCorrectionLesson(prompt);
    assert.ok(out === '' || !out.endsWith('...') || out.length < 190,
      `prefix-truncation signature detected: ${out.slice(-30)}`);
  });
});
