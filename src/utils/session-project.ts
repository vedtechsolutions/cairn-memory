/**
 * The MCP session's own project identity — projectId(cwd), because every
 * supported client (Claude Code, Codex CLI) launches the MCP server in
 * the workspace it serves. Explicit-read tools use it to bind PRIVATE
 * projects' content to their own sessions (see canReadPrivate): a
 * caller-supplied `project` argument selects scope, but it must not be
 * able to read a private project from outside it.
 *
 * INTEGRATION CONTRACT (not merely an observation): one MCP server
 * process serves ONE workspace. A client that reused a server across
 * workspaces would carry the launch workspace's standing into the next —
 * if that ever appears, standing must move to a per-request signal.
 * Known edges, all fail-closed (deny, never leak): a server launched
 * outside any workspace gets that directory's pseudo-project; a non-git
 * project launched from a subdirectory or symlinked path derives a
 * different id than its hooks do (README documents this for owners).
 *
 * The daemon is deliberately NOT a consumer: hook handlers derive
 * identity from each request's own cwd, which is correct there.
 *
 * Test override is explicit (parallel test files cannot chdir safely);
 * production always derives from cwd at call time.
 */
import { projectId } from './project-id.js';

let overrideForTests: string | null | undefined;
let warnedFailClosed = false;

export function sessionProjectId(): string | null {
  if (overrideForTests !== undefined) return overrideForTests;
  try {
    return projectId(process.cwd());
  } catch (err) {
    // Fail-closed is right (deny private reads), but the OWNER inside
    // their own private project deserves to know WHY nothing came back.
    if (!warnedFailClosed) {
      console.error(`[waykeep] session project could not be derived from cwd (${(err as Error).message}) — private-project content is unavailable to this session`);
      warnedFailClosed = true;
    }
    return null;
  }
}

/** TEST-ONLY. Pass undefined to restore cwd derivation. */
export function setSessionProjectForTests(project: string | null | undefined): void {
  overrideForTests = project;
}
