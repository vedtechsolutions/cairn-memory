/**
 * StatusLine handler — context pressure monitoring on the daemon's shared
 * connection (read-only queries only). Pure business logic: no
 * stdin/stdout/process.exit. The arithmetic and queries are shared with the
 * direct-node entry point through shared/statusline-core.ts.
 */
import type { HookDbClient } from '../shared/db-client.js';
import { writeState } from '../shared/state-io.js';
import {
  computeContextState,
  formatStatusLine,
  statusCountsFor,
  type StatusLineInput,
} from '../shared/statusline-core.js';

export type { StatusLineInput } from '../shared/statusline-core.js';

export interface StatusLineResult {
  display: string;
}

export function handleStatusLine(input: StatusLineInput, client: HookDbClient): StatusLineResult {
  const state = computeContextState(input);
  writeState(state);
  return { display: formatStatusLine(state, statusCountsFor(client.db, input.cwd)) };
}
