/**
 * The StatusLine state file has exactly ONE reader: hooks/shared/state-io.ts.
 * A second reader once lived in the MCP server, skipped the staleness bound
 * and the validation that rejects a forged `mode: "critical"`, and resolved
 * its path at import time so the WAYKEEP_STATE_PATH override never applied
 * (audit, 2026-09-02). This pins the single-reader property structurally.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = join(REPO, 'src');

/** Files allowed to name the client-state file: its definition and its reader. */
const ALLOWED = new Set(['src/constants/paths.ts', 'src/hooks/shared/state-io.ts']);

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...tsFiles(path));
    else if (entry.endsWith('.ts')) out.push(path);
  }
  return out;
}

describe('StatusLine state file has one reader', () => {
  it('only constants/paths.ts and hooks/shared/state-io.ts reference the client-state filename', () => {
    const hits = tsFiles(SRC)
      .filter(f => /\bCLIENT_STATE\b/.test(readFileSync(f, 'utf-8')))
      .map(f => relative(REPO, f));
    // Vacuity guard: the scan must still SEE the definition and the reader —
    // a renamed identifier would otherwise match nothing and pass green.
    for (const allowed of ALLOWED) assert.ok(hits.includes(allowed), `scan no longer finds ${allowed} — the identifier moved or was renamed; update the scan`);
    const offenders = hits.filter(rel => !ALLOWED.has(rel));
    assert.deepEqual(offenders, [],
      `these files touch the state file directly — read it through readState() in hooks/shared/state-io.ts:\n  ${offenders.join('\n  ')}`);
  });

  it('the MCP server takes its context mode from readState()', () => {
    const server = readFileSync(join(SRC, 'mcp', 'server.ts'), 'utf-8');
    assert.match(server, /readState\(\)\.mode/u, 'server.ts must derive getContextMode from the validated reader');
    assert.doesNotMatch(server, /from ['"][^'"]*context-mode(?:\.js)?['"]/u, 'the unvalidated MCP-local reader must stay deleted (no import of it)');
  });
});
