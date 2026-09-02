// ============================================================================
// Waykeep Constants — the single import site for every constant.
//
// The values live in domain modules beside this file; this barrel only
// re-exports them, so the ~139 existing `constants/index.js` import sites
// stay valid and no call site has to know which module owns a value.
// ============================================================================

// Identity-derived names (their own modules — see paths.ts for why the
// accessors are functions rather than constants).
export { ENV, ALL_ENV_NAMES } from './env.js';
export * from './paths.js';
// NOTE: mcp.js is deliberately NOT re-exported here. Its consumers import
// it directly, and adding it would widen this barrel's public surface —
// an API change, which this split is explicitly not.

// --- Memory vocabulary (contract) -------------------------------------------
// The enumerations live in waykeep-contract (they are stored in rows, cross
// the import/sync boundary, and are frozen additively). Re-exported here so
// the codebase's import sites stay stable.
export {
  MEMORY_KINDS, LEARNABLE_KINDS, NON_DECAYING_KINDS,
  MEMORY_SOURCES, SOURCE_AUTHORITY_ORDER,
  PLAN_STATUSES, STEP_STATUSES,
  type MemoryKind, type LearnableKind, type MemorySource,
  type PlanStatus, type StepStatus,
} from 'waykeep-contract';

// --- Domain modules ---------------------------------------------------------
export * from './scoring.js';
export * from './budgets.js';
export * from './limits.js';
export * from './session.js';
export * from './runtime.js';
export * from './version.js';
export * from './domain.js';
export * from './state.js';
export * from './warnings.js';
export * from './workers.js';
export * from './retrieval.js';
export * from './classification.js';
export * from './agents.js';

// --- Embedding model registry (roadmap W2) ----------------------------------

export {
  EMBEDDING_MODELS, DEFAULT_EMBEDDING_MODEL_KEY, type EmbeddingModelConfig,
} from './embedding-models.js';
