export { applyEventBatch, type ApplyBatchResult, type EventOutcome } from './apply.js';
export { ApplyValidationError, ProtocolInvariantError } from './errors.js';
export {
  readGeneration, bumpGeneration, getByEntityId, getByLocalMemoryId,
  deterministicConflictSetId, contributorsOf,
} from './entity-map.js';
export {
  projectPayload, projectionHashOfPayload, projectionHashOfRow,
  canonicalRowBytes, hashCanonical, type ProjectionFields,
} from './projection.js';
