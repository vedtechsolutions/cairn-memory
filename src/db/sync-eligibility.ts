import type Database from 'better-sqlite3';
import { SHAREABLE_KINDS } from 'waykeep-contract';

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
  /** From cairnConfigHealth().healthy — an unhealthy config disables sync. */
  configHealthy: boolean;
  /** From the scope config — private-deny overrides enrollment. */
  privateProjects: ReadonlySet<string>;
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

/** An anchor referencing an ABSOLUTE path is machine-local: it cannot
 *  relativize to any repo root, so it must never travel (D7). Malformed
 *  anchor JSON also fails closed — unknown is not shareable. */
function anchorUnresolvable(anchor: string | null | undefined): boolean {
  if (anchor === null || anchor === undefined) return false;
  try {
    const parsed = JSON.parse(anchor) as { files?: unknown };
    if (!Array.isArray(parsed.files)) return false;
    return parsed.files.some((f) => typeof f === 'string' && (f.startsWith('/') || /^[A-Za-z]:[\\/]/.test(f)));
  } catch {
    return true;
  }
}

export type IneligibleReason =
  | 'config-unhealthy' | 'project-private' | 'not-enrolled' | 'consent-not-sealed'
  | 'project-mismatch' | 'kind-not-shareable' | 'kind-owner-excluded' | 'opted-out'
  | 'anchor-unresolvable';

/** Fail-closed: the FIRST failing checkpoint names the reason. */
export function syncEligibility(row: EligibilityRow, ctx: EligibilityContext): { eligible: boolean; reason: IneligibleReason | null } {
  if (!ctx.configHealthy) return { eligible: false, reason: 'config-unhealthy' };
  if (ctx.privateProjects.has(ctx.project)) return { eligible: false, reason: 'project-private' };
  if (!ctx.enrolled) return { eligible: false, reason: 'not-enrolled' };
  if (!ctx.consentSealed) return { eligible: false, reason: 'consent-not-sealed' };
  if (row.project === null || row.project !== ctx.project) return { eligible: false, reason: 'project-mismatch' };
  if (!(SHAREABLE_KINDS as readonly string[]).includes(row.kind)) return { eligible: false, reason: 'kind-not-shareable' };
  if (ctx.ownerAllowedKinds !== undefined) {
    const allowed = ctx.ownerAllowedKinds.filter((k) => (SHAREABLE_KINDS as readonly string[]).includes(k));
    if (!allowed.includes(row.kind)) return { eligible: false, reason: 'kind-owner-excluded' };
  }
  if (row.share_state === 'local') return { eligible: false, reason: 'opted-out' };
  if (anchorUnresolvable(row.anchor)) return { eligible: false, reason: 'anchor-unresolvable' };
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
