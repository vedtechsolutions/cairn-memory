/**
 * waykeep-contract — the integration contract for Waykeep.
 *
 * Types and constants only, zero dependencies. Everything here is frozen
 * under an additive-stability guarantee: values may be added, never
 * changed or removed within a major version. Unknown-value tolerance is
 * PER VOCABULARY: open sets (memory kinds, client names, sync error
 * codes) require consumers to treat unknown values as valid; the sync
 * command/event vocabularies are CLOSED replication protocol — an
 * unknown record in a pulled stream is a protocol failure that halts
 * the project, never something a replica silently skips (see
 * sync-envelope.ts).
 */

export * from './identity.js';
export * from './clients.js';
export * from './vocabulary.js';
export * from './hook-events.js';
export * from './routes.js';
export * from './memory-paths.js';
export * from './round-trip.js';
export * from './client-adapter.js';
export * from './sync-envelope.js';
