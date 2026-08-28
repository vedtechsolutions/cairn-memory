/**
 * Shared types for the prompt-check handler modules.
 *
 * PromptCtx bundles the mutable per-call state that the original monolithic
 * handler kept in closures (the token budget, the injection accumulators,
 * the tracker). Passing one context object to each phase preserves the exact
 * shared-mutation semantics — every phase pushes into the same `output` and
 * `newlyInjected` arrays and spends from the same budget.
 */
import type { UserPromptSubmitInput } from '../../shared/hook-io.js';
import type { CachedHookContext } from '../../shared/db-client.js';
import type { EditTracker } from '../../shared/edit-tracker.js';
import type { ContextFingerprint } from '../../../utils/fingerprint.js';
import type { ContextMode } from '../../../constants/index.js';

export interface PromptCheckResult {
  /** Raw text output (lines joined by \n), or null for no output */
  output: string | null;
  /** Intent classification for telemetry */
  intent: string;
  /** Number of injections for telemetry */
  injections: number;
}

/** Per-call mutable context shared across prompt-check phases. */
export interface PromptCtx {
  client: CachedHookContext;
  input: UserPromptSubmitInput;
  prompt: string;
  project: string;
  fp: ContextFingerprint;
  intent: string;
  mode: ContextMode;
  /** Loaded tracker — phases mutate it; the facade persists it once at the end. */
  tracker: EditTracker;
  /** Output line accumulator (joined with \n by the facade). */
  output: string[];
  /** Memory IDs injected in prior turns (session dedup). */
  previouslyInjected: Set<string>;
  /** Memory IDs injected this turn. */
  newlyInjected: string[];
  /** True while the per-turn token budget has room. */
  budgetAvailable: () => boolean;
  /** Append a line if it fits the per-turn token budget; returns whether it fit. */
  budgetPush: (line: string) => boolean;
}
