/**
 * PostCompact handler — records compaction metadata.
 * Pure business logic: no stdin/stdout/process.exit.
 *
 * GAP B: when a CachedHookContext is provided, prefer the in-memory tracker
 * from SessionCache. Writing the file directly under the standalone path
 * would clobber mutations that prompt-check / pitfall-check made to the
 * cached tracker earlier in the same turn, or (symmetrically) be clobbered
 * itself when the 60-second flush lands. Cache-through keeps both views
 * coherent.
 */
import type { PostCompactInput } from '../shared/hook-io.js';
import type { CachedHookContext } from '../shared/db-client.js';
import { loadTracker, saveTracker } from '../shared/edit-tracker.js';

export interface PostCompactResult {
  tokensSaved: number;
}

export function handlePostCompact(
  input: PostCompactInput,
  client?: CachedHookContext,
): PostCompactResult {
  const tracker = client?.cache?.getTracker(input.session_id) ?? loadTracker(input.session_id);
  tracker.lastCompactAt = Date.now();
  tracker.lastCompactSessionId = input.session_id;
  tracker.lastCompactTokensSaved = input.tokens_saved ?? 0;

  if (client?.cache) {
    client.cache.setTracker(input.session_id, tracker);
  } else {
    saveTracker(tracker, input.session_id);
  }

  return { tokensSaved: tracker.lastCompactTokensSaved };
}
