/**
 * Codex parity Slice C — apply_patch file awareness, anchor extraction,
 * and briefing framing for non-primary agents.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractPatchFilePaths, patchTextOf } from '../src/hooks/shared/patch-paths.js';
import { extractFilePaths, extractCodeContent } from '../src/hooks/handlers/pitfall/input-extract.js';
import { extractAnchor } from '../src/utils/anchor.js';
import { handleSessionStart } from '../src/hooks/handlers/session-start-handler.js';
import { handleSuccessTracker } from '../src/hooks/handlers/success-tracker-handler.js';
import { createHookDbClient } from '../src/hooks/shared/db-client.js';
import { loadTracker, saveTracker } from '../src/hooks/shared/edit-tracker.js';
import { CROSS_AGENT_CONTEXT_FRAMING } from '../src/constants/index.js';

const PATCH = `*** Begin Patch
*** Update File: src/widgets/frobnicator.ts
@@ context
-old line
+new line referencing *** Update File: decoy/not-a-header.ts inside a body
*** Add File: docs/frobnicator.md
+content
*** Delete File: src/widgets/legacy-frob.ts
*** End Patch`;

describe('apply_patch envelope parsing (D8)', () => {
  it('extracts Add/Update/Delete header paths, ignoring body content', () => {
    const paths = extractPatchFilePaths(PATCH);
    assert.deepEqual(paths, [
      'src/widgets/frobnicator.ts',
      'docs/frobnicator.md',
      'src/widgets/legacy-frob.ts',
    ]);
  });

  it('feeds the pitfall check file-path channel, resolving relatives against cwd', () => {
    const paths = extractFilePaths({
      session_id: 's', transcript_path: '/x', cwd: '/opt/cairn',
      tool_name: 'apply_patch',
      tool_input: { command: PATCH },
    });
    // Relative header paths are normalized to absolute (Claude's convention)
    // so surfacedPitfalls/editCountsByFile keys can't split across forms.
    assert.equal(paths[0], '/opt/cairn/src/widgets/frobnicator.ts');
    assert.equal(paths.length, 3);
  });

  it('patchTextOf is null for non-apply_patch tools', () => {
    assert.equal(patchTextOf({ tool_name: 'Bash', tool_input: { command: 'ls' } }), null);
    assert.equal(patchTextOf({ tool_name: 'apply_patch', tool_input: {} }), null);
  });

  it('parses Move-to rename destinations and resolves relative paths against cwd', () => {
    const paths = extractPatchFilePaths(
      '*** Begin Patch\n*** Update File: src/old-name.ts\n*** Move to: src/new-name.ts\n*** End Patch',
      '/opt/cairn',
    );
    assert.deepEqual(paths, ['/opt/cairn/src/old-name.ts', '/opt/cairn/src/new-name.ts']);
  });

  it('extractCodeContent returns the patch ADDED lines, not envelope boilerplate', () => {
    const content = extractCodeContent({
      session_id: 's', transcript_path: '/x', cwd: '/opt/cairn',
      tool_name: 'apply_patch',
      tool_input: { command: '*** Begin Patch\n*** Update File: a.ts\n-const old = 1;\n+const fresh = readConfigValue();\n context line\n*** End Patch' },
    });
    assert.ok(content);
    assert.match(content, /readConfigValue/);
    assert.ok(!content.includes('Begin Patch'));
    assert.ok(!content.includes('const old'));
  });
});

describe('anchor extraction — sentence-final filenames', () => {
  it('anchors a filename that ends a sentence (the distilled-lesson shape)', () => {
    // Regression: the codex pitfall "… in valcheck-one.ts. Fix: …" stored
    // with files:[] because '.' was not a path terminator — file-anchored
    // recall could never find it.
    const anchor = extractAnchor(
      'Bash: TS2801 — quartz-lantern build failure in valcheck-one.ts. Fix: check types match expected signatures.',
    );
    assert.ok(anchor);
    assert.ok(anchor.files.includes('valcheck-one.ts'), `files=${JSON.stringify(anchor.files)}`);
  });

  it('does NOT anchor member-access dots or version strings (the bare-dot false positives)', () => {
    // `process.env.CAIRN_DIR` backtracks to `process` + `.env` when the
    // env-var name overflows \w{1,6}; a bare '.' terminator accepted it and
    // anchored `process.env` as a file. The lookahead fix rejects it.
    const envAnchor = extractAnchor('Read process.env.CAIRN_DIR before opening the database');
    assert.ok(!envAnchor?.files.includes('process.env'), `files=${JSON.stringify(envAnchor?.files)}`);

    const versionAnchor = extractAnchor('Upgraded to v1.2.3 with no schema change');
    assert.ok(!(versionAnchor?.files ?? []).some((f) => f.startsWith('v1.2')));
  });
});

describe('briefing framing for non-primary agents', () => {
  it('codex briefing = framing + newline + the EXACT claude briefing; claude unchanged', () => {
    const client = createHookDbClient(':memory:');
    const cwd = mkdtempSync(join(tmpdir(), 'cairn-framing-'));
    try {
      const base = {
        session_id: 'framing-codex', transcript_path: '/nonexistent',
        cwd, hook_event_name: 'SessionStart', type: 'startup' as const,
      };
      const codex = handleSessionStart({ ...base, client_name: 'codex' }, { ...client, cache: undefined });
      const parsed = JSON.parse(codex.output) as { hookSpecificOutput: { additionalContext: string } };
      const codexContext = parsed.hookSpecificOutput.additionalContext;

      const claude = handleSessionStart({ ...base, session_id: 'framing-claude' }, { ...client, cache: undefined });
      assert.ok(claude.output.length > 0, 'claude briefing is non-empty');
      assert.ok(!claude.output.includes('not tasking'), 'claude briefing carries no framing line');

      // The strongest form of "claude is unchanged": the codex context is
      // exactly the framing line plus the claude briefing.
      assert.equal(codexContext, `${CROSS_AGENT_CONTEXT_FRAMING}\n${claude.output}`);
    } finally {
      client.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe('success-tracker treats apply_patch as an edit tool', () => {
  it('boosts a surfaced pitfall and counts the edit when a patch touches its file', async () => {
    const client = createHookDbClient(':memory:');
    try {
      const target = '/opt/cairn/src/widgets/frobnicator.ts';
      const { id } = client.memoryRepo.storePitfall({
        content: 'Frobnicator widget misalignment recurs after careless patches — verify offsets.',
        project: 'slice-c-test',
        confidence: 0.5,
      });
      const sessionId = 'slice-c-patch-boost';
      const tracker = loadTracker(sessionId);
      tracker.surfacedPitfalls[target] = [id];
      tracker.recentlySurfaced = { ...(tracker.recentlySurfaced ?? {}), [id]: Date.now() };
      saveTracker(tracker, sessionId);

      const result = await handleSuccessTracker({
        session_id: sessionId, transcript_path: '/x', cwd: '/opt/cairn',
        hook_event_name: 'PostToolUse', client_name: 'codex',
        tool_name: 'apply_patch',
        tool_input: { command: `*** Begin Patch\n*** Update File: ${target}\n+fixed\n*** End Patch` },
        tool_response: 'Exit code: 0\nSuccess.',
      }, { ...client, cache: undefined });

      assert.equal(result.tracked, true);
      const mem = client.memoryRepo.findById(id);
      assert.ok(mem && mem.confidence > 0.5, `confidence boosted (${mem?.confidence})`);
      const after = loadTracker(sessionId);
      assert.equal(after.editCountsByFile[target], 1);
      assert.equal(after.surfacedPitfalls[target], undefined, 'surfaced entry consumed');
      assert.ok(after.lastEditCursor == null, 'no resume cursor for apply_patch');
    } finally {
      client.close();
    }
  });
});
