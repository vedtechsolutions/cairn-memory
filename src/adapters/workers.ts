/**
 * Adapter daemon workers — the DAEMON-facing half of the lifecycle
 * registry. Split from the full lifecycles (index.ts) so the daemon can
 * start workers without importing any installer code (cli/init,
 * cli/codex-init, cli/relay): those modules are side-effect free today,
 * but the daemon's import graph should not depend on that staying true.
 */
import { startRolloutTailer } from '../daemon/rollout-tailer.js';
import type { CachedHookContext } from '../hooks/shared/db-client.js';
import { CLIENT_CLAUDE, CLIENT_CODEX } from '../constants/clients.js';

export type AdapterWorker = (context: unknown) => { stop(): void };

export interface AdapterWorkerSet {
  readonly name: string;
  readonly workers: ReadonlyArray<AdapterWorker>;
}

/** Codex: the rollout tailer — capture fallback while hooks are
 *  untrusted or disabled; quiescent when hooks are live (seen-marker
 *  dedup). Claude needs no workers: its hooks engine delivers every
 *  capture event directly. */
export const codexWorkers: ReadonlyArray<AdapterWorker> = [
  (context) => startRolloutTailer(context as CachedHookContext),
];

export const ADAPTER_WORKERS: readonly AdapterWorkerSet[] = [
  { name: CLIENT_CLAUDE, workers: [] },
  { name: CLIENT_CODEX, workers: codexWorkers },
];
