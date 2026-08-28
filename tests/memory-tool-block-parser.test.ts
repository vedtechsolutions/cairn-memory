/**
 * Strict §5 block grammar (W4 command-handler slice) — every deviation
 * from the canonical rendered form fails the WHOLE parse, nothing partial.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseBlocks } from '../src/memory-tool/block-parser.js';

const TOKEN = '[fac:0123abcd@3]';

describe('block starts', () => {
  it('parses a tokened block with all continuation fields in order', () => {
    const blocks = parseBlocks([
      `- ${TOKEN} content: "the fact"`,
      '  why: "the reason"',
      '  how: "the application"',
      '  tags: ["a","b"]',
    ].join('\n'));
    assert.equal(blocks.length, 1);
    assert.deepEqual(blocks[0].token, { code: 'fac', idPrefix: '0123abcd', revision: 3 });
    assert.equal(blocks[0].content, 'the fact');
    assert.equal(blocks[0].why, 'the reason');
    assert.equal(blocks[0].how, 'the application');
    assert.deepEqual(blocks[0].tags, ['a', 'b']);
  });

  it('parses a token-less create block and leaves omitted fields undefined', () => {
    const [block] = parseBlocks('- content: "new fact"');
    assert.equal(block.token, undefined);
    assert.equal(block.content, 'new fact');
    assert.equal(block.why, undefined);
    assert.equal(block.how, undefined);
    assert.equal(block.tags, undefined);
  });

  it('parses multiple blocks and attributes continuations to the nearest start', () => {
    const blocks = parseBlocks([
      `- ${TOKEN} content: "first"`,
      '  tags: []',
      '- content: "second"',
      '  why: null',
    ].join('\n'));
    assert.equal(blocks.length, 2);
    assert.deepEqual(blocks[0].tags, []);
    assert.equal(blocks[1].why, null);
  });

  it('parses a 12-char extended (collision) token prefix', () => {
    const [block] = parseBlocks('- [pit:0123abcd0123@1] content: "x"');
    assert.equal(block.token?.idPrefix, '0123abcd0123');
  });

  it('distinguishes null (clear) from omission for why/how, [] for tags', () => {
    const [block] = parseBlocks([
      `- ${TOKEN} content: "c"`,
      '  why: null',
      '  tags: []',
    ].join('\n'));
    assert.equal(block.why, null);
    assert.equal(block.how, undefined);
    assert.deepEqual(block.tags, []);
  });
});

describe('fail-closed rejections', () => {
  const rejects = (text: string, pattern: RegExp): void => {
    assert.throws(() => parseBlocks(text), (err: Error) => {
      assert.match(err.message, pattern);
      assert.doesNotMatch(err.message, /^Error: /);
      return true;
    });
  };

  it('rejects empty and whitespace-only input', () => {
    rejects('', /empty input/);
    rejects('   ', /blank lines/);
  });

  it('rejects blank lines anywhere', () => {
    rejects(`- ${TOKEN} content: "a"\n\n- content: "b"`, /blank lines/);
  });

  it('rejects unknown kind codes', () => {
    rejects('- [xyz:0123abcd@1] content: "a"', /unrecognized line|unknown kind code/);
  });

  it('rejects token prefixes shorter than 8 chars', () => {
    rejects('- [fac:0123abc@1] content: "a"', /unrecognized line|prefix/);
  });

  it('rejects revision 0 and non-numeric revisions', () => {
    rejects('- [fac:0123abcd@0] content: "a"', /revision must be a positive integer/);
    rejects('- [fac:0123abcd@x] content: "a"', /unrecognized line/);
  });

  it('rejects uppercase-hex token prefixes', () => {
    rejects('- [fac:0123ABCD@1] content: "a"', /unrecognized line/);
  });

  it('rejects non-JSON and non-string content values', () => {
    rejects('- content: bare words', /content is not one-line JSON/);
    rejects('- content: 42', /content must be a JSON string/);
    rejects('- content: null', /content cannot be null/);
  });

  it('rejects out-of-order continuation fields', () => {
    rejects(`- ${TOKEN} content: "c"\n  how: "h"\n  why: "w"`, /out of order or duplicated/);
    rejects(`- ${TOKEN} content: "c"\n  tags: []\n  why: "w"`, /out of order or duplicated/);
  });

  it('rejects duplicated continuation fields', () => {
    rejects(`- ${TOKEN} content: "c"\n  why: "a"\n  why: "b"`, /out of order or duplicated/);
  });

  it('rejects a continuation line before any block start', () => {
    rejects('  why: "orphan"', /continuation line before any block start/);
  });

  it('rejects the system-managed confidence field with a dedicated message', () => {
    rejects(`- ${TOKEN} content: "c"\n  confidence: 0.9`, /confidence is system-managed and cannot be edited/);
  });

  it('rejects tags that are not arrays of strings', () => {
    rejects(`- ${TOKEN} content: "c"\n  tags: "solo"`, /tags must be a JSON array of strings/);
    rejects(`- ${TOKEN} content: "c"\n  tags: [1,2]`, /tags must be a JSON array of strings/);
    rejects(`- ${TOKEN} content: "c"\n  tags: not json`, /tags is not one-line JSON/);
  });

  it('rejects why/how values that are not strings or null', () => {
    rejects(`- ${TOKEN} content: "c"\n  why: 42`, /why must be a JSON string or null/);
    rejects(`- ${TOKEN} content: "c"\n  how: ["arr"]`, /how must be a JSON string or null/);
  });

  it('rejects unrecognized lines, wrong indentation, and unknown fields', () => {
    rejects('stray text', /unrecognized line/);
    rejects(`- ${TOKEN} content: "c"\n why: "one-space indent"`, /unrecognized line/);
    rejects(`- ${TOKEN} content: "c"\n   why: "three-space indent"`, /unrecognized line/);
    rejects(`- ${TOKEN} content: "c"\n  project: "p"`, /unrecognized line/);
  });

  it('one malformed line poisons the whole parse — earlier valid blocks are not returned', () => {
    assert.throws(() => parseBlocks('- content: "valid"\ngarbage'), /unrecognized line/);
  });
});
