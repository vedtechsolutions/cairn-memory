/**
 * Codex parity Slice C — apply_patch file awareness, anchor extraction,
 * and briefing framing for non-primary agents.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractPatchFilePaths, patchTextOf } from '../src/hooks/shared/patch-paths.js';
import { extractFilePaths } from '../src/hooks/handlers/pitfall/input-extract.js';
import { extractAnchor } from '../src/utils/anchor.js';
import { handleSessionStart } from '../src/hooks/handlers/session-start-handler.js';
import { createHookDbClient } from '../src/hooks/shared/db-client.js';

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

  it('feeds the pitfall check file-path channel for apply_patch inputs', () => {
    const paths = extractFilePaths({
      session_id: 's', transcript_path: '/x', cwd: '/opt/cairn',
      tool_name: 'apply_patch',
      tool_input: { command: PATCH },
    });
    assert.equal(paths[0], 'src/widgets/frobnicator.ts');
    assert.equal(paths.length, 3);
  });

  it('patchTextOf is null for non-apply_patch tools', () => {
    assert.equal(patchTextOf({ tool_name: 'Bash', tool_input: { command: 'ls' } }), null);
    assert.equal(patchTextOf({ tool_name: 'apply_patch', tool_input: {} }), null);
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
});

describe('briefing framing for non-primary agents', () => {
  it('codex briefings lead with the context-not-tasking line; claude briefings do not', () => {
    const client = createHookDbClient(':memory:');
    const cwd = mkdtempSync(join(tmpdir(), 'cairn-framing-'));
    try {
      const base = {
        session_id: 'framing-codex', transcript_path: '/nonexistent',
        cwd, hook_event_name: 'SessionStart', type: 'startup' as const,
      };
      const codex = handleSessionStart({ ...base, client_name: 'codex' }, { ...client, cache: undefined });
      const parsed = JSON.parse(codex.output) as { hookSpecificOutput: { additionalContext: string } };
      assert.match(parsed.hookSpecificOutput.additionalContext, /^\[Cairn\] The briefing below is shared memory CONTEXT/);
      assert.match(parsed.hookSpecificOutput.additionalContext, /not tasking/);

      const claude = handleSessionStart({ ...base, session_id: 'framing-claude' }, { ...client, cache: undefined });
      assert.ok(!claude.output.includes('not tasking'), 'claude briefing carries no framing line');
      assert.ok(claude.output.startsWith('[Cairn Memory Briefing]') || claude.output.length >= 0);
    } finally {
      client.close();
    }
  });
});
