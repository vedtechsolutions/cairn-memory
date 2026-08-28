/**
 * Contract error table (W4 v3.1 §9) — the ONE mapping from every contract
 * case to its thrown message. Modules throw `new Error(ERR.case(...))`;
 * no contract-visible message text lives anywhere else. Messages carry no
 * `Error: ` prefix — the SDK runner supplies it.
 *
 * The marker classes carry a record id OUT of a rolled-back transaction:
 * the command handler catches them AFTER the outer rollback and only then
 * renders the CAS token, so reported prefixes and revisions always
 * describe the restored store — never an ephemeral in-transaction state.
 */

export const ERR = {
  // path-router
  invalidPath: (path: string, root: string): string =>
    `invalid path ${path} — memory paths must stay within ${root}`,

  // block-parser
  malformedBlock: (detail: string): string =>
    `malformed record block: ${detail}. Edit whole records using the rendered block grammar ([kind:id@rev] token line + why/how/tags continuation lines with one-line JSON values).`,
  confidenceImmutable: (): string => 'confidence is system-managed and cannot be edited',

  // cas
  tokenWrongFile: (token: string, path: string): string => `token ${token} does not belong in ${path}`,
  tokenNoMatch: (token: string, path: string): string =>
    `no record matches token ${token} in ${path} — view the file for current tokens`,
  tokenAmbiguous: (prefix: string, path: string): string =>
    `token prefix ${prefix} is ambiguous in ${path} — view the file and use the longer token shown`,
  tokenStale: (token: string, revision: number, path: string): string =>
    `stale record ${token} — its current revision is ${revision}. View ${path} again before editing.`,
  oldBlockNotCanonical: (token: string, path: string): string =>
    `old_str block for ${token} does not match the rendered record exactly — view ${path} and copy the whole block verbatim`,
  oldBlockDuplicate: (token: string): string =>
    `old_str lists record ${token} more than once — include each record at most once`,

  // gateway planner (tokens rendered POST-rollback by the handler)
  duplicateOfExisting: (token: string, path: string): string =>
    `this content matches existing record ${token} — view ${path} and edit that record instead of creating a duplicate.`,
  duplicateWithinCommand: (): string =>
    'this block duplicates another new block in the same command — merge them into one record',
  supersedeWithinCommand: (): string =>
    'these new blocks supersede one another — submit one final record',
  wouldSupersede: (token: string, path: string): string =>
    `this content would supersede existing record ${token} — view ${path} and edit that record instead.`,
  conflictTargetMissing: (path: string): string =>
    `this write conflicts with a record that could not be re-read after rollback — view ${path} and retry the edit.`,

  // record-updater
  updateFailed: (id: string): string => `record ${id} could not be updated — view the file again before editing`,

  // free-form store
  fileTooLarge: (): string => 'file exceeds the 64KB memory-file limit',
  storeFullFiles: (): string => 'memory store is full (256 files)',
  storeFullBytes: (): string => 'memory store is full (16MB aggregate limit)',
  oldStrNotFound: (oldStr: string, path: string): string =>
    `No replacement was performed, old_str \`${oldStr}\` did not appear verbatim in ${path}.`,
  oldStrMultiple: (oldStr: string, lineNumbers: string): string =>
    `No replacement was performed. Multiple occurrences of old_str \`${oldStr}\` in lines: ${lineNumbers}. Please ensure it is unique`,

  // view renderer
  lineLimitExceeded: (path: string): string => `File ${path} exceeds maximum line limit of 999,999 lines.`,
  invalidViewRange: (a: number, b: number, lineCount: number): string =>
    `Invalid \`view_range\` parameter: [${a}, ${b}]. It should be within the range of lines of the file: [1, ${lineCount}]`,
  invalidViewRangeShape: (raw: unknown): string =>
    `Invalid \`view_range\` parameter: ${JSON.stringify(raw)}. It should be an array of two integers.`,
  invalidInsertLine: (line: number, lineCount: number): string =>
    `Invalid \`insert_line\` parameter: ${line}. It should be within the range of lines of the file: [0, ${lineCount}]`,

  // command handlers
  nonexistent: (path: string): string => `The path ${path} does not exist. Please provide a valid path.`,
  isDirectory: (path: string): string => `The path ${path} is a directory`,
  alreadyExists: (path: string): string => `File ${path} already exists`,
  readOnlyPlan: (path: string): string => `${path} is read-only — manage the plan via the cairn_plan tool`,
  createTokenless: (): string => 'create takes token-less blocks only — tokened blocks belong to str_replace edits',
  insertTokenless: (): string => 'insert takes token-less blocks only — edit existing records with str_replace',
  oldStrMustBeTokened: (): string => 'old_str must contain only rendered (tokened) record blocks',
  newTokenMismatch: (token: string): string =>
    `new_str token ${token} does not match any old_str token exactly (kind, id, and old revision must all match)`,
  newTokenDuplicate: (token: string): string =>
    `new_str lists record ${token} more than once — include each record at most once`,
  cannotDeleteRoot: (root: string): string => `cannot delete the ${root} directory itself`,
  cannotRenameRoot: (root: string): string => `cannot rename the ${root} directory itself`,
  destinationExists: (path: string): string => `The destination ${path} already exists`,
  crossCategoryRename: (): string => 'cannot rename across memory categories — kind changes are delete + create',
  crossDomainRename: (): string =>
    'cannot rename across memory domains (free-form vs materialized) — kind changes are delete + create',
  dirContainsPlan: (dir: string): string => `${dir} contains read-only plan.md`,
} as const;

/** A token-less create matched an existing (pre-command) record. The
 *  handler renders the token after the outer transaction rolls back. */
export class DuplicateExistingRecordError extends Error {
  constructor(public readonly recordId: string) {
    super(`duplicate of existing record ${recordId}`);
  }
}

/** A token-less create would retire an existing record via supersession.
 *  The handler renders the token after the outer transaction rolls back. */
export class WouldSupersedeError extends Error {
  constructor(public readonly recordId: string) {
    super(`would supersede record ${recordId}`);
  }
}
