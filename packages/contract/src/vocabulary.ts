/**
 * Memory vocabulary — the enumerations stored in every row and validated
 * on every import. These are frozen: changes are ADDITIVE only, and a
 * consumer must tolerate values it does not know.
 *
 * Deliberately absent: every weight, threshold, and budget. Tuning is
 * internal to the core and never part of the contract.
 */

export const MEMORY_KINDS = ['pitfall', 'decision', 'correction', 'fact', 'task_state', 'user_profile', 'reference', 'pattern', 'goal', 'rule'] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

/** Kinds accepted via explicit learning (task_state is system-managed). */
export const LEARNABLE_KINDS = ['pitfall', 'decision', 'correction', 'fact', 'user_profile', 'reference', 'pattern', 'goal'] as const;
export type LearnableKind = (typeof LEARNABLE_KINDS)[number];

/** Policy records have explicit lifecycle only; maintenance and confidence
 *  feedback never rewrite their authority metadata. */
export const NON_DECAYING_KINDS = ['rule'] as const satisfies readonly MemoryKind[];

export const MEMORY_SOURCES = ['user', 'learned', 'corrected', 'confirmed'] as const;
export type MemorySource = (typeof MEMORY_SOURCES)[number];

/**
 * Source-authority ORDERING, highest first — contract BEHAVIOR: on a
 * dedup merge the higher-authority source wins and is never downgraded
 * (user beats confirmed beats corrected beats learned). The ordering is
 * the contract; any numeric weighting derived from it is internal.
 */
export const SOURCE_AUTHORITY_ORDER = ['user', 'confirmed', 'corrected', 'learned'] as const satisfies readonly MemorySource[];

export const PLAN_STATUSES = ['active', 'completed', 'abandoned'] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

export const STEP_STATUSES = ['done', 'in_progress', 'pending', 'blocked'] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

/** Prompt-intent classification vocabulary. */
export const INTENTS = ['task', 'question', 'correction', 'status'] as const;
export type UserIntent = (typeof INTENTS)[number];

/** Context-pressure modes an agent session moves through. */
export const CONTEXT_MODES = ['normal', 'compact', 'minimal', 'critical'] as const;
export type ContextMode = (typeof CONTEXT_MODES)[number];
