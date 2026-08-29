/**
 * Adapter lifecycle registry — the install/daemon side of the extension
 * seam (the hot-path side is hooks/shared/client-adapter.ts). Adding an
 * agent's installer or daemon worker means registering its lifecycle
 * here; the daemon and CLI iterate this list, never name a client.
 */
import type { ClientAdapterLifecycle } from 'waykeep-contract';
import { claudeLifecycle } from './claude.js';
import { codexLifecycle } from './codex.js';

export const ADAPTER_LIFECYCLES: readonly ClientAdapterLifecycle[] = [
  claudeLifecycle,
  codexLifecycle,
];
