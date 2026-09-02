/**
 * Compile-only SDK assignability canary (W4 v3.1 §10). The exact-pinned
 * `@anthropic-ai/sdk` devDependency's `MemoryToolHandlers` type must
 * accept our locally-typed handler object; a shape drift in an SDK
 * upgrade fails the normal tsc build here, BEFORE any behavioral test
 * runs. Type-level only — nothing here executes or imports at runtime.
 */
import type { MemoryToolHandlers } from '@anthropic-ai/sdk/helpers/beta/memory';
import type { WaykeepMemoryToolHandlers } from './sdk-adapter.js';

type IsAssignable<A, B> = A extends B ? true : false;

/** Fails to compile (`false` not assignable to `true`) on SDK drift. */
export const SDK_MEMORY_TOOL_CANARY: IsAssignable<WaykeepMemoryToolHandlers, MemoryToolHandlers> = true;
