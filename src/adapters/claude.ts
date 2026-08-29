/**
 * Claude Code lifecycle registration. Hot-path behavior lives in the
 * adapter registry (hooks/shared/client-adapter.ts); this module carries
 * only install detection and wiring generation.
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ClientAdapterLifecycle } from 'waykeep-contract';
import { CLIENT_CLAUDE } from '../constants/clients.js';
import { cairnHooks } from '../cli/init.js';

export const claudeLifecycle: ClientAdapterLifecycle = {
  name: CLIENT_CLAUDE,
  detectInstall: () => existsSync(join(homedir(), '.claude')),
  hooksConfig: (relayCommand) => cairnHooks(relayCommand),
  // No daemon workers: Claude's hooks engine delivers every capture event
  // directly, so no state tailer is needed.
  daemonWorkers: [],
};
