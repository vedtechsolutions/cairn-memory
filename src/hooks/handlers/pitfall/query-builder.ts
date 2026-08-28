/**
 * Query fingerprint + query text construction for pitfall recall.
 */
import type { PreToolUseInput } from '../../shared/hook-io.js';
import type { CachedHookContext } from '../../shared/db-client.js';
import { buildQueryFingerprint, branchSignalTokens } from '../../../utils/fingerprint.js';
import type { ContextFingerprint } from '../../../utils/fingerprint.js';
import { getGitHash, getGitWorkingState } from '../../../utils/project-scanner.js';
import { extractCodeContent } from './input-extract.js';

/** Build the context fingerprint + FTS query text for the current tool call. */
export function buildPitfallQuery(
  input: PreToolUseInput,
  client: CachedHookContext,
  project: string,
  filePath: string | undefined,
  command: string | undefined,
): { queryFp: ContextFingerprint; queryText: string } {
  // Load cached project context for fingerprint generation
  let projectContext = null;
  try {
    // Use cached git hash if available (eliminates subprocess spawn)
    const cachedGit = client.cache?.getGitState(input.cwd);
    const gitHash = cachedGit?.hash ?? getGitHash(input.cwd);
    if (!cachedGit && client.cache) {
      // Cache the result for subsequent calls
      client.cache.setGitState(input.cwd, gitHash, null);
    }
    // Project context is keyed by (project, gitHash) and is immutable per that
    // pair, so in-memory caching is safe. Checking the cache first avoids a DB
    // round-trip on every hook call that shares the same git hash.
    if (gitHash && client.cache) {
      projectContext = client.cache.getProjectContext(project, gitHash);
    }
    if (!projectContext && gitHash) {
      projectContext = client.contextRepo.get(project, gitHash);
      if (projectContext && client.cache) {
        client.cache.setProjectContext(project, gitHash, projectContext);
      }
    }
    if (!projectContext) projectContext = client.contextRepo.getLatest(project);
  } catch { /* best-effort */ }

  // Build query fingerprint from current context
  const queryFp = buildQueryFingerprint({ projectContext, filePath, command });

  // Branch-aware prediction: inject git branch tokens
  try {
    const cachedGit = client.cache?.getGitState(input.cwd);
    let branch = cachedGit?.branch;
    if (branch === undefined) {
      const gitState = getGitWorkingState(input.cwd);
      branch = gitState?.branch ?? null;
      if (client.cache) {
        const hash = cachedGit?.hash ?? null;
        client.cache.setGitState(input.cwd, hash, branch);
      }
    }
    if (branch) {
      const branchTokens = branchSignalTokens(branch);
      queryFp.module.push(...branchTokens);
    }
  } catch { /* best-effort */ }

  // Build query text — content-aware
  const codeContent = extractCodeContent(input);
  const queryParts = [filePath, command, codeContent].filter(Boolean);
  const queryText = queryParts.join(' ');

  return { queryFp, queryText };
}
