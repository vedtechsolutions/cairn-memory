#!/usr/bin/env node
/**
 * Golden-output harness for the Phase 1 contract extraction (brief step 2,
 * review condition R4): capture byte-exact hook outputs for fixed fixtures
 * across (event × client), against a freshly seeded throwaway DB, so the
 * pre- and post-refactor builds can be byte-diffed.
 *
 * Usage: node scripts/golden-hooks.mjs <out-dir>
 *
 * Determinism: every run seeds an IDENTICAL DB (fixed ids, contents, and
 * created_at anchored 30 days before the harness run so relative-time
 * rendering rounds stably within a capture session); CAIRN_TZ is cleared;
 * each hook spawn gets a fresh copy of the seeded DB (snapshot-restore),
 * so one hook's writes can never leak into another's output.
 */
import { mkdirSync, writeFileSync, copyFileSync, rmSync, mkdtempSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOOKS = join(REPO, 'dist', 'src', 'hooks');

const outDir = process.argv[2];
if (!outDir) {
  console.error('usage: node scripts/golden-hooks.mjs <out-dir>');
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });

const work = mkdtempSync(join(tmpdir(), 'cairn-golden-'));
const seedDb = join(work, 'seed.db');
// FIXED path (not per-run temp): the project id derives from the cwd, so a
// varying path would change the id and defeat byte-identical captures.
const cwdFixture = join(tmpdir(), 'cairn-golden-project');
mkdirSync(cwdFixture, { recursive: true });

// ---- Seed a deterministic DB via the real repository layer ----------------
const { openDatabase } = await import(join(REPO, 'dist', 'src', 'db', 'connection.js'));
const { MemoryRepository } = await import(join(REPO, 'dist', 'src', 'db', 'memory-repository.js'));
const { PlanRepository } = await import(join(REPO, 'dist', 'src', 'db', 'plan-repository.js'));

const { projectId } = await import(join(REPO, 'dist', 'src', 'utils', 'project-id.js'));
const { extractAnchor, anchorToJson } = await import(join(REPO, 'dist', 'src', 'utils', 'anchor.js'));

const db = openDatabase({ dbPath: seedDb });
const repo = new MemoryRepository(db);
const plans = new PlanRepository(db);
const past = new Date(Date.now() - 30 * 86_400_000).toISOString();
// Seed under the id the hooks will actually derive from the fixture cwd.
const PROJECT = projectId(cwdFixture);

const pitfallContent = 'Golden pitfall: editing golden-alpha.ts requires updating its checksum table first.';
// repo.create does not auto-extract anchors (the MCP layer does) — pass one
// so file-anchored pitfall recall exercises a non-empty golden.
const pitfallAnchor = extractAnchor(pitfallContent);
repo.create({ content: pitfallContent, kind: 'pitfall', project: PROJECT, confidence: 0.9, createdAt: past, skipDedup: true, anchor: pitfallAnchor ? anchorToJson(pitfallAnchor) : undefined });
repo.create({ content: 'Golden correction: always run the golden verifier before claiming done.', kind: 'correction', project: null, confidence: 0.9, createdAt: past, skipDedup: true });
repo.create({ content: 'Golden decision: chose fixture seeding over live snapshots because determinism beats realism here.', kind: 'decision', project: PROJECT, confidence: 0.9, createdAt: past, skipDedup: true });
plans.create({ project: PROJECT, name: 'Golden fixture plan', steps: [{ description: 'first golden step' }, { description: 'second golden step' }] });
db.close();

// ---- Fixtures: (event, entry script, payload, clients) --------------------
const base = { session_id: 'golden-session', transcript_path: '/nonexistent/transcript.jsonl', cwd: cwdFixture };
const CASES = [
  { name: 'session-start', entry: 'session-start.js', payload: { ...base, hook_event_name: 'SessionStart', source: 'startup' } },
  { name: 'prompt-check', entry: 'prompt-check.js', payload: { ...base, hook_event_name: 'UserPromptSubmit', prompt: 'continue working on the golden fixture module please' } },
  { name: 'pitfall-check', entry: 'pitfall-check.js', payload: { ...base, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: join(cwdFixture, 'golden-alpha.ts'), old_string: 'a', new_string: 'b' }, tool_use_id: 'golden-t1' } },
  { name: 'pitfall-check-patch', entry: 'pitfall-check.js', payload: { ...base, hook_event_name: 'PreToolUse', tool_name: 'apply_patch', tool_input: { command: `*** Begin Patch\n*** Update File: ${join(cwdFixture, 'golden-alpha.ts')}\n+x\n*** End Patch` }, tool_use_id: 'golden-t2' } },
  { name: 'subagent-context', entry: 'subagent-context.js', payload: { ...base, hook_event_name: 'SubagentStart', agent_id: 'golden-agent', agent_type: 'general-purpose' } },
];
const CLIENTS = [null, 'codex'];

// projectId derives from cwd (no git remote in the fixture dir) — stable
// across builds as long as the algorithm is unchanged, which is itself part
// of what the golden run guards.
let captured = 0;
for (const c of CASES) {
  for (const client of CLIENTS) {
    const dbCopy = join(work, `run-${captured}.db`);
    copyFileSync(seedDb, dbCopy);
    const env = {
      ...process.env,
      CAIRN_DB_PATH: dbCopy,
      CAIRN_DIR: join(work, `state-${captured}`),
      CAIRN_STATE_PATH: join(work, `state-${captured}.json`),
      CAIRN_QUERY_CWD: '/x',
      CAIRN_CLIENT: client ?? '',
      // Scope config must never shape golden captures (absent = default).
      CAIRN_CONFIG_PATH: join(work, 'no-config.json'),
    };
    delete env.CAIRN_TZ;
    const proc = spawnSync(process.execPath, [join(HOOKS, c.entry)], {
      input: JSON.stringify(c.payload),
      encoding: 'utf8',
      env,
      timeout: 60_000,
    });
    const label = `${c.name}.${client ?? 'claude'}`;
    writeFileSync(join(outDir, `${label}.out`), proc.stdout ?? '');
    writeFileSync(join(outDir, `${label}.code`), String(proc.status));
    captured++;
  }
}

rmSync(work, { recursive: true, force: true });
console.log(`golden-hooks: captured ${captured} outputs to ${outDir}`);
