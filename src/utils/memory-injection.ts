import type { Memory } from '../db/memory-repository.js';

/**
 * Explicit retirement markers accepted at the start of pitfall content.
 *
 * Keep this anchored: prose such as "the issue is resolved by retrying"
 * can still be a useful lesson. These forms mean the memory itself has been
 * marked resolved and must no longer enter agent context.
 */
const RESOLVED_PITFALL_MARKER = /^\s*(?:[-*]\s*)?(?:resolved\b|status\s*:\s*resolved\b|\[(?:status\s*:\s*)?resolved\])/i;

export function isResolvedPitfallContent(content: string): boolean {
  return RESOLVED_PITFALL_MARKER.test(content);
}

/** Shared defense for every automatic context-injection surface. */
export function isMemoryEligibleForInjection(
  memory: Pick<Memory, 'kind' | 'content' | 'invalidated' | 'superseded_by'>,
): boolean {
  if (memory.invalidated !== 0 || memory.superseded_by) return false;
  return memory.kind !== 'pitfall' || !isResolvedPitfallContent(memory.content);
}
