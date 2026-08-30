import type Database from 'better-sqlite3';
import { SHAREABLE_KINDS, isShareState } from 'waykeep-contract';

import type { CairnConfigSnapshot } from '../config/cairn-config.js';

/**
 * Shared fail-closed sync-eligibility predicate (brief D8 item 6, D10's
 * worker enqueue/transmit checkpoint). Core stays ENROLLMENT-IGNORANT:
 * enrollment, consent, and owner policy arrive as CALLER-SUPPLIED input
 * — the paid worker supplies real values, the free bounded paths supply
 * their own. Every uncertain input answers INELIGIBLE with a named
 * reason: privacy failing open is the one unacceptable outcome (D10 is
 * a release blocker).
 *
 * The row-side inputs mirror journal admission (shareable kind, exact
 * non-null project) plus share_state policy (D7): 'local' = opt-out;
 * NULL and 'team' are candidates — NULL is worker POLICY, never a
 * column default.
 *
 * ANCHOR rule (D7, corrected per review C3): the capture-time
 * force-to-'local' for unresolvable anchors is NOT implemented yet —
 * until it is, THIS predicate enforces the rule row-locally: an anchor
 * carrying an absolute path is machine-local by construction (it cannot
 * be relativized to any repo root) and fails closed. Full
 * symlink/worktree relativization belongs at capture and remains open
 * work — tracked, not assumed.
 *
 * Outbound SCRUB (D10's remaining item) is a transmit-time TRANSFORM,
 * not a predicate clause — the worker scrubs bytes it sends; this
 * predicate decides whether a row may be considered at all.
 */

export interface EligibilityContext {
  /** The caller's target project binding — exact, non-null. */
  project: string;
  /** Caller-supplied: the project is enrolled with a server binding. */
  enrolled: boolean;
  /** Caller-supplied: enrollment consent is sealed (J9 fence exists). */
  consentSealed: boolean;
  /** ONE config snapshot from cairnConfigSnapshot() — health and the
   *  privacy policy provably derive from the SAME bytes. The previous
   *  two-field shape (a health boolean beside a privateProjects set)
   *  made the H5 race EXPRESSIBLE through this very interface, and the
   *  doc steered callers into it (review N1). Take a fresh snapshot at
   *  transmit. */
  config: Pick<CairnConfigSnapshot, 'config' | 'health'>;
  /** Owner policy mirror (A1): a SUBSET of the frozen allowlist, or
   *  undefined for the full v1 allowlist. Never a superset — extra
   *  kinds are ignored by intersection, not honored. */
  ownerAllowedKinds?: readonly string[];
}

export interface EligibilityRow {
  kind: string;
  project: string | null;
  share_state: string | null;
  /** The row's anchor JSON as stored, when present. */
  anchor?: string | null;
}

/** A file entry is machine-local or root-escaping when it is absolute
 *  (POSIX, drive-letter, UNC), home-relative, or climbs out via `..` —
 *  none can relativize to a repo root, so none may travel (D7 / review
 *  N3b). NOTE (reviewer calibration): anchor extraction routinely
 *  captures absolute paths from ordinary content, so this clause has a
 *  real recall cost — which argues for prioritizing capture-time
 *  relativization, not for weakening the clause. */
function fileUnresolvable(f: unknown): boolean {
  if (typeof f !== 'string' || f.length === 0) return true;
  if (f.startsWith('/') || f.startsWith('\\\\') || f.startsWith('~')) return true;
  if (/^[A-Za-z]:[\\/]/.test(f)) return true;
  return f.split(/[\\/]/).includes('..');
}

/** Unknown never travels (review N3a): only a well-formed
 *  `{files: string[]}` whose every entry is a clean relative path is
 *  resolvable — non-object anchors, missing/non-array `files`,
 *  non-string entries, and unparseable JSON all fail closed. */
function anchorUnresolvable(anchor: string | null | undefined): boolean {
  if (anchor === null || anchor === undefined) return false;
  try {
    const parsed = JSON.parse(anchor) as { files?: unknown };
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return true;
    if (!Array.isArray(parsed.files)) return true;
    return parsed.files.some(fileUnresolvable);
  } catch {
    return true;
  }
}

export type IneligibleReason =
  | 'config-unhealthy' | 'project-private' | 'not-enrolled' | 'consent-not-sealed'
  | 'project-mismatch' | 'kind-not-shareable' | 'kind-owner-excluded' | 'opted-out'
  | 'anchor-unresolvable' | 'share-state-invalid' | 'policy-invalid'
  | 'scrub-not-verified' | 'anchor-not-relativized';

/** Fail-closed: the FIRST failing checkpoint names the reason. */
export function syncEligibility(row: EligibilityRow, ctx: EligibilityContext): { eligible: boolean; reason: IneligibleReason | null } {
  if (!ctx.config.health.healthy) return { eligible: false, reason: 'config-unhealthy' };
  if (ctx.config.config.scope.privateProjects.has(ctx.project)) return { eligible: false, reason: 'project-private' };
  if (!ctx.enrolled) return { eligible: false, reason: 'not-enrolled' };
  if (!ctx.consentSealed) return { eligible: false, reason: 'consent-not-sealed' };
  if (row.project === null || row.project !== ctx.project) return { eligible: false, reason: 'project-mismatch' };
  if (!(SHAREABLE_KINDS as readonly string[]).includes(row.kind)) return { eligible: false, reason: 'kind-not-shareable' };
  if (ctx.ownerAllowedKinds !== undefined) {
    // A malformed policy mirror is INVALID, never best-effort filtered
    // (Codex H2 / review N2): the CONTAINER and its elements are both
    // untrusted runtime data — a non-array throws in .some, and an
    // unnamed throw would crash a worker enqueue loop instead of
    // returning the typed refusal.
    if (!Array.isArray(ctx.ownerAllowedKinds) || ctx.ownerAllowedKinds.some((k) => typeof k !== 'string')) {
      return { eligible: false, reason: 'policy-invalid' };
    }
    const allowed = ctx.ownerAllowedKinds.filter((k) => (SHAREABLE_KINDS as readonly string[]).includes(k));
    if (!allowed.includes(row.kind)) return { eligible: false, reason: 'kind-owner-excluded' };
  }
  // STRICT tri-state (Codex H1): only null | 'local' | 'team' exist.
  // Any other value — '', 'bogus', a number from stale/malformed data —
  // is unknown state, and unknown never uploads.
  if (row.share_state !== null && !isShareState(row.share_state)) {
    return { eligible: false, reason: 'share-state-invalid' };
  }
  if (row.share_state === 'local') return { eligible: false, reason: 'opted-out' };
  if (anchorUnresolvable(row.anchor)) return { eligible: false, reason: 'anchor-unresolvable' };
  return { eligible: true, reason: null };
}

/** The worker's TRANSMIT-time assertions — checkpoints the row/scope
 *  predicate cannot verify itself (D10's remaining items). The caller
 *  asserts each as a boolean it has PROVEN, and every unproven
 *  assertion fails closed. */
export interface TransmitAssertions {
  /** Outbound scrub ran over the exact bytes being sent. */
  scrubCompleted: boolean;
  /** The row's anchor was relativized against the symlink-resolved repo
   *  root (worktrees against their own root) at transmit time. Rows
   *  with no anchor pass trivially — the caller asserts true. */
  anchorRelativized: boolean;
}

/**
 * The COMPLETE D10 worker predicate (Codex H2): syncEligibility is the
 * enqueue-half (row + scope + policy); this composition adds the
 * transmit-time checkpoints. Only THIS function's true result may be
 * treated as full D10 eligibility.
 */
export function transmitEligibility(
  row: EligibilityRow,
  ctx: EligibilityContext,
  assertions: TransmitAssertions,
): { eligible: boolean; reason: IneligibleReason | null } {
  const base = syncEligibility(row, ctx);
  if (!base.eligible) return base;
  // STRICT booleans (Codex delta): an assertion is PROVEN only by the
  // literal true — a truthy 'yes' or 1 from a sloppy caller is an
  // unproven claim, and unproven fails closed.
  if (assertions.scrubCompleted !== true) return { eligible: false, reason: 'scrub-not-verified' };
  if (assertions.anchorRelativized !== true) return { eligible: false, reason: 'anchor-not-relativized' };
  return { eligible: true, reason: null };
}

export interface EligibleRowSummary {
  id: string;
  kind: string;
  share_state: string | null;
  anchor: string | null;
  revision: number;
}

/**
 * The EXACT-project selector (D8 item 6): `project = ?` and nothing
 * else — NEVER the project-OR-global export selector, which would leak
 * global rows into a team scope. Returns active rows only; the caller
 * runs syncEligibility per row (the selector narrows, the predicate
 * decides).
 */
export function selectProjectRows(db: Database.Database, project: string): EligibleRowSummary[] {
  return db.prepare(`
    SELECT id, kind, share_state, anchor, revision FROM memories
    WHERE project = ? AND invalidated = 0 AND superseded_by IS NULL
    ORDER BY id
  `).all(project) as EligibleRowSummary[];
}
