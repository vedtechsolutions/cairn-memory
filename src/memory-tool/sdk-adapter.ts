/**
 * SDK-facing memory-tool handlers (W4 v3.1 §9/§10) — LOCAL structural
 * command types (zero runtime SDK dependency) shaped to be assignable to
 * the pinned SDK's `MemoryToolHandlers` (proven compile-time by
 * sdk-canary.ts and behaviorally by the §9 test layers). Handlers RETURN
 * contract strings; errors are THROWN without an `Error: ` prefix — the
 * SDK runner wraps them into the `is_error` tool_result and adds its own
 * prefix, so pre-prefixed messages would render as `Error: Error: …`.
 */
import { MemoryCommandHandlers, type HandlerDeps } from './command-handlers.js';
import { ERR } from './errors.js';

export interface ViewCommand { command: 'view'; path: string; view_range?: number[] }
export interface CreateCommand { command: 'create'; path: string; file_text: string }
export interface StrReplaceCommand { command: 'str_replace'; path: string; old_str: string; new_str: string }
export interface InsertCommand { command: 'insert'; path: string; insert_line: number; insert_text: string }
export interface DeleteCommand { command: 'delete'; path: string }
export interface RenameCommand { command: 'rename'; old_path: string; new_path: string }

export interface CairnMemoryToolHandlers {
  view(cmd: ViewCommand): string;
  create(cmd: CreateCommand): string;
  str_replace(cmd: StrReplaceCommand): string;
  insert(cmd: InsertCommand): string;
  delete(cmd: DeleteCommand): string;
  rename(cmd: RenameCommand): string;
}

/** The SDK sends `view_range` as an unconstrained number array — anything
 *  but exactly two safe integers is a shape error, reported before any
 *  path work. */
function toViewRange(raw: number[] | undefined): [number, number] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.length !== 2 || !raw.every(n => Number.isSafeInteger(n))) {
    throw new Error(ERR.invalidViewRangeShape(raw));
  }
  return [raw[0], raw[1]];
}

/** Build the handler object `betaMemoryTool(...)` consumes. */
export function createMemoryToolHandlers(deps: HandlerDeps): CairnMemoryToolHandlers {
  const h = new MemoryCommandHandlers(deps);
  return {
    view: (cmd) => h.view(cmd.path, toViewRange(cmd.view_range)),
    create: (cmd) => h.create(cmd.path, cmd.file_text),
    str_replace: (cmd) => h.strReplace(cmd.path, cmd.old_str, cmd.new_str),
    insert: (cmd) => h.insert(cmd.path, cmd.insert_line, cmd.insert_text),
    delete: (cmd) => h.delete(cmd.path),
    rename: (cmd) => h.rename(cmd.old_path, cmd.new_path),
  };
}
