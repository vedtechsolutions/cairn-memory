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
 * column default. The anchor rule needs no clause here: unresolvable
 * anchors are forced share_state='local' at capture (D7 fail-closed),
 * so one field drives all exclusion.
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
}

export type IneligibleReason =
  | 'config-unhealthy' | 'project-private' | 'not-enrolled' | 'consent-not-sealed'
  | 'project-mismatch' | 'kind-not-shareable' | 'kind-owner-excluded' | 'opted-out';

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
  return { eligible: true, reason: null };
}

export interface EligibleRowSummary {
  id: string;
  kind: string;
  share_state: string | null;
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
    SELECT id, kind, share_state, revision FROM memories
    WHERE project = ? AND invalidated = 0 AND superseded_by IS NULL
    ORDER BY id
  `).all(project) as EligibleRowSummary[];
}
