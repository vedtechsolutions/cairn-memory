/**
 * Contextual embedding text (roadmap W2 item 5) — pure construction rules
 * and the benchmark runner's document-side-only application. CI-safe:
 * fake embed fns, no model downloads.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildContextualEmbedText } from '../src/utils/contextual-embed.js';
import { runBenchmark, type EmbedFn } from '../src/benchmark/longmemeval/runner.js';
import { validateDataset, type LmeQuestion } from '../src/benchmark/longmemeval/data.js';

const FIXTURE_PATH = join(process.cwd(), 'scripts', 'longmemeval', 'fixture', 'harness-fixture.json');
const loadFixture = (): LmeQuestion[] => validateDataset(JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')));

describe('buildContextualEmbedText — construction rules', () => {
  it('joins kind, content, context fields, and fingerprint terms with pipes', () => {
    assert.equal(
      buildContextualEmbedText({
        kind: 'pitfall',
        content: 'never edit harness scripts mid-run',
        context: { why: 'scripts execute from source', how_to_apply: 'edit after the run completes' },
        fingerprintTerms: ['typescript', 'node'],
      }),
      '[pitfall] never edit harness scripts mid-run | scripts execute from source | edit after the run completes | typescript node',
    );
  });

  it('omits empty segments — a bare memory embeds as "[kind] content"', () => {
    assert.equal(
      buildContextualEmbedText({ kind: 'fact', content: 'the staging db runs postgres' }),
      '[fact] the staging db runs postgres',
    );
    assert.equal(
      buildContextualEmbedText({ kind: 'fact', content: 'x', context: {}, fingerprintTerms: [] }),
      '[fact] x',
    );
  });

  it('includes partial context (why only)', () => {
    assert.equal(
      buildContextualEmbedText({ kind: 'decision', content: 'chose sqlite', context: { why: 'sync access' } }),
      '[decision] chose sqlite | sync access',
    );
  });

  it('trims segments and omits whitespace-only context and fingerprint terms', () => {
    assert.equal(
      buildContextualEmbedText({
        kind: 'fact',
        content: 'x',
        context: { why: '  padded why  ', how_to_apply: '   ' },
        fingerprintTerms: ['  ', '\t', ' rust '],
      }),
      '[fact] x | padded why | rust',
      'whitespace-only segments must vanish, padded ones must trim',
    );
  });
});

describe('runner — contextual embedding is document-side only', () => {
  const q = (): LmeQuestion => loadFixture().find(x => !x.question_id.endsWith('_abs'))!;

  it('prefixes document texts, leaves the query raw, and labels the variant +ctx', async () => {
    const docTexts: string[] = [];
    const queryTexts: string[] = [];
    const fakeEmbed: EmbedFn = async (text, role) => {
      (role === 'document' ? docTexts : queryTexts).push(text);
      const v = new Float32Array(8);
      v[0] = 1;
      return v;
    };
    const question = q();
    const run = await runBenchmark([question], { variant: 'hybrid', ks: [5], embedFn: fakeEmbed, contextualEmbed: true });

    assert.equal(run.variantLabel, 'hybrid+ctx');
    assert.equal(run.contextualEmbed, true);
    assert.ok(docTexts.length > 0);
    assert.ok(docTexts.every(t => t.startsWith('[fact] ')), 'every document embeds with the [kind] prefix');
    assert.deepEqual(queryTexts, [question.question], 'the query embeds RAW — contextual text is document-side only');
  });

  it('rejects contextualEmbed without hybrid embeddings at the runner level, not only the CLI', async () => {
    await assert.rejects(
      runBenchmark([q()], { variant: 'hybrid', ks: [5], contextualEmbed: true }),
      /contextualEmbed requires variant "hybrid" with an embedFn/,
      'no embedFn must throw',
    );
    await assert.rejects(
      runBenchmark([q()], { variant: 'fts', ks: [5], contextualEmbed: true }),
      /contextualEmbed requires variant "hybrid" with an embedFn/,
      'fts variant must throw',
    );
  });

  it('without the flag, documents embed raw and the label has no +ctx suffix', async () => {
    const docTexts: string[] = [];
    const fakeEmbed: EmbedFn = async (text, role) => {
      if (role === 'document') docTexts.push(text);
      const v = new Float32Array(8);
      v[0] = 1;
      return v;
    };
    const run = await runBenchmark([q()], { variant: 'hybrid', ks: [5], embedFn: fakeEmbed });
    assert.equal(run.variantLabel, 'hybrid');
    assert.equal(run.contextualEmbed, false);
    assert.ok(docTexts.every(t => !t.startsWith('[fact] ')), 'raw contents without the flag');
  });
});
