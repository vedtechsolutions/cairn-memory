// --- Task-aware briefing query fingerprint (GAP C + D) ---------------------
import type { Plan } from '../../../db/plan-repository.js';
import { buildQueryFingerprint, branchSignalTokens, type ContextFingerprint } from '../../../utils/fingerprint.js';
import { deriveProjectIdentityTokens } from '../../../utils/cross-project-guard.js';
import { isMetaGoal } from '../transcript-parser.js';
import { basename, dirname, extname } from 'node:path';
import type { BriefingContext } from './types.js';

/** Generic path segments the fingerprint path already ignores; mirror it here.
 *  The `opt|usr|var|home|root|tmp|etc` roots and `.claude|worktrees` segments
 *  are filesystem structure, not retrieval signal — they leak in via absolute
 *  paths like `/opt/cairn/src/...` and Claude Code worktree paths like
 *  `.claude/worktrees/<slug>/...`, and would otherwise pollute queryFp.module
 *  with tokens that match unrelated project memories. */
const BRIEFING_GENERIC_SEGMENTS = new Set([
  'src', 'lib', 'dist', 'build', 'out', 'bin',
  'node_modules', 'packages', 'vendor',
  'public', 'static', 'assets', 'resources',
  'tests', 'test', '__tests__', 'spec', 'specs',
  'opt', 'usr', 'var', 'home', 'root', 'tmp', 'etc',
  '.claude', 'worktrees',
  '.', '..', '',
]);

/** Stop-words dropped from goal / plan-name tokenisation. */
const GOAL_STOP_WORDS = new Set([
  'and', 'the', 'for', 'with', 'into', 'from', 'that', 'this', 'then', 'than',
  'when', 'where', 'will', 'been', 'have', 'having', 'still', 'about',
  'some', 'more', 'most', 'over', 'under', 'after', 'before', 'between',
  'make', 'made', 'also', 'only', 'very', 'such', 'your', 'their', 'them',
  'just', 'should', 'would', 'could', 'need', 'needs', 'want', 'wants',
  'test', 'tests', 'code',
]);

/** SNR v3 Commit 3: cold-start policy threshold. Narrow-overlap re-ranking
 *  (`topPitfalls(..., queryFp)`) AND the same-project relevance gate both
 *  require the query fingerprint to carry at least this many meaningful
 *  tokens after stripping project-identity and generic area labels.
 *
 *  Below the threshold the compiler uses:
 *    - `topPitfalls(..., undefined)` — pure effectiveness+recency ranking,
 *    - `passesSameProjectRelevance(m, broadFp(queryFp), ...)` — empty-module
 *      variant that triggers the broad-query short-circuit so same-project
 *      memories still surface.
 *  The cross-project guard still runs against the full synthesised fp
 *  (overlap=0 still blocks unfingerprinted globals). Replaces the cold-boot
 *  kludge (`queryFp ?? BRIEFING_BROAD_FP`) from Commit 2 with a modelable
 *  policy based on actual fp content. */
export const NARROW_OVERLAP_MIN_MEANINGFUL_TOKENS = 2;

/** Tokenise content for set-overlap comparisons — lowercase, drop punctuation,
 *  drop stop-words, require tokens ≥3 chars. Shared by GAP E + GAP F. */
export function tokeniseForOverlap(text: string): Set<string> {
  const out = new Set<string>();
  const tokens = text.toLowerCase().split(/[^a-z0-9]+/);
  for (const t of tokens) {
    if (t.length >= 3 && !GOAL_STOP_WORDS.has(t)) out.add(t);
  }
  return out;
}

/** Jaccard similarity between two token sets. Empty sets return 0 (not 1). */
export function jaccardOverlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Build a task-aware query fingerprint for the briefing path.
 *
 * SNR v3 Commit 3: always returns a `ContextFingerprint` (never undefined).
 * The previous `hasAnySignal → undefined` short-circuit was the reason the
 * guards had to be wrapped in `queryFp ? ... : raw` bypass ternaries, which
 * was the primary 50% SNR regression path. Now every briefing gets a fp so
 * the cross-project guard can always run; the cold-start policy elsewhere
 * in this file (`meaningfulTokenCount` + NARROW_OVERLAP_MIN_MEANINGFUL_TOKENS)
 * decides whether the fp is rich enough for narrow-overlap re-ranking or
 * whether to fall back to effectiveness+recency.
 *
 * Sources, in order:
 *   1. projectContext → base `buildQueryFingerprint` (lang/framework/modules).
 *   2. compactionSnapshot → path segments + filename stems from recent files.
 *   3. goal + plan name + in-progress steps → lowercased, stop-word filtered.
 *   4. git branch → split on /-_, noise-filtered.
 *   5. project-identity tokens (from `ctx.project`) → always included so a
 *      cold boot still produces a non-trivially-empty fp. Commit 1 strips
 *      these from overlap counting; `meaningfulTokenCount` ignores them too.
 *   6. cwd basename → final fallback when everything else is missing.
 *      Filtered against BRIEFING_GENERIC_SEGMENTS to avoid adding `opt`,
 *      `home`, `tmp`, etc. from absolute paths.
 */
export function buildBriefingQueryFp(ctx: BriefingContext, plan: Plan | null): ContextFingerprint {
  const snap = ctx.compactionSnapshot;

  const base = ctx.projectContext
    ? buildQueryFingerprint({ projectContext: ctx.projectContext })
    : { lang: [], framework: [], module: [] };

  const modules = new Set<string>(base.module);

  // Recent files — path segments + filename stems
  if (snap) {
    const files: string[] = [
      ...(snap.recentFiles ?? []).slice(-5),
      ...(snap.recentReadFiles ?? []).slice(-3),
    ];
    for (const fp of files) {
      addFilePathModules(fp, modules);
    }
  }

  // Goal + plan name tokens.
  //
  // SNR v3 Commit 4: initialGoal is filtered through `isMetaGoal` before
  // tokenization. Resume-session prose ("Continue this was where you were
  // before we cot disconnected: Next: Commit 2 — …") used to leak every
  // word ≥4 chars into queryFp.module as noise. Now such prose is detected
  // by the long-form resumeProsePatterns added to isMetaGoal and never
  // reaches the tokenizer. This is a defence-in-depth layer — the primary
  // filter is in evaluateCarriedGoal/renderTier1 which also applies
  // isMetaGoal to decide whether to render the goal at all.
  const goalParts: string[] = [];
  if (snap?.initialGoal && !isMetaGoal(snap.initialGoal)) goalParts.push(snap.initialGoal);
  if (plan?.name && !isMetaGoal(plan.name)) goalParts.push(plan.name);
  for (const step of plan?.steps ?? []) {
    if (step.status === 'in_progress' && !isMetaGoal(step.description)) {
      goalParts.push(step.description);
    }
  }
  if (goalParts.length > 0) {
    const goalText = goalParts.join(' ').toLowerCase();
    const tokens = goalText.split(/[^a-z0-9]+/).filter(t => t.length >= 4 && !GOAL_STOP_WORDS.has(t));
    for (const t of tokens) modules.add(t);
  }

  // Branch tokens
  const branch = ctx.gitState?.branch;
  if (branch) {
    for (const p of branchSignalTokens(branch)) modules.add(p);
  }

  // Cold-start safety net: project-identity tokens ensure the fp is never
  // `{ module: [] }` even when there's no other signal. They don't
  // contribute to overlap counting (Commit 1 strip) but they make the fp
  // content-addressable for dedup/logging and prove the helper ran.
  for (const t of deriveProjectIdentityTokens(ctx.project)) modules.add(t);

  // CWD basename — last-resort signal (see cwdSignalTokens for the A1
  // neutrality contract: these tokens may help relevance overlap but must
  // never narrow the gate policy).
  for (const t of cwdSignalTokens()) modules.add(t);

  return { lang: base.lang, framework: base.framework, module: [...modules] };
}

/**
 * Tokens contributed by the cwd-basename last-resort signal. Gated strictly
 * so absolute-path roots (/opt, /home, /tmp) don't leak; split on
 * hyphen/underscore/dot so `cairn-test-abc123` → ['cairn','test','abc123'],
 * each part re-filtered against the generic set + length gate.
 *
 * A1 neutrality contract: a signal of last resort may only ever HELP —
 * these tokens join the query fp (relevance overlap, content-addressability)
 * but are excluded from `meaningfulTokenCount` via narrowPolicyExclusions,
 * so they can never flip the cold-start policy to narrow and drop
 * same-project memories. Without that exclusion, briefing behavior varied
 * with the checkout directory's name (CI workspace/, verification worktrees).
 * CAIRN_QUERY_CWD overrides process.cwd() so tests pin a stable value.
 */
function cwdSignalTokens(): string[] {
  const cwdBase = basename(process.env.CAIRN_QUERY_CWD ?? process.cwd()).toLowerCase();
  if (cwdBase.length < 3 || cwdBase.length > 40 || BRIEFING_GENERIC_SEGMENTS.has(cwdBase)) return [];
  return cwdBase.split(/[-_.]/).filter(p => p.length >= 3 && !BRIEFING_GENERIC_SEGMENTS.has(p));
}

/** Exclusion set for the narrow-overlap policy decision: project-identity
 *  tokens (SNR v3 Commit 1) plus cwd-signal tokens (A1). */
export function narrowPolicyExclusions(project: string | null): Set<string> {
  const exclusions = new Set(deriveProjectIdentityTokens(project));
  for (const t of cwdSignalTokens()) exclusions.add(t);
  return exclusions;
}

/**
 * Produce the broad variant of a query fingerprint for the same-project
 * relevance gate when the cold-start policy has decided narrow-overlap is
 * unsafe (meaningful token count below threshold). Drops the module
 * dimension entirely so `passesSameProjectRelevance`'s broad-query
 * short-circuit (`!queryHasFile && !queryHasModule → true`) fires and
 * same-project memories aren't blocked by a thin synthesised fp. The
 * cross-project guard still uses the full synthesised fp because
 * `fingerprintOverlap` against thin modules still blocks unfingerprinted
 * globals (overlap = 0 < threshold).
 */
export function broadRelevanceFp(fp: ContextFingerprint): ContextFingerprint {
  return { lang: fp.lang, framework: fp.framework, module: [] };
}

function addFilePathModules(filePath: string, modules: Set<string>): void {
  const dir = dirname(filePath);
  const segments = dir.split(/[/\\]/).map(s => s.toLowerCase());
  for (const seg of segments) {
    if (seg.length >= 3 && !BRIEFING_GENERIC_SEGMENTS.has(seg)) modules.add(seg);
  }
  const stem = basename(filePath, extname(filePath)).toLowerCase();
  if (stem.length >= 3 && !BRIEFING_GENERIC_SEGMENTS.has(stem)) {
    const stemParts = stem.split(/[-_.]/).filter(p => p.length >= 3);
    for (const p of stemParts) modules.add(p);
  }
}
