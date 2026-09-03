/**
 * Worktree digest — the public surface. The v1 synchronous reader, the v2
 * concurrent reader and their shared primitives live in the sibling
 * worktree-digest-* modules; every name this module ever exported is
 * re-exported here so no import path changes.
 */
export {
  WORKTREE_DIGEST_V1_VERSION, WORKTREE_DIGEST_VERSION, WORKTREE_DIGEST_V2_VERSION, WORKTREE_DIGEST_HARD_CEILING_MS,
  type WorktreeDigestOptions, type WorktreeDigestResult, type WorktreeDigestV2Options, type WorktreeDigestV2Result,
} from './worktree-digest-shared.js';
export { captureWorktreeDigest } from './worktree-digest-v1.js';
export { captureWorktreeDigestV2 } from './worktree-digest-v2.js';
