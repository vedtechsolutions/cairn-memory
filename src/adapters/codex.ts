/**
 * Codex CLI lifecycle registration: install detection, hooks generation
 * (fresh-install shape — `runCodexInit` stays the orchestrator because
 * merge/trust/route-migration need more context than this seam carries),
 * and the rollout tailer as a daemon worker (capture fallback while hooks
 * are untrusted or disabled).
 */
import { existsSync } from 'node:fs';
import type { ClientAdapterLifecycle } from '@cairn/contract';
import { CLIENT_CODEX } from '../constants/clients.js';
import { codexDir, codexHooks } from '../cli/codex-init.js';
import { codexWorkers } from './workers.js';

export const codexLifecycle: ClientAdapterLifecycle = {
  name: CLIENT_CODEX,
  detectInstall: () => existsSync(codexDir()),
  hooksConfig: (relayCommand) => codexHooks(relayCommand),
  daemonWorkers: codexWorkers,
};
