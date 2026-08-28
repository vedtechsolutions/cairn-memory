import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractReasoningState, extractErrorContext, distillGoal, isApproachNote, isMetaGoal } from '../src/hooks/shared/transcript-parser.js';
import { compileBriefing, type BriefingContext } from '../src/hooks/shared/briefing-compiler.js';
import { openDatabase } from '../src/db/connection.js';
import { MemoryRepository } from '../src/db/memory-repository.js';
import { PlanRepository } from '../src/db/plan-repository.js';

describe('extractReasoningState', () => {
  it('should extract hypothesis from "I think" pattern', () => {
    const result = extractReasoningState([
      'I think the bug is in the RRF scoring because keyword results look correct but vector results are stale.',
    ]);
    assert.equal(result.hypotheses.length, 1);
    assert.ok(result.hypotheses[0].includes('RRF scoring'));
  });

  it('should extract hypothesis from "this might be because" pattern', () => {
    const result = extractReasoningState([
      'The test is failing. This might be because the mock data does not match the new schema.',
    ]);
    assert.equal(result.hypotheses.length, 1);
    assert.ok(result.hypotheses[0].includes('mock data'));
  });

  it('should extract open question from "need to check" pattern', () => {
    const result = extractReasoningState([
      'We need to check whether the migration runs correctly on existing databases.',
    ]);
    assert.equal(result.openQuestions.length, 1);
    assert.ok(result.openQuestions[0].includes('migration'));
  });

  it('should extract open question from "not sure" pattern', () => {
    const result = extractReasoningState([
      'I am not sure why the confidence decay is not triggering during maintenance.',
    ]);
    assert.equal(result.openQuestions.length, 1);
    assert.ok(result.openQuestions[0].includes('confidence decay'));
  });

  it('should deduplicate identical hypotheses from different text blocks', () => {
    const result = extractReasoningState([
      'I think the bug is in the RRF scoring normalization layer which causes incorrect results.',
      'After more investigation, I think the bug is in the RRF scoring normalization layer which causes incorrect results.',
    ]);
    assert.equal(result.hypotheses.length, 1);
  });

  it('should cap at 3 hypotheses and 3 questions', () => {
    const texts = [
      'I think problem A is the root cause.',
      'I suspect problem B is related.',
      'I believe problem C matters too.',
      'I think problem D is also involved.',
      'Need to check X for issues.',
      'Need to verify Y works correctly.',
      'Need to confirm Z is compatible.',
      'Not sure if W will break things.',
    ];
    const result = extractReasoningState(texts);
    assert.ok(result.hypotheses.length <= 3);
    assert.ok(result.openQuestions.length <= 3);
  });

  it('should return empty for non-reasoning text', () => {
    const result = extractReasoningState([
      'Here is the implementation of the feature.',
      'All tests pass. Build is clean.',
    ]);
    assert.equal(result.hypotheses.length, 0);
    assert.equal(result.openQuestions.length, 0);
  });
});

describe('extractErrorContext', () => {
  it('should deduplicate errors by normalized key', () => {
    const result = extractErrorContext([
      { error: 'TypeError: Cannot read property "foo" of undefined at line 42', file: 'app.ts' },
      { error: 'TypeError: Cannot read property "bar" of undefined at line 87', file: 'util.ts' },
    ]);
    assert.equal(result.length, 1);
    assert.equal(result[0].count, 2);
    assert.equal(result[0].lastFile, 'util.ts');
  });

  it('should sort by count descending', () => {
    const result = extractErrorContext([
      { error: 'SyntaxError: unexpected token at line 10', file: 'a.ts' },
      { error: 'TypeError: undefined is not a function', file: 'b.ts' },
      { error: 'TypeError: undefined is not a function', file: 'c.ts' },
      { error: 'TypeError: undefined is not a function', file: 'd.ts' },
    ]);
    assert.equal(result[0].errorKey.includes('TypeError'), true);
    assert.equal(result[0].count, 3);
  });

  it('should cap at 5 unique errors', () => {
    const errors = Array.from({ length: 10 }, (_, i) => ({
      error: `UniqueError${i}: something went wrong`,
      file: `file${i}.ts`,
    }));
    const result = extractErrorContext(errors);
    assert.ok(result.length <= 5);
  });

  it('should return empty for no errors', () => {
    const result = extractErrorContext([]);
    assert.equal(result.length, 0);
  });
});

describe('distillGoal', () => {
  it('should strip "we need to" prefix', () => {
    const result = distillGoal('we need to get to at least 95 to 100% SNR');
    assert.ok(!result.toLowerCase().startsWith('we need to'));
    assert.ok(result.includes('95'));
  });

  it('should strip "please" prefix', () => {
    const result = distillGoal('please implement the authentication module');
    assert.ok(!result.toLowerCase().startsWith('please'));
    assert.ok(result.toLowerCase().includes('implement'));
  });

  it('should strip "let\'s start" prefix', () => {
    const result = distillGoal("let's start investigating the performance issue");
    assert.ok(!result.toLowerCase().startsWith("let's"));
    assert.ok(result.toLowerCase().includes('investigat'));
  });

  it('should capitalize first letter', () => {
    const result = distillGoal('we need to fix the bug');
    assert.ok(/^[A-Z]/.test(result), `should start uppercase: "${result}"`);
  });

  it('should cap at 500 chars', () => {
    const long = 'we need to ' + 'x'.repeat(600);
    const result = distillGoal(long);
    assert.ok(result.length <= 500);
  });

  it('should strip trailing dots', () => {
    const result = distillGoal('we need to fix the issue...');
    assert.ok(!result.endsWith('...'));
  });

  it('should handle already-clean goals', () => {
    const result = distillGoal('Implement tier-based briefing allocation');
    assert.equal(result, 'Implement tier-based briefing allocation');
  });
});

describe('Briefing: Reasoning State Rendering', () => {
  it('should render hypotheses and open questions in compact briefing', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    const memRepo = new MemoryRepository(db);
    const planRepo = new PlanRepository(db);

    const ctx: BriefingContext = {
      project: 'tp',
      sessionType: 'compact',
      interrupted: false,
      compactionSnapshot: {
        recentFiles: ['src/app.ts'],
        recentReadFiles: [],
        recentCommands: [],
        userContext: ['fix the scoring bug'],
        approachNotes: [],
        initialGoal: 'Fix the scoring bug',
        recentDecisions: [],
        reasoningState: {
          hypotheses: ['the RRF scoring has a normalization bug'],
          openQuestions: ['whether vector results are being cached correctly'],
        },
        errorContext: [{ errorKey: 'TypeError: Cannot read ""', count: 3, lastFile: 'scoring.ts' }],
      },
    };
    const result = compileBriefing(memRepo, planRepo, ctx);
    assert.ok(result.text.includes('Hypotheses:'), 'should render hypotheses');
    assert.ok(result.text.includes('RRF scoring'), 'should include hypothesis content');
    assert.ok(result.text.includes('Open questions:'), 'should render open questions');
    assert.ok(result.text.includes('vector results'), 'should include question content');
    assert.ok(result.text.includes('Errors:'), 'should render error context');
    assert.ok(result.text.includes('TypeError'), 'should include error key');
    db.close();
  });

  it('should not render reasoning state for startup sessions', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    const memRepo = new MemoryRepository(db);
    const planRepo = new PlanRepository(db);

    const ctx: BriefingContext = {
      project: 'tp',
      sessionType: 'startup',
      interrupted: false,
    };
    const result = compileBriefing(memRepo, planRepo, ctx);
    assert.ok(!result.text.includes('Hypotheses:'));
    assert.ok(!result.text.includes('Open questions:'));
    db.close();
  });

  it('should skip empty reasoning state', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    const memRepo = new MemoryRepository(db);
    const planRepo = new PlanRepository(db);

    const ctx: BriefingContext = {
      project: 'tp',
      sessionType: 'compact',
      interrupted: false,
      compactionSnapshot: {
        recentFiles: [],
        recentReadFiles: [],
        recentCommands: [],
        userContext: ['do the thing'],
        approachNotes: [],
        initialGoal: 'Do the thing',
        recentDecisions: [],
        reasoningState: { hypotheses: [], openQuestions: [] },
        errorContext: [],
      },
    };
    const result = compileBriefing(memRepo, planRepo, ctx);
    assert.ok(!result.text.includes('Hypotheses:'));
    assert.ok(!result.text.includes('Open questions:'));
    assert.ok(!result.text.includes('Errors:'));
    db.close();
  });
});

describe('extractReasoningState: multiline + resolution', () => {
  it('should extract hypotheses from multi-line text', () => {
    const result = extractReasoningState([
      'Looking at the error trace,\nI think the normalization layer\nis applying the wrong scale factor to vector results.',
    ]);
    assert.equal(result.hypotheses.length, 1);
    assert.ok(result.hypotheses[0].includes('normalization layer'));
    assert.ok(result.hypotheses[0].includes('scale factor'));
  });

  it('should extract "probably because" hypotheses', () => {
    const result = extractReasoningState([
      'The test is failing probably because the mock data is stale.',
    ]);
    assert.equal(result.hypotheses.length, 1);
    assert.ok(result.hypotheses[0].includes('mock data'));
  });

  it('should extract "still need to understand" questions', () => {
    const result = extractReasoningState([
      'We still need to understand why the migration fails on empty databases.',
    ]);
    assert.equal(result.openQuestions.length, 1);
    assert.ok(result.openQuestions[0].includes('migration'));
  });

  it('should extract "must investigate" questions', () => {
    const result = extractReasoningState([
      'We must investigate whether the cache TTL is causing stale reads.',
    ]);
    assert.equal(result.openQuestions.length, 1);
    assert.ok(result.openQuestions[0].includes('cache TTL'));
  });

  it('should filter resolved hypotheses', () => {
    const result = extractReasoningState([
      'I think the bug is in the scoring normalization because results look wrong.',
      'After checking, the bug was in the scoring normalization. Fixed by clamping values.',
    ]);
    // Hypothesis should be resolved — second text says "the bug was" with keyword overlap
    assert.equal(result.hypotheses.length, 0);
  });

  it('should filter resolved questions', () => {
    const result = extractReasoningState([
      'Need to check whether the migration runs on empty databases.',
      'Confirmed that the migration handles empty databases correctly.',
    ]);
    assert.equal(result.openQuestions.length, 0);
  });

  it('should keep unresolved hypotheses when resolution has no keyword overlap', () => {
    const result = extractReasoningState([
      'I think the memory consolidation has a bug in the clustering threshold.',
      'Confirmed that the API endpoint returns the correct status code.',
    ]);
    // Different topics — hypothesis should NOT be resolved
    assert.equal(result.hypotheses.length, 1);
    assert.ok(result.hypotheses[0].includes('consolidation'));
  });

  it('should handle mixed resolved and unresolved items', () => {
    const result = extractReasoningState([
      'I think problem A is in the token overlap calculation.',
      'I suspect problem B relates to the fingerprint dimension weights.',
      'Found that the token overlap calculation was using the wrong tokenizer.',
    ]);
    // Problem A resolved (keyword overlap: token, overlap, calculation), Problem B not
    assert.equal(result.hypotheses.length, 1);
    assert.ok(result.hypotheses[0].includes('fingerprint'));
  });

  it('should not treat hypothesis restatement as resolution', () => {
    const result = extractReasoningState([
      'I think the issue is in the query builder.',
      'I still think the issue is in the query builder — more evidence supports this.',
    ]);
    // Second text restates hypothesis but has no resolution language ("confirmed", "the bug was", etc.)
    assert.equal(result.hypotheses.length, 1);
  });
});

describe('extractReasoningState: meta-reasoning filter', () => {
  it('should skip hypotheses in text with backticks (code discussion)', () => {
    const result = extractReasoningState([
      'I think the bug is in the `RRF scoring` function because `normalizeScore` returns NaN.',
    ]);
    assert.equal(result.hypotheses.length, 0);
  });

  it('should skip hypotheses in text with regex syntax', () => {
    const result = extractReasoningState([
      'I think the pattern \\bthe bug\\b is matching too broadly because (?:was|is) captures present tense.',
    ]);
    assert.equal(result.hypotheses.length, 0);
  });

  it('should skip hypotheses in quoted text', () => {
    const result = extractReasoningState([
      'The test text says "I think the bug is in the RRF scoring" again, which means the pattern matches.',
    ]);
    assert.equal(result.hypotheses.length, 0);
  });

  it('should skip hypotheses in text discussing patterns/regex', () => {
    const result = extractReasoningState([
      'I think the pattern matches too broadly because RESOLUTION_PATTERNS captures present tense.',
    ]);
    assert.equal(result.hypotheses.length, 0);
  });

  it('should keep genuine hypotheses without code artifacts', () => {
    const result = extractReasoningState([
      'I think the database connection pool is exhausted because the queue keeps growing.',
    ]);
    assert.equal(result.hypotheses.length, 1);
    assert.ok(result.hypotheses[0].includes('connection pool'));
  });

  it('should skip open questions in code discussion', () => {
    const result = extractReasoningState([
      'Need to check whether the `migration` script handles the `ALTER TABLE` correctly.',
    ]);
    assert.equal(result.openQuestions.length, 0);
  });
});

describe('isApproachNote: debugging-conclusion filter', () => {
  it('should reject "found it" debugging conclusions', () => {
    const text = 'Found it. The bug is in the scoring normalization because the regex pattern for resolution detection was matching present tense too broadly and causing false positives in the hypothesis filtering.';
    assert.equal(isApproachNote(text), false);
  });

  it('should reject text with backticks (code discussion)', () => {
    const text = 'The approach is to use `extractSentences` to split text because it handles multi-line content and we need sentence-level precision for hypothesis matching.';
    assert.equal(isApproachNote(text), false);
  });

  it('should reject text with regex syntax', () => {
    const text = 'The approach is to use (?:was|is) pattern because it captures both tenses and we need the resolution detection to handle historical references in the assistant text blocks.';
    assert.equal(isApproachNote(text), false);
  });

  it('should keep genuine approach notes without code artifacts', () => {
    const text = 'The approach is to use sentence-level extraction instead of line-level because multi-line hypotheses get split across lines and we need to join them first for accurate matching.';
    assert.equal(isApproachNote(text), true);
  });
});

describe('isMetaGoal: SNR target detection', () => {
  it('should detect "bring up our snr to at least 95%" as meta', () => {
    assert.equal(isMetaGoal('Investigate and bring up our snr to at least 95%'), true);
  });

  it('should detect "get snr above 99%" as meta', () => {
    assert.equal(isMetaGoal('Get snr above 99% after the next compaction cycle'), true);
  });

  it('should detect "raise snr to 100" as meta', () => {
    assert.equal(isMetaGoal('Raise SNR to 100 by fixing the hypothesis extraction'), true);
  });

  it('should not flag non-SNR goals as meta', () => {
    assert.equal(isMetaGoal('Implement the new authentication module with OAuth2 support'), false);
  });

  it('should still detect SNR analysis as meta', () => {
    assert.equal(isMetaGoal('Do a SNR analysis and give me the percentage'), true);
  });

  it('should detect "just complete the task" as meta', () => {
    assert.equal(isMetaGoal('Just complete the task so ple fix all issue'), true);
  });

  it('should detect "fix all issues" as meta', () => {
    assert.equal(isMetaGoal('Please fix all the issues and wrap things up'), true);
  });

  it('should detect "finish everything" as meta', () => {
    assert.equal(isMetaGoal('Just finish everything that is remaining'), true);
  });

  it('should detect "just do it" as meta', () => {
    assert.equal(isMetaGoal('Can you please just do it already now'), true);
  });

  it('should not flag specific fix requests as meta', () => {
    assert.equal(isMetaGoal('Fix the distillGoal function to strip filler prefixes like just'), false);
  });
});

describe('distillGoal: filler stripping', () => {
  it('should strip "just" prefix', () => {
    const result = distillGoal('just complete the task');
    assert.equal(result, 'Complete the task');
  });

  it('should strip chained "lets just"', () => {
    const result = distillGoal("let's just fix the bug in scoring");
    assert.equal(result, 'Fix the bug in scoring');
  });

  it('should strip "so please" mid-sentence', () => {
    const result = distillGoal('we need to so please fix the parser');
    assert.equal(result, 'Fix the parser');
  });

  it('should strip "so ple" (typo for please)', () => {
    const result = distillGoal('i want to so ple fix the tests');
    assert.equal(result, 'Fix the tests');
  });
});
