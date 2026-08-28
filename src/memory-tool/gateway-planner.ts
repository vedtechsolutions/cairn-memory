/**
 * Shared create planner (W4 v3.1 §5) — preflight and execution are ONE
 * code path run inside the SAME immediate write transaction: the trial IS
 * the plan. A token-less write that would merge into or supersede an
 * existing record throws a MARKER error carrying only the record id; the
 * command handler catches it AFTER the outer transaction rolls back and
 * renders the CAS token from the restored store — never from ephemeral
 * in-transaction state (transient revisions, rows the rollback erases).
 *
 * A block that duplicates a record CREATED EARLIER IN THE SAME COMMAND
 * gets a dedicated tokenless error: that record will not exist once the
 * command rolls back, so no token could ever be valid for it.
 *
 * A contradiction FLAG (a `contradicts` edge on the new record) does not
 * mutate any existing record and is allowed.
 */
import type Database from 'better-sqlite3';
import type { LearnableKind } from '../constants/index.js';
import { findById } from '../db/memory-repository/reads.js';
import { create as repoCreate, findSimilar } from '../db/memory-repository/writes.js';
import type { ParsedBlock } from './block-parser.js';
import { canonicalTokenFor } from './cas.js';
import { DuplicateExistingRecordError, ERR, WouldSupersedeError } from './errors.js';
import type { Log, MaterializableCategory } from './materializer.js';
import { CATEGORY_KINDS } from './path-router.js';

export interface PlannedCreate {
  id: string;
  /** Existing record the conflict pass flagged (edge only — allowed). */
  contradictionWith: string | null;
}

/** Create one token-less block as a NEW record. MUST run inside the
 *  caller's write transaction. `createdIds` accumulates ids created by
 *  the CURRENT command so intra-command duplicates are distinguished from
 *  pre-existing records. Throws (→ outer rollback) when the gateway
 *  would merge into or supersede an existing record. */
export function executeCreatePlan(
  db: Database.Database,
  block: ParsedBlock,
  category: MaterializableCategory,
  project: string | null,
  createdIds: Set<string>,
): PlannedCreate {
  const kind = CATEGORY_KINDS[category][0] as LearnableKind;
  // Preflight: the same similarity check the smart-merge gateway uses.
  const similar = findSimilar(db, block.content, project, kind);
  if (similar) {
    if (createdIds.has(similar.id)) {
      throw new Error(ERR.duplicateWithinCommand());
    }
    throw new DuplicateExistingRecordError(similar.id);
  }
  const context = (block.why || block.how)
    ? { why: block.why ?? undefined, how_to_apply: block.how ?? undefined }
    : undefined;
  const result = repoCreate(db, {
    content: block.content,
    kind,
    project,
    tags: block.tags ?? [],
    context,
    skipDedup: true, // preflight above, same transaction
  });
  if (result.supersededId) {
    if (createdIds.has(result.supersededId)) {
      // The retired record was created by THIS command: after rollback it
      // will not exist, so no token could ever be valid for it.
      throw new Error(ERR.supersedeWithinCommand());
    }
    // Conflict detection retired an existing record — that mutates
    // rendered state outside this create's mandate. The outer rollback
    // restores it; the handler renders the token afterwards.
    throw new WouldSupersedeError(result.supersededId);
  }
  createdIds.add(result.id);
  return { id: result.id, contradictionWith: result.contradictionWith ?? null };
}

/** Convert a planner marker caught AFTER the outer rollback into its
 *  final contract error, rendering the CAS token from the RESTORED store.
 *  Returns null for anything that is not a planner marker. */
export function plannerErrorToContract(
  db: Database.Database,
  err: unknown,
  category: MaterializableCategory,
  project: string | null,
  path: string,
  log: Log,
): Error | null {
  const isDuplicate = err instanceof DuplicateExistingRecordError;
  if (!isDuplicate && !(err instanceof WouldSupersedeError)) return null;
  const record = findById(db, err.recordId);
  if (!record) {
    // The restored store has no such record (it should — markers only name
    // pre-command rows). Never emit an unusable raw identity: fail safe.
    return new Error(ERR.conflictTargetMissing(path));
  }
  const token = canonicalTokenFor(db, record, category, project, log);
  return new Error(isDuplicate ? ERR.duplicateOfExisting(token, path) : ERR.wouldSupersede(token, path));
}
