/**
 * The MCP session's own project identity — projectId(cwd), because every
 * supported client (Claude Code, Codex CLI) launches the MCP server in
 * the workspace it serves. Explicit-read tools use it to bind PRIVATE
 * projects' content to their own sessions (see canReadPrivate): a
 * caller-supplied `project` argument selects scope, but it must not be
 * able to read a private project from outside it.
 *
 * Test override is explicit (parallel test files cannot chdir safely);
 * production always derives from cwd at call time.
 */
import { projectId } from './project-id.js';

let overrideForTests: string | null | undefined;

export function sessionProjectId(): string | null {
  if (overrideForTests !== undefined) return overrideForTests;
  try {
    return projectId(process.cwd());
  } catch {
    return null;
  }
}

/** TEST-ONLY. Pass undefined to restore cwd derivation. */
export function setSessionProjectForTests(project: string | null | undefined): void {
  overrideForTests = project;
}
