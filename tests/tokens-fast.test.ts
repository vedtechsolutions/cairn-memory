import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { estimateTokensFast, estimateTokens } from '../src/utils/tokens.js';

describe('estimateTokensFast', () => {
  it('returns 0 for empty string', () => {
    assert.equal(estimateTokensFast(''), 0);
  });

  it('returns a positive integer for non-empty text', () => {
    const n = estimateTokensFast('hello world');
    assert.ok(Number.isInteger(n));
    assert.ok(n > 0);
  });

  it('is monotonic in string length', () => {
    const a = estimateTokensFast('short');
    const b = estimateTokensFast('a much longer example sentence here');
    assert.ok(b > a);
  });

  it('overestimates relative to real countTokens on briefing-style content', () => {
    // Real briefing-style content has ~3.75 chars/token on average.
    // The fast estimator uses /3.0 which overestimates by roughly 25% aggregate.
    const briefing = [
      '[Waykeep Memory Briefing]',
      'Project: cairn-2f161aa3',
      'Stack: TypeScript/Node.js | src/{constants/,db/,hooks/,mcp/,utils/}',
      'Git: branch: feat/primary-memory-integration, 22 uncommitted files',
      'Decisions:',
      '  - Use sqlite-vec over pgvector for single-file deployment simplicity',
      '  - Tier-based briefing allocation with effectiveness ranking',
      'Pitfalls:',
      '  - Corrections stored via cairn_learn must be distilled one-sentence lessons',
    ].join('\n');
    const fast = estimateTokensFast(briefing);
    const real = estimateTokens(briefing);
    // Fast should be within a sane range: at least the real count, and not more
    // than double it. These bounds are loose on purpose — the contract is
    // "safe overestimate for budget gating", not exact.
    assert.ok(fast >= real, `fast (${fast}) must be >= real (${real}) for safe gating`);
    assert.ok(fast <= real * 2, `fast (${fast}) should not exceed 2x real (${real})`);
  });

  it('is dramatically faster than real estimateTokens', () => {
    const line = '  - example briefing line with some reasonable content';
    // Warm the real tokenizer first so the comparison is fair.
    estimateTokens(line);
    const t0 = Date.now();
    for (let i = 0; i < 100; i++) estimateTokensFast(line);
    const fastMs = Date.now() - t0;
    const t1 = Date.now();
    for (let i = 0; i < 100; i++) estimateTokens(line);
    const realMs = Date.now() - t1;
    // Fast must be at least 10x faster; in practice it's closer to 1000x.
    assert.ok(
      fastMs * 10 < realMs,
      `fast=${fastMs}ms real=${realMs}ms — fast must be at least 10x faster`,
    );
  });
});
