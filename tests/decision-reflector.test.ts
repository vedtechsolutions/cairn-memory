/**
 * Tests for the Layer 1c Socratic reflection pipeline.
 *
 * Covers:
 *   - countDecisionMarkers: cheap pre-gate regex counter
 *   - renderReflectedDecision: JSON -> memory content formatter
 *   - reflectOnTurn: sampling-gated LLM extraction with graceful fallback
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  countDecisionMarkers,
  reflectOnTurn,
  renderReflectedDecision,
  REFLECTION_MIN_MARKERS,
} from '../src/hooks/shared/decision-reflector.js';

// --- countDecisionMarkers -------------------------------------------

describe('countDecisionMarkers', () => {
  it('returns 0 for empty or very short text', () => {
    assert.equal(countDecisionMarkers(''), 0);
    assert.equal(countDecisionMarkers('short'), 0);
  });

  it('counts recommendation markers', () => {
    const text = 'After looking at the options, my recommendation is to go with PostgreSQL.';
    assert.ok(countDecisionMarkers(text) >= 1);
  });

  it('counts multiple distinct markers in one turn', () => {
    const text = 'My recommendation is bun instead of node. I would push back on using deno for this case.';
    const count = countDecisionMarkers(text);
    assert.ok(count >= 2, `expected >= 2 markers, got ${count}`);
  });

  it('counts each pattern at most once (dedup)', () => {
    const text = 'I recommend X. I recommend Y. I recommend Z. I recommend W.';
    // Four "I recommend" hits but only one pattern matches them all -> 1
    assert.equal(countDecisionMarkers(text), 1);
  });

  it('ignores markers inside fenced code blocks', () => {
    const text = '```\nmy recommendation is X instead of Y\n```\nJust showing the example.';
    assert.equal(countDecisionMarkers(text), 0);
  });

  it('ignores markers inside inline backticks', () => {
    const text = 'The convention is `going with X instead of Y` in shell scripts.';
    assert.equal(countDecisionMarkers(text), 0);
  });

  it('counts architectural framing language', () => {
    const text = 'The approach is to layer a cheap gate on top of an expensive one. The design keeps reflection opt-in.';
    const count = countDecisionMarkers(text);
    assert.ok(count >= 1);
  });

  it('counts tradeoff framing language', () => {
    const text = 'The cost is an extra inference per turn, but the payoff is reliable capture. The gap is that regex misses markdown.';
    const count = countDecisionMarkers(text);
    assert.ok(count >= 1);
  });

  it('counts sigil presence', () => {
    const text = 'Some prose then [dec: chose lazy on-demand extraction because graph maintenance dominates] more prose.';
    assert.ok(countDecisionMarkers(text) >= 1);
  });

  it('returns a count sufficient to trigger reflection on a real assistant turn', () => {
    // Approximation of a typical architectural recommendation paragraph.
    const text = [
      'After weighing the options I would recommend going with the cheaper path.',
      'The approach is to add a detector layer on top of the existing Stop hook.',
      'The cost is minimal and the payoff is explicit-authorship capture.',
      'I would push back on building a full graph — the maintenance tax is too high.',
    ].join(' ');
    assert.ok(countDecisionMarkers(text) >= REFLECTION_MIN_MARKERS);
  });
});

// --- renderReflectedDecision ----------------------------------------

describe('renderReflectedDecision', () => {
  it('formats chose + why as "X because Y"', () => {
    const result = renderReflectedDecision({
      chose: 'lazy on-demand symbol extraction',
      why: 'persistent code graph maintenance dominates the benefit',
    });
    assert.ok(result.startsWith('lazy on-demand symbol extraction'));
    assert.ok(result.includes('because'));
    assert.ok(result.includes('maintenance dominates'));
  });

  it('truncates long content at 200 chars with trailing ...', () => {
    const result = renderReflectedDecision({
      chose: 'very long choice ' + 'xxxxx '.repeat(30),
      why: 'because ' + 'reason '.repeat(30),
    });
    assert.ok(result.length <= 200);
    assert.ok(result.endsWith('...'));
  });

  it('handles empty why by returning chose alone', () => {
    const result = renderReflectedDecision({
      chose: 'simple choice',
      why: '',
    });
    assert.equal(result, 'simple choice');
  });

  it('returns empty string when chose is blank', () => {
    const result = renderReflectedDecision({ chose: '   ', why: 'reason' });
    assert.equal(result, '');
  });
});

// --- reflectOnTurn --------------------------------------------------

/** Build a mock MCP inner server that responds with a given JSON string
 *  or throws a given error. Omit `samplingCapable` to simulate a client
 *  that didn't negotiate sampling. */
function mockInnerServer(opts: {
  samplingCapable: boolean;
  responseText?: string;
  throwError?: boolean;
}): Server {
  return {
    getClientCapabilities: () => opts.samplingCapable ? { sampling: {} } : {},
    createMessage: async (_req: unknown) => {
      if (opts.throwError) throw new Error('simulated sampling error');
      return {
        content: [{ type: 'text', text: opts.responseText ?? '{"decisions":[]}' }],
      };
    },
  } as unknown as Server;
}

describe('reflectOnTurn', () => {
  const sampleTurn = 'After weighing the tradeoffs I recommend the lazy extraction path because the maintenance cost of a persistent graph dominates.';

  it('returns empty when innerServer is undefined', async () => {
    const result = await reflectOnTurn(sampleTurn, undefined);
    assert.deepEqual(result, []);
  });

  it('returns empty when client did not negotiate sampling', async () => {
    const server = mockInnerServer({ samplingCapable: false });
    const result = await reflectOnTurn(sampleTurn, server);
    assert.deepEqual(result, []);
  });

  it('returns empty on very short input', async () => {
    const server = mockInnerServer({ samplingCapable: true });
    const result = await reflectOnTurn('short', server);
    assert.deepEqual(result, []);
  });

  it('parses a happy-path JSON response', async () => {
    const server = mockInnerServer({
      samplingCapable: true,
      responseText: '{"decisions":[{"chose":"lazy extraction","why":"maintenance cost dominates"}]}',
    });
    const result = await reflectOnTurn(sampleTurn, server);
    assert.equal(result.length, 1);
    assert.equal(result[0].chose, 'lazy extraction');
    assert.equal(result[0].why, 'maintenance cost dominates');
  });

  it('parses JSON wrapped in markdown code fences', async () => {
    const server = mockInnerServer({
      samplingCapable: true,
      responseText: '```json\n{"decisions":[{"chose":"lazy extraction","why":"maintenance cost"}]}\n```',
    });
    const result = await reflectOnTurn(sampleTurn, server);
    assert.equal(result.length, 1);
    assert.equal(result[0].chose, 'lazy extraction');
  });

  it('tolerates leading explanatory prose before JSON', async () => {
    const server = mockInnerServer({
      samplingCapable: true,
      responseText: 'Here are the decisions I found:\n{"decisions":[{"chose":"sigil path","why":"explicit authorship"}]}',
    });
    const result = await reflectOnTurn(sampleTurn, server);
    assert.equal(result.length, 1);
    assert.equal(result[0].chose, 'sigil path');
  });

  it('returns empty on malformed JSON', async () => {
    const server = mockInnerServer({
      samplingCapable: true,
      responseText: 'not json at all, sorry',
    });
    const result = await reflectOnTurn(sampleTurn, server);
    assert.deepEqual(result, []);
  });

  it('returns empty when model returns empty decisions array', async () => {
    const server = mockInnerServer({
      samplingCapable: true,
      responseText: '{"decisions":[]}',
    });
    const result = await reflectOnTurn(sampleTurn, server);
    assert.deepEqual(result, []);
  });

  it('returns empty when sampling call throws', async () => {
    const server = mockInnerServer({ samplingCapable: true, throwError: true });
    const result = await reflectOnTurn(sampleTurn, server);
    assert.deepEqual(result, []);
  });

  it('caps extracted decisions at REFLECTION_MAX_DECISIONS', async () => {
    const many = '{"decisions":[' +
      '{"chose":"A","why":"a"},' +
      '{"chose":"B","why":"b"},' +
      '{"chose":"C","why":"c"},' +
      '{"chose":"D","why":"d"},' +
      '{"chose":"E","why":"e"}' +
      ']}';
    const server = mockInnerServer({ samplingCapable: true, responseText: many });
    const result = await reflectOnTurn(sampleTurn, server);
    assert.ok(result.length <= 3, `expected <= 3 decisions, got ${result.length}`);
  });

  it('skips decisions with empty or too-short chose field', async () => {
    const response = '{"decisions":[' +
      '{"chose":"","why":"reason"},' +
      '{"chose":"ok","why":"valid"},' +
      '{"chose":"good choice","why":"valid"}' +
      ']}';
    const server = mockInnerServer({ samplingCapable: true, responseText: response });
    const result = await reflectOnTurn(sampleTurn, server);
    // "" rejected, "ok" rejected (too short), "good choice" kept
    assert.equal(result.length, 1);
    assert.equal(result[0].chose, 'good choice');
  });

  it('returns empty when response shape is wrong', async () => {
    const server = mockInnerServer({
      samplingCapable: true,
      responseText: '{"notDecisions":["X"]}',
    });
    const result = await reflectOnTurn(sampleTurn, server);
    assert.deepEqual(result, []);
  });
});
