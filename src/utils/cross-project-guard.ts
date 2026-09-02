/**
 * Cross-project memory surfacing guard.
 *
 * Same-project memories pass unconditionally. Global memories must have
 * (a) a non-null fingerprint AND (b) pure fingerprintOverlap >=
 * PROACTIVE.CROSS_PROJECT_MIN_OVERLAP with the current query fingerprint.
 *
 * This prevents globals authored without a fingerprint (e.g. Odoo 19 pitfalls
 * with anchor symbols but no fingerprint) from leaking into unrelated projects
 * via either the runtime injection path (pitfall-handler) or the briefing path
 * (briefing-compiler → topPitfalls/topDecisionsRanked/activeCorrections).
 */
import type { Memory } from '../db/memory-repository.js';
import { fingerprintOverlap, type ContextFingerprint } from './fingerprint.js';
import { isPrivateProject } from '../config/cairn-config.js';
import { PROACTIVE } from '../constants/index.js';
import { basename } from 'node:path';

/**
 * Generic area labels that carry project structure but no task signal. A
 * memory tagged with only these (plus project-identity) is "broad masquerading
 * as narrow" — `['cairn', 'hooks']` looks like a 2-module narrow memory but
 * says nothing about what part of the hooks layer it applies to.
 *
 * These tokens still participate in overlap (so `hooks` ∩ `hooks` still
 * counts) but they cannot alone carry a memory across the narrow-pass
 * threshold. At least one "specific" token (one NOT in this set) must
 * exist in both the memory's module set and the overlap.
 *
 * Conservative list — keep it short. Adding a legitimate domain token here
 * (e.g. `db`) would break existing tests where `['db', 'repository']` is
 * correctly treated as narrow.
 */
export const GENERIC_MODULE_TOKENS: ReadonlySet<string> = new Set([
  'hooks', 'utils', 'shared', 'lib', 'libs', 'tests', 'test',
  'src', 'types', 'core', 'common', 'helpers', 'dist', 'build', 'scripts',
]);

/**
 * Derive project-identity tokens from a project slug. The Waykeep slug format
 * is `<name>-<stable-hash>` (e.g. `cairn-2f161aa3`); the name segment is
 * invariant across every memory stored under the project and carries no
 * task signal. Used to strip project name from overlap counting so that
 * a memory tagged `['cairn', 'hooks']` doesn't trivially pass narrow-overlap
 * via the project name.
 */
export function deriveProjectIdentityTokens(project: string | null): Set<string> {
  if (!project) return new Set();
  const name = project.split('-')[0]?.toLowerCase();
  if (!name || name.length < 3) return new Set();
  return new Set([name]);
}

/**
 * Count the "meaningful" tokens in a query fingerprint's module dimension —
 * tokens that carry task signal after stripping project-identity and
 * generic area labels. Used by the briefing compiler's cold-start policy
 * (SNR v3 Commit 3) to decide whether a synthesised queryFp is rich enough
 * to drive narrow-overlap re-ranking (`topPitfalls(..., queryFp)`), or
 * whether the compiler should fall back to pure effectiveness+recency
 * ranking while still running the cross-project guard against the thin fp.
 *
 * A cold briefing with only `ctx.project = 'cairn-2f161aa3'` yields
 * `{ module: ['cairn'] }`; after identity-strip there are 0 meaningful
 * tokens — passing that to `topPitfalls` would collapse the re-ranking
 * to noise. A briefing with `ctx.project + branch=feat/primary-memory-integration`
 * yields `{ module: ['cairn', 'primary', 'memory', 'integration'] }` with
 * 3 meaningful tokens — narrow-overlap is safe.
 */
export function meaningfulTokenCount(
  fp: ContextFingerprint,
  projectIdentity: ReadonlySet<string>,
): number {
  let count = 0;
  for (const m of fp.module) {
    if (projectIdentity.has(m)) continue;
    if (GENERIC_MODULE_TOKENS.has(m)) continue;
    count++;
  }
  return count;
}

/**
 * Module intersection sufficiency test. A single common token is enough
 * evidence ONLY when the memory is narrow (1–2 modules) AND contains at
 * least one task-specific (non-generic-area) token after stripping project
 * identity. Broader memories and all-generic memories need ≥ 2 hits with
 * at least one specific hit before they're considered relevant.
 *
 * Closes two SNR leaks:
 *  1. "PostToolUse hooks must be registered" — `module: [hooks,settings,
 *     wiring]` was passing any task whose query fingerprint had `hooks`
 *     (3-module → broad → fixed earlier by the 2-hit rule).
 *  2. Project-identity overlap — `module: [cairn,hooks]` passed narrow
 *     because length ≤ 2 and the single `hooks` hit matched. After
 *     stripping `cairn` (identity) the remaining `[hooks]` is all-generic
 *     and fails the specific-token requirement.
 */
function hasSufficientModuleOverlap(
  memMods: string[],
  queryMods: string[],
  projectIdentity: ReadonlySet<string>,
): boolean {
  if (memMods.length === 0 || queryMods.length === 0) return false;
  // Strip project-identity tokens from both sides — they're invariant across
  // the whole project and carry zero task signal.
  const memSet = new Set(memMods.filter(m => !projectIdentity.has(m)));
  const querySet = new Set(queryMods.filter(m => !projectIdentity.has(m)));
  if (memSet.size === 0 || querySet.size === 0) return false;

  let hits = 0;
  let specificHits = 0;
  for (const m of querySet) {
    if (memSet.has(m)) {
      hits++;
      if (!GENERIC_MODULE_TOKENS.has(m)) specificHits++;
    }
  }
  if (hits === 0) return false;

  // A memory qualifies as "narrow" (single-hit pass) only if it has ≤ 2
  // modules post-identity-strip AND contains ≥ 1 specific token. All-generic
  // or project-identity-only memories don't qualify no matter how short
  // their module list is.
  const memSpecificCount = [...memSet].filter(m => !GENERIC_MODULE_TOKENS.has(m)).length;
  const isNarrow = memSet.size <= 2 && memSpecificCount >= 1;
  if (isNarrow) return true;

  // Broad memory (3+ modules, or all-generic): needs ≥ 2 overlap hits AND
  // at least one of those hits must be on a specific (non-generic) token.
  return hits >= 2 && specificHits >= 1;
}

export function passesCrossProjectGuard(
  memory: Pick<Memory, 'project' | 'fingerprint'>,
  currentProject: string | null,
  queryFp: ContextFingerprint,
): boolean {
  if (memory.project === currentProject) return true;
  // Scope policy (config.json): a PRIVATE project's memories never cross
  // out, whatever their fingerprint says. Policy lives here in the guard
  // MODULE because every passive surface funnels through these functions.
  if (isPrivateProject(memory.project)) return false;
  if (!memory.fingerprint) return false;
  const overlap = fingerprintOverlap(memory.fingerprint, queryFp);
  return overlap >= PROACTIVE.CROSS_PROJECT_MIN_OVERLAP;
}

/**
 * Scoping filter for EXPLICIT-project `cairn_recall` calls (bare recall
 * defaults to the session's project but deliberately skips this guard so
 * every global stays reachable, as before scope symmetry) — deliberately MORE
 * permissive than `passesCrossProjectGuard` (which is tuned for conservative
 * passive injection). The agent explicitly queried, so a general global lesson
 * SHOULD surface. The only global we block is one that carries ANOTHER
 * project's fingerprint (e.g. a project memory promoted to global) and does not
 * overlap the current query:
 *
 *   - same-project memory           → always surfaces
 *   - fingerprinted global          → surfaces only if the fingerprint overlaps
 *                                     the query (catches a promoted mis-scope)
 *   - fingerprint-less global       → a general lesson / user preference the
 *                                     agent asked for → surfaces
 *
 * NOTE: a code anchor is NOT a project-specificity signal — it is auto-extracted
 * from almost any content — so it is deliberately not consulted here. The real
 * defense against a fingerprint-less mis-scoped global is at write time: see
 * cairn_learn's default scoping (omitted project → the current project, not
 * global).
 *
 * Applied ONLY to project-scoped recalls (the caller skips it when no project is
 * given — a bare recall legitimately returns globals). So the fingerprint-overlap
 * catch fires only when there is a current project to compare against.
 */
export function surfacesInScopedRecall(
  memory: Pick<Memory, 'project' | 'fingerprint'>,
  currentProject: string | null,
  queryFp: ContextFingerprint,
): boolean {
  if (memory.project === currentProject) return true;
  // Scope policy: private-project memories stay private even against an
  // EXPLICIT recall from another project — an agent asking is not the
  // owner consenting (the deliberate asymmetry vs. this function's
  // otherwise-permissive stance).
  if (isPrivateProject(memory.project)) return false;
  if (memory.fingerprint) return fingerprintOverlap(memory.fingerprint, queryFp) >= PROACTIVE.CROSS_PROJECT_MIN_OVERLAP;
  return true;
}

/**
 * Same-project relevance gate for file-specific fingerprint injections.
 *
 * Even within one project, a memory authored against `src/db/connection.ts`
 * should not surface while editing `tests/plan.test.ts` just because both
 * files share the `typescript` lang dimension. This gate requires at least
 * one concrete relevance signal when the current operation has a file:
 *
 *   1. Anchor match — the current filePath basename appears in memory.anchor, or
 *   2. Module overlap — memory.fingerprint.module ∩ queryFp.module is non-empty
 *
 * Broad memories (no module fingerprint, no anchor) are symmetric: they
 * surface only for broad queries (no filePath OR query has no module dim),
 * never for file-specific edits. Memories with neither anchor nor module
 * signal are treated as broad.
 *
 * This gate assumes `passesCrossProjectGuard` has already admitted the
 * memory — callers should chain both filters.
 */
export function passesSameProjectRelevance(
  memory: Pick<Memory, 'fingerprint' | 'anchor'>,
  queryFp: ContextFingerprint,
  filePath: string | null | undefined,
  projectIdentityTokens: ReadonlySet<string> = new Set(),
): boolean {
  // Bash tool calls have no file path and pass undefined — null and
  // undefined both mean "no file", so this must be a loose null check.
  const queryHasFile = filePath != null && filePath.length > 0;
  const queryHasModule = queryFp.module.length > 0;
  const memHasModule = !!memory.fingerprint && memory.fingerprint.module.length > 0;
  const memHasAnchor = !!memory.anchor && memory.anchor.length > 0;

  // Broad query (no file AND no module context): anything relevant by other signals passes
  if (!queryHasFile && !queryHasModule) return true;

  // File-specific query path
  if (queryHasFile) {
    // 1. Anchor match on basename or full path
    if (memHasAnchor && filePath) {
      const base = basename(filePath);
      if (memory.anchor!.includes(base) || memory.anchor!.includes(filePath)) return true;
    }
    // 2. Module intersection — require sufficient evidence (see helper)
    if (memHasModule && queryHasModule && hasSufficientModuleOverlap(memory.fingerprint!.module, queryFp.module, projectIdentityTokens)) {
      return true;
    }
    // Broad memory (neither anchor nor module) on file-specific query → blocked
    // Memory with module/anchor that didn't match → blocked
    return false;
  }

  // Query has module but no file (e.g. tag-driven recall): require concrete
  // relevance signal. Broad memories (empty/null fingerprint.module, no
  // anchor) would otherwise ride through on any task-specific briefing even
  // when the memory has nothing to do with the current work. True broad↔broad
  // symmetry is already handled above when the query itself has no module.
  if (memHasModule) {
    if (hasSufficientModuleOverlap(memory.fingerprint!.module, queryFp.module, projectIdentityTokens)) return true;
    return false;
  }
  // Anchor-only memory: match anchor against query modules. The briefing
  // synthesizes module tokens from recent-file path segments + stems, so an
  // anchor pointing at a file the current task touches naturally aligns.
  if (memHasAnchor && memory.anchor) {
    const anchorLower = memory.anchor.toLowerCase();
    for (const m of queryFp.module) {
      if (anchorLower.includes(m.toLowerCase())) return true;
    }
  }
  return false;
}
