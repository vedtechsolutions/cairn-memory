#!/usr/bin/env node
/**
 * Ad-hoc probe: compile a startup briefing against the live store (resolveStateRoot: ~/.waykeep, legacy ~/.cairn until migration)
 * and emit the exact text the compiler would produce right now, so SNR can
 * be measured against the latest committed state instead of a canned ctx.
 *
 * Sources:
 *   - Latest compaction_snapshot row (for the current project) → recent
 *     files, commands, decisions, error context, project goal, cursor.
 *   - `git` commands via execFileSync (no shell) → branch, uncommitted
 *     count, recent commits.
 *   - package.json → project name.
 *
 * CLI:
 *   node scripts/snr-probe.mjs            # live sniff, compact session type
 *   node scripts/snr-probe.mjs --startup  # emit the startup briefing instead
 *   node scripts/snr-probe.mjs --cold     # emit a truly-cold startup briefing
 *                                         # (no snapshot, no projectGoal, no
 *                                         # lastEditCursor) — simulates a
 *                                         # first-ever session or a clean
 *                                         # restart where the DB has no
 *                                         # carried state for this project.
 *   node scripts/snr-probe.mjs --project <id>  # override project id
 */
import { openDatabase } from '../dist/src/db/connection.js';
import { MemoryRepository } from '../dist/src/db/memory-repository.js';
import { PlanRepository } from '../dist/src/db/plan-repository.js';
import { compileBriefing, buildBriefingQueryFp } from '../dist/src/hooks/shared/briefing-compiler.js';
import { projectId } from '../dist/src/utils/project-id.js';
import { resolveStateRoot } from '../dist/src/constants/paths.js';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';

const args = process.argv.slice(2);
const isCold = args.includes('--cold');
const isStartup = args.includes('--startup') || isCold;
const projectArgIdx = args.indexOf('--project');
const projectOverride = projectArgIdx >= 0 ? args[projectArgIdx + 1] : null;

const cwd = process.cwd();
// THE coherent state root (Phase B): a hardcoded legacy ~/.cairn/cairn.db would let
// openDatabase (which CREATES the file + schema) mint an EMPTY legacy store on
// a fresh/migrated install, and resolveStateRoot would then pick that empty
// legacy DB over the populated current one — presenting total memory loss
// (codex B1 review). Resolve the same marker-aware root every process uses,
// and refuse to run rather than create a shadow store.
const dbArgIdx = args.indexOf('--db');
const dbOverride = dbArgIdx >= 0 ? args[dbArgIdx + 1] : null;
const root = resolveStateRoot();
const dbPath = dbOverride ?? join(root.dir, root.dbFilename);
if (!existsSync(dbPath)) {
  console.error(`snr-probe: no store at ${dbPath} — refusing to create one. Point --db at an existing store.`);
  process.exit(1);
}
const db = openDatabase({ dbPath });
const memRepo = new MemoryRepository(db);
const planRepo = new PlanRepository(db);

const project = projectOverride ?? projectId(cwd);

// Shell-free git runner — all args are literals, no user input threaded in.
function git(...gitArgs) {
  try {
    return execFileSync('git', gitArgs, { cwd, encoding: 'utf-8' }).trim();
  } catch {
    return '';
  }
}

const branch = git('rev-parse', '--abbrev-ref', 'HEAD') || 'unknown';
const recentCommits = git('log', '-8', '--pretty=%s').split('\n').filter(Boolean);
const uncommittedCount = git('status', '--porcelain').split('\n').filter(Boolean).length;
const unpushedCount = Number(git('rev-list', '--count', `origin/${branch}..HEAD`) || '0');

let projectName = 'unknown';
try {
  const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf-8'));
  projectName = pkg.name ?? 'unknown';
} catch { /* no package.json */ }

// Pull the latest compaction_snapshot for this project.
const snapRow = db.prepare(`
  SELECT * FROM compaction_snapshots
  WHERE project = ?
  ORDER BY captured_at DESC
  LIMIT 1
`).get(project);

function parseJsonOrDefault(text, fallback) {
  if (!text) return fallback;
  try { return JSON.parse(text); } catch { return fallback; }
}

const compactionSnapshot = snapRow ? {
  recentFiles: parseJsonOrDefault(snapRow.recent_files, []),
  recentReadFiles: parseJsonOrDefault(snapRow.recent_read_files, []),
  recentCommands: parseJsonOrDefault(snapRow.recent_commands, []),
  userContext: parseJsonOrDefault(snapRow.user_context, []),
  approachNotes: parseJsonOrDefault(snapRow.approach_notes, []),
  initialGoal: snapRow.initial_goal ?? null,
  // SNR v3 Commit 4: captured_at metadata drives the Now-tier age label.
  // Fall back to the snap's own captured_at for pre-v23 rows.
  goalCapturedAt: snapRow.goal_captured_at ?? snapRow.captured_at ?? null,
  snapshotSessionId: snapRow.session_id ?? null,
  goalBranch: snapRow.goal_branch ?? null,
  goalCarryCount: snapRow.goal_carry_count ?? 0,
  recentDecisions: parseJsonOrDefault(snapRow.recent_decisions, []),
  reasoningState: parseJsonOrDefault(snapRow.reasoning_state, { hypotheses: [], openQuestions: [] }),
  errorContext: parseJsonOrDefault(snapRow.error_context, []),
} : undefined;

// SNR v3 Commit 4: branch-source goals flow into featureGoal, other sources
// into projectGoal. Mirrors the split query in session-start-handler so the
// probe exercises the same code path the live hook would take.
const rawPgSource = snapRow?.project_goal_source ?? 'plan';
const rawPgCapturedAt = snapRow?.project_goal_captured_at ?? snapRow?.captured_at ?? null;
const projectGoalRow = (snapRow?.project_goal && rawPgSource !== 'branch') ? {
  text: snapRow.project_goal,
  source: rawPgSource,
  capturedAt: rawPgCapturedAt,
} : null;
const featureGoalRow = (snapRow?.project_goal && rawPgSource === 'branch') ? {
  text: snapRow.project_goal,
  capturedAt: rawPgCapturedAt,
  branch: snapRow?.goal_branch ?? null,
} : null;

const lastEditCursor = snapRow?.last_edit_cursor
  ? parseJsonOrDefault(snapRow.last_edit_cursor, null)
  : null;

const ctx = {
  project,
  sessionType: isStartup ? 'startup' : 'compact',
  interrupted: false,
  // SNR v3 Commit 4: surface the current session id so the Now-tier
  // session-boundary gate can compare against the snapshot's session.
  currentSessionId: snapRow?.session_id ?? 'probe-session',
  // --cold strips all carried state (snapshot, goal, cursor). Simulates a
  // truly first-session cold boot where the only context available is the
  // project scan + live git state. This is the hardest case for SNR because
  // queryFp is at its sparsest.
  projectGoal: isCold ? null : projectGoalRow,
  featureGoal: isCold ? null : featureGoalRow,
  lastEditCursor: isCold ? null : lastEditCursor,
  projectContext: {
    gitHash: 'live',
    projectName,
    techStack: 'TypeScript, Node, better-sqlite3',
    structure: ['src/', 'tests/'],
    entryPoints: ['src/mcp/server.ts'],
    keyConfigs: ['package.json', 'tsconfig.json'],
    scannedAt: new Date().toISOString(),
  },
  gitState: {
    branch,
    uncommittedCount,
    unpushedCount,
    recentCommits,
  },
  compactionSnapshot: isCold ? undefined : compactionSnapshot,
};

const result = compileBriefing(memRepo, planRepo, ctx);
console.log('=== briefing ===');
console.log(result.text);
console.log('');
console.log('=== stats ===');
console.log(`project: ${project}`);
console.log(`snapshot captured_at: ${isCold ? '(stripped, --cold)' : snapRow?.captured_at ?? '(none)'}`);
console.log(`session type: ${ctx.sessionType}${isCold ? ' (cold)' : ''}`);
console.log(`token estimate: ${result.tokenEstimate}`);
console.log(`includedPitfallIds: ${result.includedPitfallIds.length}`);

const qFp = buildBriefingQueryFp(ctx, null);
console.log('queryFp modules:', qFp?.module ?? '(undefined)');

db.close();
