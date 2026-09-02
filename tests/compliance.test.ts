import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractAssistantDecision, extractDecisionSigils } from '../src/hooks/shared/transcript-parser.js';

// --- Layer 1b: Assistant Decision Mining ---

describe('extractAssistantDecision', () => {
  it('should extract decision with choice + rationale', () => {
    const text = "I'll use a bookend read pattern because it captures the initial goal from large transcripts without reading the entire file.";
    const result = extractAssistantDecision(text);
    assert.ok(result !== null);
    assert.ok(result.includes('bookend read'));
  });

  it('should extract "going with X because Y"', () => {
    const text = "Going with SQLite over PostgreSQL because the MCP server needs zero-config deployment and the data volume is small.";
    const result = extractAssistantDecision(text);
    assert.ok(result !== null);
    assert.ok(result.includes('SQLite'));
  });

  it('should extract "the approach is" with rationale', () => {
    const text = "The approach is to use file-based state sharing between hooks because each hook process is short-lived and they need to communicate.";
    const result = extractAssistantDecision(text);
    assert.ok(result !== null);
  });

  it('should extract "chose X because Y"', () => {
    const text = "I chose the dual-signal filter because single-signal matching was too broad and caught status updates as approach notes.";
    const result = extractAssistantDecision(text);
    assert.ok(result !== null);
    assert.ok(result.includes('dual-signal'));
  });

  it('should extract "switching to X since Y"', () => {
    const text = "Switching to length-adaptive filtering since texts over 200 chars are inherently more substantive and the conversational filters already reject noise.";
    const result = extractAssistantDecision(text);
    assert.ok(result !== null);
  });

  it('should reject text without rationale signal', () => {
    const text = "I'll use the Read tool to check the current content of the file before making changes.";
    const result = extractAssistantDecision(text);
    assert.equal(result, null);
  });

  it('should reject text without choice signal', () => {
    const text = "The error happens because the tail-read optimization drops the initial goal from large transcripts that exceed 512KB.";
    const result = extractAssistantDecision(text);
    assert.equal(result, null);
  });

  it('should reject short text', () => {
    const text = "I chose X because Y.";
    const result = extractAssistantDecision(text);
    assert.equal(result, null);
  });

  it('should reject conversational starters', () => {
    const text = "Here's the implementation I chose for the bookend pattern because it minimizes memory usage while capturing the goal.";
    const result = extractAssistantDecision(text);
    assert.equal(result, null);
  });

  it('rejects a long run-on decision rather than storing a truncated prefix', () => {
    // INVERTED at remediation step 1: this test previously pinned
    // `slice(0,197)+'...'` — the mechanism that produced the 29
    // source='learned' prompt-prefix fragments in the live store. A single
    // run-on sentence over the cap is rejected: capture whole, or nothing.
    const text = "I'll use a three-layer compliance architecture because it provides defense in depth: infrastructure extraction eliminates the need for explicit calls, contextual nudges re-inject rules mid-conversation, and enforcement gates block completion without stored decisions, creating a reliable system.";
    assert.equal(extractAssistantDecision(text), null);
  });

  it('captures the decision SENTENCE from a longer message, never the prefix', () => {
    const text = "The refactor touched several modules and the tests were noisy for a while across the board. We'll use SQLite because atomic local writes matter here. The rest of the plan lands tomorrow after review.";
    // >200 chars total; the middle sentence carries choice+rationale.
    const result = extractAssistantDecision(text + ' Padding sentence follows for length beyond the cap, with more words.');
    assert.equal(result, "We'll use SQLite because atomic local writes matter here.");
  });
});

// --- Layer 1a: Decision Sigils (Design 1) ---
//
// Sigils are the explicit-authorship path: the agent writes `[dec: ...]`
// inline when making an architectural decision. Parsing is cheap and has
// zero false-positive risk on markdown-heavy output, which the legacy
// prose extractor structurally cannot handle.

describe('extractDecisionSigils', () => {
  it('extracts a single sigil embedded in prose', () => {
    const text = 'Going over the tradeoffs of the two approaches. [dec: chose lazy on-demand symbol extraction over persistent code graph because maintenance cost dominates] Moving on to the next task.';
    const result = extractDecisionSigils(text);
    assert.equal(result.length, 1);
    assert.ok(result[0].includes('lazy on-demand'));
    assert.ok(result[0].includes('because'));
  });

  it('extracts multiple sigils from the same turn', () => {
    const text = '[dec: use fingerprint over anchor for module queries because anchors miss tag-driven recall] Also [dec: raise AUTO_DETECTED to 0.55 because 0.4 buried fresh captures under decay floor]';
    const result = extractDecisionSigils(text);
    assert.equal(result.length, 2);
    assert.ok(result[0].includes('fingerprint'));
    assert.ok(result[1].includes('AUTO_DETECTED'));
  });

  it('returns empty array when no sigils present', () => {
    const text = 'Just a regular assistant message with no decision markup at all, even though it discusses choices and rationale.';
    const result = extractDecisionSigils(text);
    assert.deepEqual(result, []);
  });

  it('ignores sigils inside fenced code blocks', () => {
    const text = 'Here is the convention:\n```\n[dec: example sigil for docs]\n```\nAnd an actual decision: [dec: real decision because it fixes the bug]';
    const result = extractDecisionSigils(text);
    assert.equal(result.length, 1);
    assert.ok(result[0].includes('real decision'));
    assert.ok(!result.some(r => r.includes('example sigil')));
  });

  it('ignores sigils inside inline backticks', () => {
    const text = 'The syntax is `[dec: example]` — but [dec: pick bun over node because 10x faster] is the real one.';
    const result = extractDecisionSigils(text);
    assert.equal(result.length, 1);
    assert.ok(result[0].includes('bun'));
  });

  it('REJECTS sigil content longer than 200 chars — never truncates (step-4 fold)', () => {
    // Inverted: truncation stored the exact slice+'...' signature the
    // 88-row remediation cleaned — reject over-cap sigils outright, and
    // keep capturing valid sigils in the same turn.
    const longContent = 'chose X over Y because ' + 'reason '.repeat(40);
    const text = `[dec: ${longContent}] then [dec: chose brevity over sprawl because sigils are one-sentence distillations]`;
    const result = extractDecisionSigils(text);
    assert.equal(result.length, 1, 'only the in-cap sigil survives');
    assert.ok(result[0].includes('brevity'));
    assert.ok(!result.some(r => r.endsWith('...')), 'no truncation artifacts, ever');
  });

  it('is case-insensitive on the sigil marker', () => {
    const text = '[DEC: uppercase marker still captured because robustness] and [Dec: mixed case too because case-insensitive]';
    const result = extractDecisionSigils(text);
    assert.equal(result.length, 2);
  });

  it('deduplicates identical sigils within a turn', () => {
    const text = '[dec: the same decision twice in one turn because duplicate] and later [dec: the same decision twice in one turn because duplicate]';
    const result = extractDecisionSigils(text);
    assert.equal(result.length, 1);
  });

  it('ignores empty sigils', () => {
    const text = 'Empty sigil [dec: ] should not match, but [dec: non-empty because yes] should.';
    const result = extractDecisionSigils(text);
    assert.equal(result.length, 1);
    assert.ok(result[0].includes('non-empty'));
  });

  it('handles short input without crashing', () => {
    assert.deepEqual(extractDecisionSigils(''), []);
    assert.deepEqual(extractDecisionSigils('x'), []);
    assert.deepEqual(extractDecisionSigils('[dec:'), []);
  });

  it('caps sigils per turn at SIGIL_MAX_PER_TURN', () => {
    const sigils = Array.from({ length: 15 }, (_, i) => `[dec: decision ${i} because reason ${i}]`).join(' ');
    const result = extractDecisionSigils(sigils);
    assert.ok(result.length <= 8);
  });
});

// --- Layer 2a: Compliance Nudge ---

describe('Compliance Nudge', () => {
  // The detection pattern derives from the MCP constants in production
  // (helpers.ts TOOL_CALL_PATTERN) — these fixtures derive the SAME way so
  // the compliance nudge tests survive a namespace flip.
  const CALL_PATTERN = new RegExp(`mcp__${MCP_SERVER_NAME}__|"(?:${TOOL.RECALL}|${TOOL.PLAN}|${TOOL.LEARN}|${TOOL.EXPORT}|${TOOL.REMIND})"`);

  it('should detect Waykeep MCP tool calls in transcript text', () => {
    const withTool = `${qualifiedToolName(TOOL.RECALL)} some query here`;
    assert.ok(CALL_PATTERN.test(withTool));
  });

  it('should detect unprefixed tool calls', () => {
    const withTool = `{"name": "${TOOL.RECALL}", "input": {}}`;
    assert.ok(CALL_PATTERN.test(withTool));
  });

  it('should NOT match non-memory tool calls', () => {
    const withoutCairn = '{"name": "Read", "input": {"file_path": "/opt/cairn/foo.ts"}}';
    assert.ok(!CALL_PATTERN.test(withoutCairn));
  });
});

// --- Layer 2b: Decision Reminder ---

describe('Decision Reminder Logic', () => {
  it('should detect Edit+Bash(success) pattern in toolChain', () => {
    const chain = [
      { tool: 'Edit', file: '/opt/cairn/foo.ts', timestamp: 1, success: true },
      { tool: 'Bash', timestamp: 2, success: true, output: 'exit code: 0' },
      { tool: 'Edit', file: '/opt/cairn/bar.ts', timestamp: 3, success: true },
    ];
    const recentChain = chain.slice(-6);
    const hasEdits = recentChain.some(t => t.tool === 'Edit' || t.tool === 'Write');
    const hasBashSuccess = recentChain.some(t => t.tool === 'Bash' && t.success);
    assert.ok(hasEdits && hasBashSuccess);
  });

  it('should NOT trigger on chain without successful Bash', () => {
    const chain = [
      { tool: 'Edit', file: '/opt/cairn/foo.ts', timestamp: 1, success: true },
      { tool: 'Read', file: '/opt/cairn/bar.ts', timestamp: 2, success: true },
    ];
    const hasEdits = chain.some(t => t.tool === 'Edit' || t.tool === 'Write');
    const hasBashSuccess = chain.some(t => t.tool === 'Bash' && t.success);
    assert.ok(!(hasEdits && hasBashSuccess));
  });

  it('should NOT trigger on chain without edits', () => {
    const chain = [
      { tool: 'Bash', timestamp: 1, success: true, output: 'ok' },
      { tool: 'Read', file: '/opt/cairn/foo.ts', timestamp: 2, success: true },
    ];
    const hasEdits = chain.some(t => t.tool === 'Edit' || t.tool === 'Write');
    const hasBashSuccess = chain.some(t => t.tool === 'Bash' && t.success);
    assert.ok(!(hasEdits && hasBashSuccess));
  });
});

// --- EditTracker new fields ---

import { loadTracker } from '../src/hooks/shared/edit-tracker.js';
import { TOOL, MCP_SERVER_NAME, qualifiedToolName } from '../src/constants/mcp.js';

describe('EditTracker compliance fields', () => {
  it('should have complianceNudgeFired field defaulting to false', () => {
    const tracker = loadTracker();
    assert.equal(typeof tracker.complianceNudgeFired, 'boolean');
  });

  it('should have decisionReminderFired field defaulting to false', () => {
    const tracker = loadTracker();
    assert.equal(typeof tracker.decisionReminderFired, 'boolean');
  });
});
